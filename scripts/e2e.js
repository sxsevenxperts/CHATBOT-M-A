#!/usr/bin/env node
/**
 * Teste end-to-end do fluxo de triagem.
 *
 * Sobe uma Evolution API FALSA e roda o app apontado para ela — nenhuma
 * mensagem real de WhatsApp é enviada. O Supabase é o de verdade, e as
 * linhas de teste são apagadas no final.
 *
 * O formato do payload do webhook aqui é o mesmo que a Evolution v2 envia
 * de verdade (data.key.remoteJid / data.message.conversation).
 *
 *   node scripts/e2e.js
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const MOCK_PORT = 4010;
const APP_PORT = 4011;
const PHONE = '5588000000091';          // número fictício
const JID = `${PHONE}@s.whatsapp.net`;

const sent = [];                         // mensagens que o app tentou enviar
let pass = 0, fail = 0;

const ok = m => { console.log(`  \x1b[32m✔\x1b[0m ${m}`); pass++; };
const no = (m, extra) => { console.log(`  \x1b[31m✖\x1b[0m ${m}`); if (extra) console.log(`     ${extra}`); fail++; };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ---------------- Evolution falsa ---------------- */
const mock = express();
mock.use(express.json());

mock.get('/', (_q, r) => r.json({ version: '2.3.7-mock', message: 'mock' }));

mock.get('/instance/fetchInstances', (_q, r) => r.json([{
  name: '3041', connectionStatus: 'open',
  ownerJid: '558881553041@s.whatsapp.net', profileName: 'SX (mock)'
}]));

const presences = [];                    // chamadas de "digitando…"
mock.post('/chat/sendPresence/:instance', (q, r) => {
  presences.push({ number: q.body.number, presence: q.body.presence });
  r.json({ ok: true });
});

mock.post('/message/sendText/:instance', (q, r) => {
  sent.push({ number: q.body.number, text: q.body.text, at: Date.now() });
  console.log(`  \x1b[90m↗ mock enviaria → ${q.body.number}: ${String(q.body.text).split('\n')[0].slice(0, 62)}…\x1b[0m`);
  r.json({ key: { id: 'MOCK' + sent.length } });
});

mock.get('/webhook/find/:instance', (_q, r) => r.json({
  enabled: true, url: `http://localhost:${APP_PORT}/webhook/messages`, events: ['MESSAGES_UPSERT']
}));
mock.post('/webhook/set/:instance', (q, r) => r.json({ ...q.body.webhook }));

const mockServer = mock.listen(MOCK_PORT);

/* ---------------- App sob teste ---------------- */
const app = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    EVOLUTION_API_URL: `http://localhost:${MOCK_PORT}`,
    PORT: String(APP_PORT),
    ALT_PORT: String(APP_PORT),          // igual ao PORT → não abre segunda porta
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    REPLY_DELAY_MIN_MS: '300',           // produção usa 3000–5000
    REPLY_DELAY_MAX_MS: '400',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let appLog = '';
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${APP_PORT}/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

/** Payload idêntico ao MESSAGES_UPSERT real da Evolution v2. */
async function incoming(text, { fromMe = false, jid = JID, id = null, pushName = 'Sérgio Ponte' } = {}) {
  const res = await fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'messages.upsert',
      instance: '3041',
      data: {
        key: { remoteJid: jid, fromMe, id: id || 'MSG' + Math.random().toString(36).slice(2, 10) },
        pushName,
        message: { conversation: text },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    })
  });
  await sleep(1000);
  return res;
}

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

async function cleanup() {
  await sb.from('triages').delete().eq('phone', PHONE);
  await sb.from('bot_sessions').delete().eq('phone', PHONE);
  await sb.from('messages').delete().eq('phone', PHONE);
}

/* ---------------- Bateria ---------------- */
try {
  console.log('\n\x1b[1m═══ E2E · fluxo de triagem M & A ═══\x1b[0m');

  if (!await waitUp()) {
    console.error('\nApp não subiu. Log:\n' + appLog);
    process.exit(1);
  }
  await cleanup();

  /* --- 0. Regressão: .env sozinho basta --- */
  head('0 · Config vem do .env mesmo sem variáveis herdadas');
  // Em ESM os imports são avaliados antes do dotenv.config() do index.js.
  // Este teste trava a regressão que fazia ADMIN_PASSWORD/TIMEZONE/REARM_HOURS
  // do .env serem ignorados silenciosamente.
  await new Promise(resolve => {
    const probe = spawn(process.execPath,
      ['-e', "import('./src/evolution.js').then(m=>console.log(JSON.stringify(m.getConfig())))"],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    probe.stdout.on('data', d => { out += d; });
    probe.on('close', () => {
      try {
        const cfg = JSON.parse(out.trim());
        cfg.baseUrl && !/\/manager$/.test(cfg.baseUrl)
          ? ok(`baseUrl lida do .env e normalizada (${cfg.baseUrl})`)
          : no(`baseUrl inválida: ${cfg.baseUrl}`);
        cfg.instance ? ok(`instance lida do .env (${cfg.instance})`) : no('instance vazia');
      } catch { no('módulo não conseguiu ler o .env', out.slice(0, 200)); }
      resolve();
    });
  });

  /* --- 1. Boas-vindas --- */
  head('1 · Primeiro contato → boas-vindas + assunto');
  await incoming('oi');
  const m1 = sent[0]?.text || '';
  m1.includes('bem-vindo') || m1.includes('Bem-vindo') ? ok('saudação enviada') : no('sem saudação', m1.slice(0, 120));
  m1.includes('Sérgio') ? ok('trata o cliente pelo primeiro nome do perfil') : no('não usou o pushName', m1.slice(0, 120));
  m1.includes('deseja falar') ? ok('pergunta o assunto') : no('não perguntou o assunto');
  /Agendar serviço/.test(m1) && /Outro assunto/.test(m1) ? ok('menu de assuntos presente') : no('menu de assuntos ausente');
  sent[0]?.number === PHONE ? ok('enviou para o número certo') : no(`número errado: ${sent[0]?.number}`);

  /* --- 2. fromMe deve ser ignorado (anti-loop) --- */
  head('2 · Anti-loop: mensagem própria (fromMe) é descartada');
  const before = sent.length;
  await incoming('mensagem do próprio bot', { fromMe: true });
  sent.length === before ? ok('fromMe ignorado — sem loop') : no('respondeu à própria mensagem (LOOP)');

  /* --- 3. Grupo deve ser ignorado --- */
  head('3 · Grupos são ignorados');
  const beforeG = sent.length;
  await incoming('oi galera', { jid: '123456789-987@g.us' });
  sent.length === beforeG ? ok('grupo ignorado') : no('respondeu em grupo');

  /* --- 4. Assunto por número --- */
  head('4 · Assunto ("1") → pergunta o veículo');
  await incoming('1');
  const m2 = sent[sent.length - 1]?.text || '';
  m2.includes('veículo') ? ok('perguntou o veículo') : no('não perguntou o veículo', m2.slice(0, 120));

  /* --- 5. Idempotência --- */
  head('5 · Evento repetido não é processado duas vezes');
  const dupId = 'DUP-FIXED-1';
  const beforeD = sent.length;
  await incoming('Corolla', { id: dupId });
  const afterFirst = sent.length;
  await incoming('Corolla', { id: dupId });
  sent.length === afterFirst ? ok('reentrega ignorada') : no('processou o mesmo evento 2x');
  afterFirst > beforeD ? ok('primeira entrega processada') : no('primeira entrega não processou');

  /* --- 6. Handoff --- */
  head('6 · Handoff: registro + pedido para aguardar + bot silenciado');
  const closing = sent[sent.length - 1]?.text || '';
  /aguarde/i.test(closing) ? ok('pede que aguarde o atendimento humano') : no('não pediu para aguardar', closing.slice(0, 160));
  closing.includes('Corolla') ? ok('confirma o veículo informado') : no('não confirmou o veículo');
  closing.includes('Agendar serviço') ? ok('confirma o assunto') : no('não confirmou o assunto');
  /M & A Lava a Jato/.test(closing) ? ok('assinatura da empresa presente') : no('sem assinatura');

  const { data: triages } = await sb.from('triages').select('*').eq('phone', PHONE);
  if (triages?.length === 1) {
    const t = triages[0];
    ok('triagem gravada no Supabase (1 registro)');
    t.subject === 'Agendar serviço' ? ok(`subject = "${t.subject}"`) : no(`subject errado: ${t.subject}`);
    t.vehicle === 'Corolla' ? ok(`vehicle = "${t.vehicle}"`) : no(`vehicle errado: ${t.vehicle}`);
    t.name === 'Sérgio' ? ok(`name = "${t.name}"`) : no(`name errado: ${t.name}`);
    t.status === 'pending' ? ok('status = pending (acende a notificação)') : no(`status errado: ${t.status}`);
    t.seen === false ? ok('seen = false (notificação não vista)') : no(`seen errado: ${t.seen}`);
  } else {
    no(`esperava 1 triagem, achei ${triages?.length ?? 0}`);
  }

  const { data: sess } = await sb.from('bot_sessions').select('*').eq('phone', PHONE).maybeSingle();
  sess?.handed_off === true ? ok('handed_off = true') : no(`handed_off errado: ${sess?.handed_off}`);

  /* --- 7. Silêncio após handoff --- */
  head('7 · Após o handoff o bot não responde mais');
  const beforeS = sent.length;
  await incoming('ainda estou aqui?');
  sent.length === beforeS ? ok('bot silenciado — quem fala é o humano') : no('bot respondeu após o handoff');

  const { data: msgs } = await sb.from('messages').select('*').eq('phone', PHONE);
  (msgs?.filter(m => m.direction === 'in').length ?? 0) >= 4
    ? ok(`mensagens do cliente registradas (${msgs.filter(m => m.direction === 'in').length} in)`)
    : no('mensagens de entrada não registradas');
  (msgs?.filter(m => m.direction === 'out').length ?? 0) >= 3
    ? ok(`respostas do bot registradas (${msgs.filter(m => m.direction === 'out').length} out)`)
    : no('respostas não registradas');

  /* --- 8. Regra das 24h --- */
  head('8 · Rearme de 24h após o último contato');

  // Ainda dentro da janela: continua silenciado.
  await sb.from('bot_sessions')
    .update({ updated_at: new Date(Date.now() - 23 * 3600_000).toISOString() })
    .eq('phone', PHONE);
  const before23 = sent.length;
  await incoming('23 horas depois');
  sent.length === before23 ? ok('23h: continua silenciado') : no('23h: bot falou antes da hora');

  // A mensagem acima deve ter empurrado a janela para agora.
  const { data: touched } = await sb.from('bot_sessions').select('updated_at').eq('phone', PHONE).maybeSingle();
  (Date.now() - new Date(touched.updated_at).getTime()) < 60_000
    ? ok('janela empurrada pelo contato (não interrompe o atendente)')
    : no('updated_at não foi renovado no contato');

  // Passadas 24h: rearma e trata como contato novo.
  await sb.from('bot_sessions')
    .update({ updated_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
    .eq('phone', PHONE);
  const before25 = sent.length;
  await incoming('voltei depois de um dia');
  const rearmed = sent[sent.length - 1]?.text || '';
  sent.length > before25 ? ok('25h: bot rearmado e respondeu') : no('25h: bot não rearmou');
  /bem-vindo/i.test(rearmed) ? ok('recomeçou pelas boas-vindas') : no('não recomeçou o fluxo', rearmed.slice(0, 120));

  const { data: reSess } = await sb.from('bot_sessions').select('*').eq('phone', PHONE).maybeSingle();
  reSess?.handed_off === false ? ok('handed_off zerado no rearme') : no(`handed_off = ${reSess?.handed_off}`);

  /* --- 9. Reativar bot --- */
  head('9 · "Reativar bot" devolve o número à triagem');
  const login = await fetch(`http://localhost:${APP_PORT}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
  });
  if (login.ok) {
    ok('login do dashboard aceito');
    const { token } = await login.json();

    const bad = await fetch(`http://localhost:${APP_PORT}/admin/api/triages`);
    bad.status === 401 ? ok('API protegida sem token (401)') : no(`API exposta: ${bad.status}`);

    const react = await fetch(`http://localhost:${APP_PORT}/admin/api/sessions/${PHONE}/reactivate`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }
    });
    react.ok ? ok('endpoint de reativação respondeu') : no(`reativação falhou: ${react.status}`);

    const beforeR = sent.length;
    await incoming('oi de novo');
    sent.length > beforeR ? ok('bot voltou a atender após reativar') : no('bot continuou silenciado');
  } else {
    no(`login do dashboard falhou: ${login.status}`);
  }

  /* --- 10. Delay humanizado --- */
  head('10 · Delay antes de responder + indicador "digitando"');
  presences.length > 0
    ? ok(`presença "composing" enviada (${presences.length}x)`)
    : no('não mostrou "digitando" antes de responder');
  presences.every(p => p.presence === 'composing')
    ? ok('presença sempre "composing"') : no('presença inesperada');
  presences.every(p => p.number === PHONE)
    ? ok('presença enviada ao número certo') : no('presença para número errado');

  const beforeDelay = sent.length;
  const t0 = Date.now();
  await incoming('mais uma pergunta');
  if (sent.length > beforeDelay) {
    ok('respondeu');
    const gap = sent[beforeDelay].at - t0;
    // gap = delay configurado + latência real do Supabase (3 chamadas antes da pausa).
    // Limite superior confirma que NÃO está usando a janela de produção (3–5s).
    gap >= 300 && gap < 2500
      ? ok(`delay aplicado: ${gap}ms (300–400ms de pausa + latência do banco)`)
      : no(`delay fora do esperado: ${gap}ms`);
  } else {
    no('não respondeu');
  }

  /* --- 11. Dashboard --- */
  head('11 · Dashboard');
  const page = await fetch(`http://localhost:${APP_PORT}/admin`);
  const html = await page.text();
  page.ok ? ok('/admin serve a página') : no(`/admin retornou ${page.status}`);
  html.includes('Central de Atendimento') ? ok('HTML do dashboard correto') : no('HTML inesperado');
  !/https?:\/\/(?!localhost)/.test(html.replace(/wa\.me/g, '')) || !html.includes('cdn')
    ? ok('página autocontida (sem CDN externo)') : no('página depende de recurso externo');

} catch (err) {
  no('exceção no teste: ' + err.message);
  console.error(err);
} finally {
  await cleanup();
  app.kill('SIGKILL');
  mockServer.close();

  console.log('\n' + '─'.repeat(56));
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✔ ${pass} verificações passaram. Fluxo íntegro.\x1b[0m`
    : `\x1b[31m\x1b[1m✖ ${fail} falha(s) · ${pass} ok\x1b[0m`);
  console.log('─'.repeat(56) + '\n');

  if (fail) console.log('Log do app:\n' + appLog.split('\n').slice(-30).join('\n'));
  process.exit(fail ? 1 : 0);
}

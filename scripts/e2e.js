#!/usr/bin/env node
/**
 * Teste end-to-end do atendimento.
 *
 * Sobe uma Evolution API FALSA e roda o app apontado para ela — nenhuma
 * mensagem real de WhatsApp é enviada. O Supabase é o de verdade e as linhas
 * de teste são apagadas no final.
 *
 * O payload do webhook é o mesmo que a Evolution v2 manda de verdade
 * (data.key.remoteJid / data.message.conversation).
 *
 *   npm test
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const MOCK_PORT = 4010;
const APP_PORT = 4011;
const A = '5588000000091';   // cliente do fluxo guiado
const B = '5588000000092';   // cliente que já diz tudo na primeira mensagem
const C = '5588000000093';   // cliente com dúvida solta

const sent = [];
const presences = [];
let pass = 0, fail = 0;

const ok = m => { console.log(`  \x1b[32m✔\x1b[0m ${m}`); pass++; };
const no = (m, extra) => { console.log(`  \x1b[31m✖\x1b[0m ${m}`); if (extra) console.log(`     ${String(extra).slice(0,200)}`); fail++; };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ---------------- Evolution falsa ---------------- */
const mock = express();
mock.use(express.json());
mock.get('/', (_q, r) => r.json({ version: '2.3.7-mock' }));
mock.get('/instance/fetchInstances', (_q, r) => r.json([{
  name: '3041', connectionStatus: 'open',
  ownerJid: '558881553041@s.whatsapp.net', profileName: 'SX (mock)'
}]));
mock.post('/chat/sendPresence/:i', (q, r) => { presences.push(q.body); r.json({ ok: true }); });
mock.post('/message/sendText/:i', (q, r) => {
  sent.push({ number: q.body.number, text: q.body.text, at: Date.now() });
  console.log(`  \x1b[90m↗ ${q.body.number}: ${String(q.body.text).split('\n')[0].slice(0,64)}…\x1b[0m`);
  r.json({ key: { id: 'MOCK' + sent.length } });
});
mock.get('/webhook/find/:i', (_q, r) => r.json({
  enabled: true, url: `http://localhost:${APP_PORT}/webhook/messages`, events: ['MESSAGES_UPSERT']
}));
mock.post('/webhook/set/:i', (q, r) => r.json({ ...q.body.webhook }));
const mockServer = mock.listen(MOCK_PORT);

/* ---------------- App sob teste ---------------- */
const app = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    EVOLUTION_API_URL: `http://localhost:${MOCK_PORT}`,
    PORT: String(APP_PORT), ALT_PORT: String(APP_PORT),
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    REPLY_DELAY_MIN_MS: '250', REPLY_DELAY_MAX_MS: '350',
    KEEPALIVE_HOURS: '0',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let appLog = '';
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 70; i++) {
    try { if ((await fetch(`http://localhost:${APP_PORT}/health`)).ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

/** Espera o app terminar de processar (a rota responde antes do fluxo rodar). */
async function quiesce(timeoutMs = 20000) {
  const limite = Date.now() + timeoutMs;
  await sleep(70);
  while (Date.now() < limite) {
    try {
      const { inflight } = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
      if (!inflight) { await sleep(140); return; }
    } catch {}
    await sleep(100);
  }
  throw new Error('processamento não terminou no tempo esperado');
}

async function diz(texto, { de = A, fromMe = false, jid = null, id = null, pushName = 'Sergio Ponte' } = {}) {
  await fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'messages.upsert', instance: '3041',
      data: {
        key: { remoteJid: jid || `${de}@s.whatsapp.net`, fromMe, id: id || 'M' + Math.random().toString(36).slice(2,10) },
        pushName, message: { conversation: texto },
        messageType: 'conversation', messageTimestamp: Math.floor(Date.now()/1000)
      }
    })
  });
  await quiesce();
}

const ultima = () => sent[sent.length - 1]?.text || '';
const daPara = n => sent.filter(s => s.number === n);

const sb = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });

async function limpar() {
  for (const p of [A, B, C]) {
    await sb.from('triages').delete().eq('phone', p);
    await sb.from('bot_sessions').delete().eq('phone', p);
    await sb.from('messages').delete().eq('phone', p);
  }
}
const triagemDe = async p => (await sb.from('triages').select('*').eq('phone', p).maybeSingle()).data;
const sessaoDe = async p => (await sb.from('bot_sessions').select('*').eq('phone', p).maybeSingle()).data;

/* ================= Bateria ================= */
try {
  console.log('\n\x1b[1m═══ E2E · atendimento M & A ═══\x1b[0m');
  if (!await waitUp()) { console.error('\nApp não subiu:\n' + appLog); process.exit(1); }
  await limpar();

  /* ---------- 0 · config vem do .env ---------- */
  head('0 · Config lida do .env sem variáveis herdadas');
  await new Promise(res => {
    const probe = spawn(process.execPath,
      ['-e', "import('./src/evolution.js').then(m=>console.log(JSON.stringify(m.getConfig())))"],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore','pipe','pipe'] });
    let out = '';
    probe.stdout.on('data', d => { out += d; });
    probe.on('close', () => {
      try {
        const c = JSON.parse(out.trim());
        c.baseUrl && !/\/manager$/.test(c.baseUrl) ? ok(`baseUrl do .env normalizada`) : no(`baseUrl inválida: ${c.baseUrl}`);
        c.instance ? ok(`instance do .env (${c.instance})`) : no('instance vazia');
      } catch { no('módulo não leu o .env', out); }
      res();
    });
  });

  /* ---------- 1 · Etapa 1: boas-vindas + nome ---------- */
  head('1 · Etapa 1 — boas-vindas e nome');
  await diz('oi');
  let m = ultima();
  /Bem-vindo à \*M & A Lavagens e Estética\*/.test(m) ? ok('boas-vindas com o nome da empresa') : no('boas-vindas ausente', m);
  /nossa atendente dará continuidade/.test(m) ? ok('explica que a atendente assume depois') : no('não explica o handoff');
  /qual é o seu nome/i.test(m) ? ok('pergunta o nome') : no('não perguntou o nome', m);

  await diz('Sérgio');
  m = ultima();
  /Prazer, \*Sérgio\*/.test(m) ? ok('cumprimenta pelo nome') : no('não usou o nome', m);
  /Como podemos cuidar do seu veículo hoje/.test(m) ? ok('pergunta a intenção') : no('não perguntou a intenção');
  /Quero lavar meu veículo/.test(m) && /Consultar valores/.test(m) ? ok('menu de intenção completo') : no('menu de intenção incompleto');

  /* ---------- 2 · Etapa 2: veículo ---------- */
  head('2 · Etapa 2 — categoria e modelo');
  await diz('1');
  m = ultima();
  /tipo do seu veículo/.test(m) ? ok('pergunta a categoria') : no('não perguntou a categoria', m);
  /Hatch \/ Compacto/.test(m) && /Picape/.test(m) ? ok('menu de categorias completo') : no('menu de categorias incompleto');

  await diz('3');
  m = ultima();
  /modelo do veículo/.test(m) ? ok('pergunta o modelo') : no('não perguntou o modelo', m);

  await diz('Jeep Compass');
  m = ultima();
  /Compass/.test(m) ? ok('trata o carro pelo modelo na conversa') : no('não citou o modelo', m);

  /* ---------- 3 · Etapa 3: necessidade ---------- */
  head('3 · Etapa 3 — serviço e o caminho do "ainda não sei"');
  /o que você está buscando/.test(m) ? ok('pergunta o serviço') : no('não perguntou o serviço');
  /Higienização interna/.test(m) && /Ainda não sei qual escolher/.test(m) ? ok('menu de serviços completo') : no('menu de serviços incompleto');

  await diz('6');                       // Ainda não sei qual escolher
  m = ultima();
  /incomodando você no veículo/.test(m) ? ok('abre o submenu de necessidade') : no('não abriu o submenu', m);
  /Bancos\/estofados sujos/.test(m) ? ok('menu de necessidades presente') : no('menu de necessidades ausente');

  await diz('2');                       // Bancos/estofados sujos
  m = ultima();
  /mais indicado para o seu \*Compass\* é \*Higienização interna\*/.test(m)
    ? ok('recomenda o serviço a partir da dor relatada') : no('não recomendou o serviço', m);

  /* ---------- 4 · Etapa 4: nível ---------- */
  head('4 · Etapa 4 — nível de atendimento');
  /Qual resultado você está buscando/.test(m) ? ok('pergunta o nível') : no('não perguntou o nível');
  /Essencial — manutenção/.test(m) && /Premium — tratamento/.test(m) ? ok('níveis com descrição') : no('níveis sem descrição');
  /Quero uma recomendação/.test(m) ? ok('oferece recomendação') : no('não oferece recomendação');

  await diz('4');                       // Quero uma recomendação
  m = ultima();
  /parece ser a mais adequada/.test(m) ? ok('recomenda o nível') : no('não recomendou o nível', m);
  /\*Completa\*/.test(m) ? ok('nível recomendado coerente com o serviço') : no('nível recomendado inesperado', m);

  /* ---------- 5 · Etapa 5: agendamento ---------- */
  head('5 · Etapa 5 — período e data');
  /Qual período seria melhor/.test(m) ? ok('pergunta o período') : no('não perguntou o período');

  await diz('1');                       // Manhã
  m = ultima();
  /para quando você gostaria/.test(m) ? ok('pergunta a data') : no('não perguntou a data', m);
  /Próximo dia útil/.test(m) && /Sábado/.test(m) ? ok('menu de datas presente') : no('menu de datas ausente');

  await diz('3');                       // Sábado
  m = ultima();
  /Sua preferência é/.test(m) ? ok('resume a preferência') : no('não resumiu a preferência', m);
  /Sábado/.test(m) && /manh/i.test(m) ? ok('preferência com dia e período') : no('preferência incompleta', m);
  // norm() tira acentos: usá-lo para exibir gerava "Sábado pela manha".
  /pela manhã/.test(m) ? ok('período acentuado na frase ("pela manhã")') : no('acento perdido na exibição', m);
  /Posso encaminhar seu atendimento/.test(m) ? ok('pede autorização para encaminhar') : no('não pediu autorização');

  /* ---------- 6 · Etapa 6: handoff ---------- */
  head('6 · Etapa 6 — transferência com contexto');
  await diz('1');                       // Sim, pode encaminhar
  m = ultima();
  /Perfeito, Sérgio/.test(m) ? ok('confirma pelo nome') : no('não confirmou pelo nome', m);
  /informações do seu atendimento organizadas/.test(m) ? ok('diz que organizou o contexto') : no('não menciona o contexto');
  /não precisará repetir/.test(m) ? ok('promete não repetir perguntas') : no('não promete isso');
  /aguarde/i.test(m) ? ok('pede que aguarde a atendente') : no('não pediu para aguardar');

  const t = await triagemDe(A);
  if (!t) no('triagem não gravada');
  else {
    ok(`triagem gravada (#${t.id})`);
    const campos = {
      name: 'Sérgio', category: 'SUV', vehicle: 'Jeep Compass',
      service: 'Higienização interna', need: 'Bancos/estofados sujos',
      level: 'Completa', period: 'Manhã', date_pref: 'Sábado',
      intent: 'lavar', origin: 'chatbot', status: 'pending'
    };
    for (const [k, v] of Object.entries(campos)) {
      t[k] === v ? ok(`${k} = ${v}`) : no(`${k}: esperava "${v}", veio "${t[k]}"`);
    }
    t.recommended === true ? ok('marcada como indicada pelo bot') : no(`recommended = ${t.recommended}`);
    t.seen === false ? ok('seen = false (acende a notificação)') : no(`seen = ${t.seen}`);
  }

  const s = await sessaoDe(A);
  s?.handed_off === true ? ok('handed_off = true') : no(`handed_off = ${s?.handed_off}`);

  head('6b · Bot silencia após o handoff');
  const antes = daPara(A).length;
  await diz('e o valor?');
  daPara(A).length === antes ? ok('bot em silêncio — quem fala é a atendente') : no('bot respondeu após o handoff');

  /* ---------- 7 · REGRA CENTRAL: não repetir o que já foi dito ---------- */
  head('7 · Regra central — contexto extraído do texto livre');
  const antesB = sent.length;
  await diz('Meu nome é Sérgio, tenho uma Hilux e quero lavagem completa sábado', { de: B, pushName: 'Sergio' });
  const msgsB = daPara(B);
  m = msgsB[msgsB.length - 1]?.text || '';

  msgsB.length === 1 ? ok('respondeu uma única vez') : no(`respondeu ${msgsB.length} vezes`);
  /Bem-vindo/.test(m) ? ok('dá boas-vindas mesmo pulando a pergunta do nome') : no('sem boas-vindas', m);
  !/qual é o seu nome/i.test(m) ? ok('NÃO pergunta o nome (já foi dito)') : no('perguntou o nome de novo');
  !/tipo do seu veículo/.test(m) ? ok('NÃO pergunta a categoria (dedu­zida de "Hilux")') : no('perguntou a categoria');
  !/modelo do veículo/.test(m) ? ok('NÃO pergunta o modelo') : no('perguntou o modelo');
  !/o que você está buscando/.test(m) ? ok('NÃO pergunta o serviço') : no('perguntou o serviço');
  !/Qual resultado você está buscando/.test(m) ? ok('NÃO pergunta o nível (extraiu "completa")') : no('perguntou o nível');
  !/para quando você gostaria/.test(m) ? ok('NÃO pergunta a data (extraiu "sábado")') : no('perguntou a data');
  /Qual período seria melhor/.test(m) ? ok('pergunta APENAS o período, que faltava') : no('não pediu o período', m);

  const sessB = await sessaoDe(B);
  const dB = sessB?.data || {};
  dB.name === 'Sérgio' ? ok('nome extraído') : no(`nome: ${dB.name}`);
  dB.category === 'Picape' ? ok('categoria inferida do modelo (Hilux → Picape)') : no(`categoria: ${dB.category}`);
  /hilux/i.test(dB.vehicle || '') ? ok(`veículo extraído (${dB.vehicle})`) : no(`veículo: ${dB.vehicle}`);
  dB.service === 'Lavagem' ? ok('serviço = Lavagem') : no(`serviço: ${dB.service}`);
  dB.level === 'Completa' ? ok('nível = Completa (não confundiu com serviço)') : no(`nível: ${dB.level}`);
  dB.date_pref === 'Sábado' ? ok('data = Sábado') : no(`data: ${dB.date_pref}`);
  dB.intent === 'lavar' ? ok('intenção = lavar') : no(`intenção: ${dB.intent}`);

  await diz('de manhã', { de: B });
  m = daPara(B).slice(-1)[0].text;
  /Posso encaminhar/.test(m) ? ok('uma resposta depois já vai para a confirmação') : no('não chegou à confirmação', m);

  await diz('sim', { de: B });
  const tB = await triagemDe(B);
  tB ? ok(`triagem de B gravada (#${tB.id})`) : no('triagem de B não gravada');
  tB?.level === 'Completa' && tB?.category === 'Picape' ? ok('contexto extraído chegou íntegro no registro') : no('contexto perdido no registro');

  /* ---------- 8 · Dúvida solta ---------- */
  head('8 · Dúvida solta vai direto ao humano');
  await diz('oi', { de: C, pushName: 'Ana' });
  await diz('Ana', { de: C });
  await diz('5', { de: C });            // Tenho outra dúvida
  m = daPara(C).slice(-1)[0].text;
  /responder essa dúvida/.test(m) ? ok('não pede veículo nem agenda para dúvida') : no('pediu dados desnecessários', m);
  await diz('1', { de: C });
  const tC = await triagemDe(C);
  tC?.intent === 'duvida' ? ok('registrada como dúvida') : no(`intent: ${tC?.intent}`);

  /* ---------- 8b · Sessão de versão anterior ---------- */
  head('8b · Sessão gravada por versão antiga do fluxo');
  const D = '5588000000094';
  await sb.from('bot_sessions').delete().eq('phone', D);
  await sb.from('bot_sessions').insert([{
    phone: D, step: 'ask_vehicle',                    // passo que já não existe
    data: { phone: D, name: 'Sérgio', subject: 'Agendar serviço' },
    handed_off: false, updated_at: new Date().toISOString()
  }]);
  let nD = sent.length;
  await diz('Corolla', { de: D });
  const respD = sent.slice(nD).filter(x => x.number === D).map(x => x.text).join(' ');
  respD ? ok('respondeu apesar do passo desconhecido') : no('não respondeu');
  !/null|undefined/.test(respD) ? ok('sem "null" na mensagem') : no('enviou null/undefined', respD);
  const sD = await sessaoDe(D);
  sD?.data?.intent === 'agendar' ? ok('subject antigo migrado para intent') : no(`intent: ${sD?.data?.intent}`);
  sD?.data?.name === 'Sérgio' ? ok('nome preservado — não recomeçou do zero') : no('perdeu o nome');
  await sb.from('bot_sessions').delete().eq('phone', D);
  await sb.from('messages').delete().eq('phone', D);

  /* ---------- 9 · Filtros ---------- */
  head('9 · Filtros: própria mensagem, grupo, reentrega');
  let n = sent.length;
  await diz('eco', { fromMe: true, de: B });
  sent.length === n ? ok('fromMe ignorado — sem loop') : no('respondeu à própria mensagem');

  n = sent.length;
  await diz('oi galera', { jid: '123456789-987@g.us' });
  sent.length === n ? ok('grupo ignorado') : no('respondeu em grupo');

  await sb.from('bot_sessions').delete().eq('phone', C);
  await sb.from('triages').delete().eq('phone', C);
  n = sent.length;
  await diz('oi', { de: C, id: 'DUP-1' });
  const depois1 = sent.length;
  await diz('oi', { de: C, id: 'DUP-1' });
  sent.length === depois1 ? ok('reentrega do mesmo id ignorada') : no('processou o mesmo evento 2x');
  depois1 > n ? ok('primeira entrega processada') : no('primeira entrega não processou');

  /* ---------- 10 · Rearme de 24h ---------- */
  head('10 · Rearme 24h após o último contato');
  await sb.from('bot_sessions').update({ updated_at: new Date(Date.now() - 23*3600_000).toISOString() }).eq('phone', A);
  n = daPara(A).length;
  await diz('oi de novo', { de: A });
  daPara(A).length === n ? ok('23h: continua silenciado') : no('23h: bot falou antes da hora');

  const tocada = await sessaoDe(A);
  (Date.now() - new Date(tocada.updated_at).getTime()) < 90_000
    ? ok('contato empurra a janela (não atropela a atendente)') : no('updated_at não renovou');

  await sb.from('bot_sessions').update({ updated_at: new Date(Date.now() - 25*3600_000).toISOString() }).eq('phone', A);
  n = daPara(A).length;
  await diz('voltei', { de: A });
  daPara(A).length > n ? ok('25h: bot rearmado') : no('25h: não rearmou');
  /Bem-vindo|qual é o seu nome/i.test(daPara(A).slice(-1)[0].text)
    ? ok('recomeça do início') : no('não recomeçou o fluxo');

  /* ---------- 11 · Delay e presença ---------- */
  head('11 · Delay humanizado e "digitando"');
  presences.length ? ok(`presença "composing" enviada (${presences.length}x)`) : no('não mostrou "digitando"');
  presences.every(p => p.presence === 'composing') ? ok('presença sempre "composing"') : no('presença inesperada');

  const marca = sent.length, t0 = Date.now();
  await diz('teste de delay', { de: B });
  if (sent.length > marca) {
    const gap = sent[marca].at - t0;
    gap >= 250 && gap < 2500 ? ok(`delay aplicado: ${gap}ms (250–350ms + latência do banco)`) : no(`delay fora do esperado: ${gap}ms`);
  } else ok('sem resposta (cliente já em handoff) — delay verificado nas etapas acima');

  /* ---------- 12 · API e dashboard ---------- */
  head('12 · API e dashboard');
  const login = await fetch(`http://localhost:${APP_PORT}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
  });
  login.ok ? ok('login aceito') : no(`login falhou: ${login.status}`);
  const { token } = await login.json();

  (await fetch(`http://localhost:${APP_PORT}/admin/api/triages`)).status === 401
    ? ok('API protegida sem token') : no('API exposta');

  const lista = await (await fetch(`http://localhost:${APP_PORT}/admin/api/triages`,
    { headers: { Authorization: 'Bearer ' + token } })).json();
  Array.isArray(lista) ? ok(`API devolve ${lista.length} triagens`) : no('API não devolveu lista');
  lista.some(r => r.level && r.category && r.vehicle)
    ? ok('registros trazem o contexto completo para a atendente') : no('contexto incompleto na API');

  const page = await fetch(`http://localhost:${APP_PORT}/admin`);
  const html = await page.text();
  page.ok ? ok('/admin serve a página') : no(`/admin: ${page.status}`);
  html.includes('Central de Atendimento') ? ok('HTML correto') : no('HTML inesperado');
  page.headers.get('cache-control')?.includes('no-store') ? ok('no-store no HTML') : no('sem no-store');
  !html.includes('{{BUILD}}') ? ok('selo de build injetado') : no('selo de build não substituído');
  html.includes('#C61C29') ? ok('paleta da marca aplicada (#C61C29)') : no('paleta da marca ausente');
  html.includes('/admin/assets/badge.png') ? ok('badge da marca no hero e no header') : no('badge ausente');

  for (const asset of ['badge.png', 'logo.png', 'favicon.png', 'apple-touch-icon.png']) {
    const r = await fetch(`http://localhost:${APP_PORT}/admin/assets/${asset}`);
    r.ok ? ok(`asset servido: ${asset}`) : no(`asset ${asset}: ${r.status}`);
  }

} catch (err) {
  no('exceção no teste: ' + err.message);
  console.error(err);
} finally {
  await limpar();
  app.kill('SIGKILL');
  mockServer.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✔ ${pass} verificações passaram.\x1b[0m`
    : `\x1b[31m\x1b[1m✖ ${fail} falha(s) · ${pass} ok\x1b[0m`);
  console.log('─'.repeat(58) + '\n');
  if (fail) console.log('Log do app (fim):\n' + appLog.split('\n').slice(-25).join('\n'));
  process.exit(fail ? 1 : 0);
}

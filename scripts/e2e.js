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
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const MOCK_PORT = 4010;
const APP_PORT = 4011;
const RUN_TOKEN = crypto.randomBytes(6).toString('hex');
const TEST_INSTANCE = `e2e-${RUN_TOKEN}-${process.pid}`;
const WEBHOOK_TEST_SECRET = `e2e-webhook-${RUN_TOKEN}`;
const ADMIN_TEST_PASSWORD = `e2e-admin-${RUN_TOKEN}`;
const RUN_SUFFIX = (BigInt(`0x${RUN_TOKEN}`) % 10_000_000_000n).toString().padStart(10, '0');
// Começa com zero e excede E.164 de propósito: nunca pode colidir com um
// cliente real, mesmo usando temporariamente o Supabase de produção.
const FIXTURE_PREFIX = `000${RUN_SUFFIX}`;
const fixturePhone = slot => `${FIXTURE_PREFIX}${String(slot).padStart(4, '0')}`;
const A = fixturePhone(91);   // cliente do fluxo guiado
const B = fixturePhone(92);   // cliente que já diz tudo na primeira mensagem
const C = fixturePhone(93);   // cliente com dúvida solta
const D = fixturePhone(94);   // sessão legada
const TZ_PHONE = fixturePhone(777);
const RACE_PHONE = fixturePhone(778);
const P = fixturePhone(801);
const Q = fixturePhone(802);
const E = fixturePhone(803);
const F = fixturePhone(812);
const F2 = fixturePhone(813);
const F3 = fixturePhone(814);
const F4 = fixturePhone(815);
const FIXTURE_PHONES = [
  A, B, C, D, TZ_PHONE, RACE_PHONE, P, Q, E, F, F2, F3, F4,
  `__ch_${TEST_INSTANCE.slice(0, 14)}`
];

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
let statusMock = 'open';
let atrasoBootMs = 800;
const instanciaValida = (q, r) => {
  if (q.params.i === TEST_INSTANCE) return true;
  r.status(404).json({ error: 'instância de teste incorreta' });
  return false;
};
mock.get('/instance/fetchInstances', async (_q, r) => {
  const espera = atrasoBootMs;
  atrasoBootMs = 0;
  if (espera) await new Promise(resolve => setTimeout(resolve, espera));
  r.json([{
  name: TEST_INSTANCE, connectionStatus: statusMock,
  ownerJid: '558881553041@s.whatsapp.net', profileName: 'SX (mock)',
  token: 'e2e-evolution-key'
  }]);
});
mock.post('/chat/sendPresence/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  presences.push(q.body); r.json({ ok: true });
});
let earlyAckNext = null;
mock.post('/message/sendText/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  const waId = `${TEST_INSTANCE}-MOCK-${sent.length + 1}`;
  sent.push({ number: q.body.number, text: q.body.text, at: Date.now(), waId });
  console.log(`  \x1b[90m↗ ${q.body.number}: ${String(q.body.text).split('\n')[0].slice(0,64)}…\x1b[0m`);
  if (earlyAckNext) {
    const status = earlyAckNext;
    earlyAckNext = null;
    // Publica o ACK antes de devolver o HTTP do sendText. É a corrida real
    // que antes perdia definitivamente a confirmação.
    fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-evolution-webhook-secret': WEBHOOK_TEST_SECRET },
      body: JSON.stringify({ event: 'messages.update', instance: TEST_INSTANCE,
                             data: { keyId: waId, status } })
    }).catch(() => {});
    return setTimeout(() => r.json({ key: { id: waId }, status: 'PENDING' }), 180);
  }
  r.json({ key: { id: waId }, status: 'PENDING' });
});
// Começa SEM MESSAGES_UPDATE: o boot tem de perceber e corrigir.
let webhookEventos = ['MESSAGES_UPSERT'];
let webhookHeaders = null;
mock.get('/webhook/find/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  r.json({
  enabled: true, url: `http://localhost:${APP_PORT}/webhook/messages`,
  events: webhookEventos, headers: webhookHeaders
  });
});
mock.post('/webhook/set/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  webhookEventos = q.body.webhook?.events || webhookEventos;
  webhookHeaders = q.body.webhook?.headers || null;
  r.json({ ...q.body.webhook });
});
let restarts = 0;
mock.get('/instance/connect/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  r.json(
  statusMock === 'open' ? { base64: null, pairingCode: null, code: null }
                        : { base64: 'data:image/png;base64,QUJD', pairingCode: null, code: 'x' }
  );
});
mock.post('/instance/restart/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  restarts++; r.json({ ok: true });
});
let logouts = 0;
mock.delete('/instance/logout/:i', (q, r) => {
  if (!instanciaValida(q, r)) return;
  logouts++; statusMock = 'close'; r.json({ status: 'SUCCESS' });
});
const criadas = [];
mock.post('/instance/create', (q, r) => { criadas.push(q.body); r.json({ instance: { instanceName: q.body.instanceName } }); });

const TEST_SUPABASE_URL = process.env.SUPABASE_TEST_URL || process.env.SUPABASE_URL;
const TEST_SUPABASE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const USA_BANCO_COMPARTILHADO = !process.env.SUPABASE_TEST_URL || !process.env.SUPABASE_TEST_SERVICE_KEY;
const envTesteFaltando = [
  !TEST_SUPABASE_URL && 'SUPABASE_TEST_URL (ou SUPABASE_URL)',
  !TEST_SUPABASE_KEY && 'SUPABASE_TEST_SERVICE_KEY (ou SUPABASE_SERVICE_KEY)'
].filter(Boolean);
if (envTesteFaltando.length) {
  throw new Error(`E2E não iniciado: faltam ${envTesteFaltando.join(', ')}`);
}
if (USA_BANCO_COMPARTILHADO && process.env.E2E_ALLOW_SHARED_SUPABASE !== 'I_UNDERSTAND') {
  throw new Error(
    'E2E bloqueado: configure SUPABASE_TEST_URL/SUPABASE_TEST_SERVICE_KEY ou confirme ' +
    'explicitamente E2E_ALLOW_SHARED_SUPABASE=I_UNDERSTAND'
  );
}

let mockServer = null;
let app = null;
let sb = createClient(TEST_SUPABASE_URL, TEST_SUPABASE_KEY, { auth: { persistSession: false } });
let MESSAGES_HAS_INSTANCE = true;
let appLog = '';
let limpar = async () => {};
let limparEventosTeste = async () => {};

const { error: instanceProbeError } = await sb.from('messages')
  .select('instance', { count: 'exact', head: true });
if (instanceProbeError) throw new Error(`E2E exige setup.sql atualizado: ${instanceProbeError.message}`);
const { data: schemaVersion, error: schemaVersionError } = await sb.rpc('chatbot_schema_version');
if (schemaVersionError || Number(schemaVersion) !== 2026080801) {
  throw new Error(`E2E exige schema 2026080801: ${schemaVersionError?.message || schemaVersion}`);
}

try {
mockServer = await new Promise((resolve, reject) => {
  const server = mock.listen(MOCK_PORT, () => resolve(server));
  server.once('error', reject);
});

/* ---------------- App sob teste ---------------- */
app = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_SERVICE_KEY: TEST_SUPABASE_KEY,
    EVOLUTION_API_URL: `http://localhost:${MOCK_PORT}`,
    EVOLUTION_API_KEY: 'e2e-evolution-key',
    EVOLUTION_INSTANCE: TEST_INSTANCE,
    EVOLUTION_WEBHOOK_SECRET: WEBHOOK_TEST_SECRET,
    ADMIN_PASSWORD: ADMIN_TEST_PASSWORD,
    PORT: String(APP_PORT), ALT_PORT: String(APP_PORT),
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    REPLY_DELAY_MIN_MS: '250', REPLY_DELAY_MAX_MS: '350',
    KEEPALIVE_HOURS: '0', REARM_HOURS: '24', MONITOR_SECONDS: '1',
    RECOVERY_MIN_MINUTES: '0', RECOVERY_MAX: '5',
    SONDA_TIMEOUT_MS: '3000',
    FREIO_REJEICOES: '3', FREIO_DESTINOS_MIN: '3', FREIO_DESTINO_REJEICOES: '2',
    TEST_PHONES: FIXTURE_PHONES.filter(p => /^\d+$/.test(p)).join(','),
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });
app.on('error', e => { appLog += `\n[spawn] ${e.message}\n`; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const somaUm = diaISO => {
  const d = new Date(diaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

async function waitHttp() {
  for (let i = 0; i < 70; i++) {
    try { if ((await fetch(`http://localhost:${APP_PORT}/health`)).ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

async function waitReady() {
  for (let i = 0; i < 70; i++) {
    try {
      const h = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
      if (h.ready) return true;
    } catch {}
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

async function postWebhook(body, { auth = true, expected = 200 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['x-evolution-webhook-secret'] = WEBHOOK_TEST_SECRET;
  const response = await fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (response.status !== expected) {
    throw new Error(`webhook respondeu ${response.status}; esperado ${expected}: ${await response.text()}`);
  }
  return response;
}

async function diz(texto, { de = A, fromMe = false, jid = null, id = null, pushName = 'Sergio Ponte' } = {}) {
  await postWebhook({
      event: 'messages.upsert', instance: TEST_INSTANCE,
      data: {
        key: { remoteJid: jid || `${de}@s.whatsapp.net`, fromMe, id: id || 'M' + Math.random().toString(36).slice(2,10) },
        pushName, message: { conversation: texto },
        messageType: 'conversation', messageTimestamp: Math.floor(Date.now()/1000)
      }
  });
  await quiesce();
}

/** Simula o ACK de entrega que a Evolution manda em MESSAGES_UPDATE. */
async function ack(waId, status, { instance = TEST_INSTANCE } = {}) {
  await postWebhook({ event: 'messages.update', instance,
                      data: { keyId: waId, status } });
  await quiesce();
}

const ultima = () => sent[sent.length - 1]?.text || '';
const daPara = n => sent.filter(s => s.number === n);

function escopoMensagemTeste(query) {
  query = query.eq('is_test', true);
  return MESSAGES_HAS_INSTANCE ? query.eq('instance', TEST_INSTANCE) : query;
}

async function limparTabelaTeste(tabela, phones) {
  let q = sb.from(tabela).delete().in('phone', phones).eq('is_test', true);
  if (tabela === 'messages' && MESSAGES_HAS_INSTANCE) q = q.eq('instance', TEST_INSTANCE);
  const { error } = await q;
  if (error) throw new Error(`limpeza ${tabela}: ${error.message}`);
}

async function limparTelefones(phones) {
  await limparTabelaTeste('triages', phones);
  await limparTabelaTeste('bot_sessions', phones);
  await limparTabelaTeste('messages', phones);
}

limparEventosTeste = async function () {
  const { error } = await sb.from('connection_events').delete().eq('instance', TEST_INSTANCE);
  if (error) throw new Error(`limpeza connection_events: ${error.message}`);
};

limpar = async function () {
  await limparTelefones(FIXTURE_PHONES);
};
const triagemDe = async p => (await sb.from('triages').select('*')
  .eq('phone', p).eq('is_test', true).maybeSingle()).data;
const sessaoDe = async p => (await sb.from('bot_sessions').select('*')
  .eq('phone', p).eq('is_test', true).maybeSingle()).data;

/* ================= Bateria ================= */
  console.log('\n\x1b[1m═══ E2E · atendimento M & A ═══\x1b[0m');
  if (!await waitHttp()) throw new Error('App não subiu:\n' + appLog);

  // A porta abre cedo para o painel diagnosticar o boot, mas webhooks devem
  // receber 503 até banco, instância, freio e configuração estarem prontos.
  const hBoot = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
  if (!hBoot.ready) {
    await postWebhook({
      event: 'messages.upsert', instance: TEST_INSTANCE,
      data: { key: { remoteJid: `${A}@s.whatsapp.net`, fromMe: false, id: 'BOOT-PENDENTE' },
              message: { conversation: 'não processe durante o boot' } }
    }, { expected: 503 });
    ok('webhook devolve 503 enquanto as dependências inicializam');
  } else {
    no('janela de boot não foi observada pelo teste');
  }
  if (!await waitReady()) throw new Error('App não ficou pronto:\n' + appLog);

  await postWebhook({ event: 'messages.upsert', instance: TEST_INSTANCE, data: {} },
    { auth: false, expected: 401 });
  ok('webhook público recusa evento sem o segredo da Evolution');
  await postWebhook({
    event: 'messages.upsert', instance: TEST_INSTANCE,
    apikey: 'e2e-evolution-key', data: {}
  }, { auth: false });
  ok('evento legado em retry autentica pelo apikey exposto desta instalação');
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

  /* ---------- 0b · Nome não aceita saudação ---------- */
  head('0b · "Oi"/"Ai" não viram nome do cliente');
  {
    const { nameFromAnswer } = await import('../src/extract.js');
    ['Oi','oi','Ai','Blz','teste','ok'].every(x => nameFromAnswer(x) === null)
      ? ok('saudações e interjeições rejeitadas') : no('alguma saudação virou nome');
    nameFromAnswer('Sérgio') === 'Sérgio' ? ok('nome real é aceito') : no('rejeitou nome válido');
    nameFromAnswer('Ana Paula') === 'Ana Paula' ? ok('nome composto é aceito') : no('rejeitou nome composto');
  }

  /* ---------- 1 · Etapa 1: boas-vindas + nome ---------- */
  head('1 · Etapa 1 — boas-vindas e nome');
  await diz('oi');
  {
    const so = daPara(A).slice(-1)[0]?.text || '';
    /qual é o seu nome/i.test(so) ? ok('"oi" não foi aceito como nome — repergunta') : no('"oi" virou nome', so);
  }
  await diz('Ai');
  {
    const so = daPara(A).slice(-1)[0]?.text || '';
    !/Prazer, \*Ai\*/.test(so) ? ok('"Ai" também rejeitado como nome') : no('"Ai" virou nome');
  }
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
  await limparTabelaTeste('bot_sessions', [D]);
  await sb.from('bot_sessions').insert([{
    phone: D, step: 'ask_vehicle',                    // passo que já não existe
    data: { phone: D, name: 'Sérgio', subject: 'Agendar serviço' },
    handed_off: false, is_test: true, updated_at: new Date().toISOString()
  }]);
  let nD = sent.length;
  await diz('Corolla', { de: D });
  const respD = sent.slice(nD).filter(x => x.number === D).map(x => x.text).join(' ');
  respD ? ok('respondeu apesar do passo desconhecido') : no('não respondeu');
  !/null|undefined/.test(respD) ? ok('sem "null" na mensagem') : no('enviou null/undefined', respD);
  const sD = await sessaoDe(D);
  sD?.data?.intent === 'agendar' ? ok('subject antigo migrado para intent') : no(`intent: ${sD?.data?.intent}`);
  sD?.data?.name === 'Sérgio' ? ok('nome preservado — não recomeçou do zero') : no('perdeu o nome');
  await limparTabelaTeste('bot_sessions', [D]);
  await limparTabelaTeste('messages', [D]);

  /* ---------- 9 · Filtros ---------- */
  head('9 · Filtros: própria mensagem, grupo, reentrega');
  let n = sent.length;
  await diz('eco', { fromMe: true, de: B });
  sent.length === n ? ok('fromMe ignorado — sem loop') : no('respondeu à própria mensagem');

  n = sent.length;
  await diz('oi galera', { jid: '123456789-987@g.us' });
  sent.length === n ? ok('grupo ignorado') : no('respondeu em grupo');

  await limparTabelaTeste('bot_sessions', [C]);
  await limparTabelaTeste('triages', [C]);
  n = sent.length;
  await diz('oi', { de: C, id: 'DUP-1' });
  const depois1 = sent.length;
  await diz('oi', { de: C, id: 'DUP-1' });
  sent.length === depois1 ? ok('reentrega do mesmo id ignorada') : no('processou o mesmo evento 2x');
  depois1 > n ? ok('primeira entrega processada') : no('primeira entrega não processou');

  /* ---------- 10 · Rearme de 24h ---------- */
  head('10 · Rearme 24h após o último contato');
  await sb.from('bot_sessions').update({ updated_at: new Date(Date.now() - 23*3600_000).toISOString() })
    .eq('phone', A).eq('is_test', true);
  n = daPara(A).length;
  await diz('oi de novo', { de: A });
  daPara(A).length === n ? ok('23h: continua silenciado') : no('23h: bot falou antes da hora');

  const tocada = await sessaoDe(A);
  (Date.now() - new Date(tocada.updated_at).getTime()) < 90_000
    ? ok('contato empurra a janela (não atropela a atendente)') : no('updated_at não renovou');

  await sb.from('bot_sessions').update({ updated_at: new Date(Date.now() - 25*3600_000).toISOString() })
    .eq('phone', A).eq('is_test', true);
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

  /* ---------- 11a · Corrida no mesmo número ---------- */
  head('11a · Duas mensagens do mesmo número ao mesmo tempo');
  {
    await limparTelefones([RACE_PHONE]);

    const antes = sent.length;
    // No WhatsApp é normal mandar "oi" e o nome sem esperar resposta. Sem
    // serialização por telefone, as duas liam a mesma sessão: o cliente
    // recebia as boas-vindas duas vezes e o nome era descartado.
    const crua = (texto, id) => postWebhook({
        event: 'messages.upsert', instance: TEST_INSTANCE,
        data: {
          key: { remoteJid: `${RACE_PHONE}@s.whatsapp.net`, fromMe: false, id },
          pushName: 'Sergio', message: { conversation: texto },
          messageType: 'conversation', messageTimestamp: Math.floor(Date.now()/1000)
        }
    });
    await Promise.all([crua('oi', 'RACE-A'), crua('Sérgio', 'RACE-B')]);
    await quiesce();

    const respostas = sent.slice(antes).filter(x => x.number === RACE_PHONE).map(x => x.text);
    const boasVindas = respostas.filter(t => /qual é o seu nome/i.test(t)).length;
    boasVindas <= 1 ? ok('não repetiu a pergunta do nome') : no(`perguntou o nome ${boasVindas} vezes`);

    const sess = await sessaoDe(RACE_PHONE);
    sess?.data?.name === 'Sérgio' ? ok('a segunda mensagem não foi perdida (nome capturado)') : no(`nome: ${sess?.data?.name}`);
    sess?.step === 'ask_intent' ? ok('fluxo avançou em ordem') : no(`passo: ${sess?.step}`);

    await limparTelefones([RACE_PHONE]);
  }

  /* ---------- 11b · matchOption com texto livre ---------- */
  head('11b · Reconhecimento de resposta livre nos menus');
  {
    const { matchOption } = await import('../src/extract.js');
    const { SERVICES, INTENTS, CATEGORIES, LEVELS, PERIODS, DATES, NEEDS } = await import('../src/catalog.js');
    // Casos que falhavam antes: palavra compartilhada ("quero") empatava as
    // opções, e sinônimos reais do cliente ("preço", "só lavar") não existiam.
    const casos = [
      [SERVICES, 'quero lavagem', 'Lavagem'],
      [SERVICES, 'quero uma lavagem detalhada', 'Lavagem detalhada'],
      [SERVICES, 'so lavar', 'Lavagem'],
      [SERVICES, 'os bancos estão sujos', 'Higienização interna'],
      [SERVICES, 'não sei', 'Ainda não sei qual escolher'],
      [INTENTS, 'quero lavar', 'Quero lavar meu veículo'],
      [INTENTS, 'preço', 'Consultar valores'],
      [INTENTS, 'quanto custa', 'Consultar valores'],
      [CATEGORIES, 'caminhonete', 'Picape'],
      [LEVELS, 'quero a top', 'Premium'],
      [PERIODS, 'fim da tarde', 'Final da tarde'],
      [DATES, 'fim de semana', 'Sábado'],
      [NEEDS, 'tá com riscos', 'Riscos/marcas na pintura']
    ];
    let ruins = 0;
    for (const [lista, entrada, esperado] of casos) {
      if (matchOption(entrada, lista) !== esperado) { ruins++; no(`"${entrada}" → esperava ${esperado}`); }
    }
    if (!ruins) ok(`${casos.length} respostas livres reconhecidas corretamente`);
  }

  /* ---------- 11c · Caixa preta ---------- */
  head('11c · Caixa preta registra os eventos');
  {
    const r = await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=200`);
    r.status === 401 ? ok('caixa preta protegida sem token') : no(`log exposto: ${r.status}`);

    const login0 = await fetch(`http://localhost:${APP_PORT}/admin/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_TEST_PASSWORD })
    });
    const tk = (await login0.json()).token;
    const d = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`,
      { headers: { Authorization: 'Bearer ' + tk } })).json();

    const nomes = new Set((d.eventos || []).map(e => e.event));
    d.eventos?.length ? ok(`${d.eventos.length} eventos registrados`) : no('nenhum evento');
    nomes.has('webhook.recebido') ? ok('registra mensagem recebida') : no('não registra recebimento');
    nomes.has('webhook.ignorado') ? ok('registra o motivo de ignorar (fromMe, grupo, reentrega)') : no('não registra descartes');
    nomes.has('flow.passo') ? ok('registra o avanço do fluxo') : no('não registra passos');
    nomes.has('flow.handoff') ? ok('registra o handoff') : no('não registra handoff');
    nomes.has('flow.silenciado') ? ok('registra o silêncio pós-handoff') : no('não registra silêncio');
    nomes.has('flow.rearmado') ? ok('registra o rearme de 24h') : no('não registra rearme');
    d.resumo?.capacidade === 400 ? ok('anel limitado a 400 eventos') : no(`capacidade: ${d.resumo?.capacidade}`);

    const filtrado = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?level=error`,
      { headers: { Authorization: 'Bearer ' + tk } })).json();
    (filtrado.eventos || []).every(e => e.level === 'error') ? ok('filtro por nível funciona') : no('filtro por nível falhou');

    const handoff = (d.eventos || []).find(e => e.event === 'flow.handoff');
    handoff?.meta?.triagem ? ok('handoff carrega o número da triagem') : no('handoff sem triagem no meta');
  }

  /* ---------- 11d · Ping público anti-pause ---------- */
  head('11d · Ping público toca o banco sem credencial');
  {
    const r = await fetch(`http://localhost:${APP_PORT}/ping`);
    const j = await r.json();
    r.ok ? ok('/ping responde 200 sem token') : no(`/ping: ${r.status}`);
    j.db === true ? ok('/ping confirma que o banco respondeu') : no('/ping não confirmou o banco');
    !JSON.stringify(j).match(/phone|name|vehicle/i) ? ok('/ping não expõe dado de cliente') : no('/ping expõe dados');
  }

  /* ---------- 11e · Config verificável no /health ---------- */
  head('11e · /health expõe a configuração em vigor');
  {
    const h = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
    h.config ? ok('config presente no /health') : no('config ausente');
    h.config?.rearmeHoras === 24 ? ok('rearme = 24h (verificável sem ler log)') : no(`rearme: ${h.config?.rearmeHoras}`);
    h.config?.instance === TEST_INSTANCE ? ok('instância em vigor exposta corretamente') : no(`instância: ${h.config?.instance}`);
    h.config?.webhookProtegido === true ? ok('proteção do webhook confirmada no /health') : no('webhook não protegido');
    h.operational === true ? ok('canal operacional no início da suíte') : no('canal começou não operacional');
    Array.isArray(h.config?.delayMs) ? ok(`delay declarado: ${h.config.delayMs.join('–')}ms`) : no('delay ausente');
    h.config?.fuso ? ok(`fuso: ${h.config.fuso}`) : no('fuso ausente');
    h.caixaPreta?.capacidade ? ok('resumo da caixa preta no /health') : no('caixa preta ausente do /health');
  }

  /* ---------- 12 · API e dashboard ---------- */
  head('12 · API e dashboard');
  const login = await fetch(`http://localhost:${APP_PORT}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_TEST_PASSWORD })
  });
  login.ok ? ok('login aceito') : no(`login falhou: ${login.status}`);
  const { token } = await login.json();

  (await fetch(`http://localhost:${APP_PORT}/admin/api/triages`)).status === 401
    ? ok('API protegida sem token') : no('API exposta');

  const lista = await (await fetch(`http://localhost:${APP_PORT}/admin/api/triages?testes=1`,
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
  html.includes('Caixa preta') ? ok('painel da caixa preta na página') : no('painel da caixa preta ausente');
  html.includes('WhatsApp desconectado') ? ok('dashboard tem o alarme de desconexão') : no('alarme de desconexão ausente');
  html.includes('qrBanner') && html.includes('Aparelhos conectados')
    ? ok('alarme traz o QR e o passo a passo para reconectar') : no('alarme sem QR/instruções');
  (html.match(/var\(--brand\)/g) || []).length >= 8
    ? ok('vermelho da marca presente em todo o painel') : no('vermelho pouco presente');
  html.includes('SX SEVEN XPERTS') && html.includes('32.794.007/0001-19')
    ? ok('rodapé com assinatura e CNPJ da SX') : no('rodapé da SX ausente');
  html.includes('--sx-lima') && html.includes('--sx-turquesa')
    ? ok('degradê verde-limão → turquesa da SX definido') : no('cores da SX ausentes');

  for (const asset of ['badge.png', 'logo.png', 'favicon.png', 'apple-touch-icon.png']) {
    const r = await fetch(`http://localhost:${APP_PORT}/admin/assets/${asset}`);
    r.ok ? ok(`asset servido: ${asset}`) : no(`asset ${asset}: ${r.status}`);
  }

  /* ---------- 12b · Monitor da conexão ---------- */
  head('12b · Queda de conexão do WhatsApp é detectada e denunciada');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    const saude = async () => (await fetch(`http://localhost:${APP_PORT}/health`)).json();

    let h = await saude();
    h.whatsapp.ok === true ? ok('parte conectado') : no('não partiu conectado');
    h.ready === true ? ok('ready = true com tudo de pé') : no(`ready = ${h.ready}`);

    // Simula a sessão caindo — foi o que aconteceu de verdade em produção.
    statusMock = 'connecting';
    await sleep(2600);                    // MONITOR_SECONDS = 1

    h = await saude();
    h.whatsapp.ok === false
      ? ok('monitor percebeu a queda sozinho')
      : no('/health continuou dizendo que está conectado — era o bug');
    h.ready === false ? ok('ready virou false') : no(`ready = ${h.ready}`);
    h.whatsapp.checkedAt ? ok('registra quando foi a última checagem') : no('sem checkedAt');

    const logTudo = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`, auth)).json();
    const oscilou = (logTudo.eventos || []).find(e => e.event === 'whatsapp.oscilou');
    oscilou ? ok('caixa preta marca a oscilação assim que detecta') : no('oscilação não registrada');
    // A queda vai para o histórico persistente, não só para a caixa preta.
    const { data: gravadas } = await sb.from('connection_events')
      .select('event').eq('instance', TEST_INSTANCE)
      .gte('created_at', new Date(Date.now() - 120_000).toISOString());
    (gravadas || []).some(e => e.event === 'caiu') ? ok('queda gravada no histórico persistente') : no('queda não persistida');

    const st = await (await fetch(`http://localhost:${APP_PORT}/admin/api/status`, auth)).json();
    st.whatsapp?.connected === false ? ok('/status também reflete a queda') : no('/status desatualizado');
    st.whatsapp?.caiuEm ? ok('/status informa desde quando está fora') : no('/status sem caiuEm');

    const h2 = await saude();
    h2.whatsapp?.caiuEm ? ok('/health informa desde quando está fora') : no('/health sem caiuEm');

    // Volta ao normal
    statusMock = 'open';
    await sleep(2600);
    h = await saude();
    h.whatsapp.ok === true ? ok('monitor percebeu a volta') : no('não voltou');
    h.ready === true ? ok('ready voltou para true') : no(`ready = ${h.ready}`);
    const logInfo = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`, auth)).json();
    // Reconexão em segundos é 'piscou'; queda longa seria 'voltou'. Aqui é rápida.
    (logInfo.eventos || []).some(e => e.event === 'whatsapp.piscou' || e.event === 'whatsapp.voltou')
      ? ok('caixa preta registra a reconexão (piscada ou volta)') : no('reconexão não registrada');
  }

  /* ---------- 12c · Conectar pelo dashboard ---------- */
  head('12c · Conectar o WhatsApp pelo próprio dashboard');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } };
    const page = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    page.includes('Conectar / Gerar QR') ? ok('botão "Conectar / Gerar QR" na página') : no('botão de conectar ausente');
    page.includes('btnReiniciar') ? ok('botão de reiniciar a instância') : no('botão de reiniciar ausente');

    // Conectado: não deve devolver QR
    statusMock = 'open';
    let j = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/conectar`, { method:'POST', ...auth })).json();
    j.ok === true ? ok('rota de conectar responde') : no('rota de conectar falhou');
    j.precisaQr === false ? ok('conectado: não pede QR') : no('pediu QR estando conectado');

    // Desconectado: devolve o QR para escanear na tela
    statusMock = 'connecting';
    j = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/conectar`, { method:'POST', ...auth })).json();
    j.precisaQr === true ? ok('desconectado: devolve QR') : no('não devolveu QR');
    j.qr ? ok('QR vem em base64, pronto para renderizar') : no('QR ausente');

    const rr = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/reiniciar`, { method:'POST', ...auth })).json();
    rr.ok === true ? ok('rota de reiniciar a instância responde') : no('reiniciar falhou');

    // Logout: o remédio para "aceita o envio e a mensagem não chega"
    page.includes('btnDesconectar') ? ok('botão "Desconectar e pareear" na página') : no('botão de logout ausente');
    const lo = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/desconectar`, { method:'POST', ...auth })).json();
    lo.ok === true ? ok('rota de logout responde') : no(`logout falhou: ${lo.error}`);
    logouts >= 1 ? ok('chamou o logout na Evolution') : no('não chamou o logout');
    lo.qr ? ok('devolve o QR do novo pareamento') : no('logout sem QR');

    (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/conectar`, { method:'POST' })).status === 401
      ? ok('rotas de conexão exigem token') : no('rotas de conexão expostas');

    statusMock = 'open';
    await sleep(2600);
  }

  /* ---------- 12d · Conexão oficial da Meta ---------- */
  head('12d · Conexão oficial (Meta Cloud API) pelo dashboard');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } };
    const page = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    page.includes('API do WhatsApp (Meta)') ? ok('painel da conexão oficial na página') : no('painel da Meta ausente');
    ['ofNome','ofNumero','ofBusiness','ofToken'].every(id => page.includes(id))
      ? ok('formulário com os 4 campos (nome, número, WABA, token)') : no('campos incompletos');
    page.includes('paga por conversa') ? ok('explica o custo e a troca') : no('não explica a troca');

    // campo faltando → recusa com clareza
    let j = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/oficial`,
      { method:'POST', ...auth, body: JSON.stringify({ instanceName:'x' }) })).json();
    /Preencha/.test(j.error || '') ? ok('recusa dados incompletos dizendo o que falta') : no(`erro inesperado: ${j.error}`);

    // completo → cria com integration WHATSAPP-BUSINESS
    j = await (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/oficial`,
      { method:'POST', ...auth,
        body: JSON.stringify({ instanceName:'ma-oficial', number:'5588981553041',
                               businessId:'123456789', token:'TOKEN-FALSO-DE-TESTE' }) })).json();
    j.ok === true ? ok('cria a conexão oficial') : no(`falhou: ${j.error}`);
    j.proximoPasso?.includes('EVOLUTION_INSTANCE') ? ok('avisa que precisa trocar EVOLUTION_INSTANCE') : no('sem próximo passo');

    const c = criadas[criadas.length - 1] || {};
    c.integration === 'WHATSAPP-BUSINESS' ? ok('integration = WHATSAPP-BUSINESS') : no(`integration = ${c.integration}`);
    c.qrcode === false ? ok('não pede QR (oficial não usa aparelho conectado)') : no('pediu QR');
    c.businessId === '123456789' ? ok('envia o WABA/businessId') : no('businessId errado');

    // o token não pode aparecer na caixa preta
    const log = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`, auth)).json();
    JSON.stringify(log).includes('TOKEN-FALSO-DE-TESTE')
      ? no('TOKEN VAZOU na caixa preta') : ok('token não aparece na caixa preta');

    (await fetch(`http://localhost:${APP_PORT}/admin/api/whatsapp/oficial`, { method:'POST' })).status === 401
      ? ok('rota exige token de acesso') : no('rota exposta');
  }

  /* ---------- 12f · Histórico de conexão que sobrevive a deploy ---------- */
  head('12f · Histórico de quedas persistido no banco');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    const hist = await (await fetch(`http://localhost:${APP_PORT}/admin/api/conexao/historico?dias=7`, auth)).json();

    typeof hist.quedas === 'number' ? ok(`histórico responde (${hist.quedas} queda(s) em 7 dias)`) : no('histórico não respondeu');
    'disponibilidade' in hist ? ok('calcula disponibilidade') : no('sem disponibilidade');
    Array.isArray(hist.eventos) ? ok('traz os eventos do período') : no('sem lista de eventos');

    // A simulação de queda da seção 12b deve ter deixado registro no BANCO.
    const { data: gravados } = await sb.from('connection_events')
      .select('*').eq('instance', TEST_INSTANCE)
      .order('created_at', { ascending: false });
    (gravados || []).some(e => e.event === 'caiu')
      ? ok('a queda simulada ficou gravada no banco (sobrevive a deploy)') : no('queda não foi persistida');
    (gravados || []).some(e => e.event === 'voltou')
      ? ok('a volta também ficou gravada') : no('volta não persistida');

    const page = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    page.includes('Estabilidade da conexão') ? ok('painel de estabilidade na página') : no('painel ausente');
    page.includes('chipsDias') ? ok('filtro 24h / 7 dias / 30 dias') : no('filtro de período ausente');

    (await fetch(`http://localhost:${APP_PORT}/admin/api/conexao/historico`)).status === 401
      ? ok('histórico exige token') : no('histórico exposto');

    // limpa o que a simulação gerou
    await limparEventosTeste();
  }

  /* ---------- 12e · Retomada depois da queda ---------- */
  head('12e · Retoma conversas interrompidas por queda de conexão');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } };
    // P ficou parado no meio do fluxo; Q já foi para a atendente.
    // Isolamento: a retomada em NODE_ENV=test só olha sessões is_test = true.

    await limparTelefones([P, Q]);
    // Ambos com atividade antiga, como se a conexão tivesse caído depois.
    const antigo = new Date(Date.now() - 3600_000).toISOString();
    await sb.from('bot_sessions').insert([
      { phone: P, step: 'ask_vehicle', data: { phone: P, name: 'Ana', intent: 'lavar', category: 'SUV' },
        handed_off: false, is_test: true, updated_at: antigo },
      { phone: Q, step: 'done', data: { phone: Q, name: 'Bruno' },
        handed_off: true, is_test: true, updated_at: antigo }
    ]);

    const antes = sent.length;
    const r = await (await fetch(`http://localhost:${APP_PORT}/admin/api/retomar`,
      { method: 'POST', ...auth, body: JSON.stringify({ horas: 6 }) })).json();

    r.ok === true ? ok('rota de retomada responde') : no(`retomada falhou: ${r.error}`);
    // O monitor automático e o botão usam a mesma fila. Se a volta da conexão
    // já tinha enfileirado a retomada, ele pode enviar P antes de a chamada
    // manual adquirir a fila; o contrato importante é exatamente uma entrega.
    const retomouP = r.telefones?.includes(P) || sent.slice(antes).some(x => x.number === P);
    retomouP ? ok('retomou quem ficou parado no meio do fluxo') : no(`não retomou ${P}`);
    r.telefones?.every(t => t.startsWith(FIXTURE_PREFIX)) ? ok('em teste, só toca sessões desta execução') : no(`vazou para outro escopo: ${r.telefones}`);
    !r.telefones?.includes(Q) ? ok('NÃO incomodou quem já está com a atendente') : no('mandou mensagem para quem já foi atendido');

    const msg = sent.slice(antes).find(x => x.number === P)?.text || '';
    /instabilidade/.test(msg) ? ok('pede desculpa pela instabilidade') : no('sem desculpa', msg);
    /Retomando/.test(msg) ? ok('sinaliza que está retomando') : no('não diz que retoma');
    /modelo do veículo/i.test(msg) ? ok('repete a pergunta PENDENTE (o modelo), não o início') : no('repetiu a pergunta errada', msg);
    !/Bem-vindo/.test(msg) ? ok('não repete as boas-vindas inteiras') : no('repetiu a abertura');

    // Não pode mandar duas vezes para a mesma pessoa
    const antes2 = sent.length;
    const r2 = await (await fetch(`http://localhost:${APP_PORT}/admin/api/retomar`,
      { method: 'POST', ...auth, body: JSON.stringify({ horas: 6 }) })).json();
    sent.slice(antes2).filter(x => x.number === P).length === 0
      ? ok('não repete a retomada para quem já recebeu') : no('mandou a retomada duas vezes');

    const sessP = await sessaoDe(P);
    sessP?.recovered_at ? ok('marca recovered_at na sessão') : no('sem recovered_at');
    sessP?.step === 'ask_vehicle' ? ok('não perdeu o passo do fluxo') : no(`passo virou ${sessP?.step}`);

    // O cliente responde e o fluxo continua de onde estava
    const antes3 = sent.length;
    await diz('Compass', { de: P, pushName: 'Ana' });
    const cont = sent.slice(antes3).find(x => x.number === P)?.text || '';
    /o que você está buscando/.test(cont) ? ok('cliente responde e o fluxo segue para a etapa seguinte') : no('fluxo não seguiu', cont);

    const page = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    page.includes('btnRetomar') ? ok('botão "Retomar conversas" no dashboard') : no('botão de retomada ausente');

    await limparTelefones([P, Q]);
  }

  /* ---------- 12f2 · Auto-correção dos eventos do webhook ---------- */
  head('12f2 · Boot corrige eventos faltando no webhook');
  {
    // A produção ficou com só MESSAGES_UPSERT porque ensureWebhook comparava
    // apenas a URL. Agora confere a lista de eventos também.
    webhookEventos.includes('MESSAGES_UPDATE')
      ? ok('boot adicionou MESSAGES_UPDATE sozinho') : no(`eventos após o boot: ${webhookEventos}`);
    webhookEventos.includes('MESSAGES_UPSERT')
      ? ok('MESSAGES_UPSERT preservado') : no('perdeu MESSAGES_UPSERT');
    !webhookEventos.includes('SEND_MESSAGE')
      ? ok('SEND_MESSAGE segue fora (evitaria loop infinito)') : no('SEND_MESSAGE entrou — causa loop');
    webhookHeaders?.['x-evolution-webhook-secret'] === WEBHOOK_TEST_SECRET
      ? ok('boot configurou o header secreto na Evolution') : no('header secreto não foi sincronizado');
  }

  /* ---------- 12g · Entrega: aceite não é entrega ---------- */
  head('12g · Rastreio de ENTREGA (o que faltava para saber se funciona)');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    await limparTelefones([E]);
    await sb.from('bot_sessions').insert([{ phone: E, step: 'ask_name', data: { phone: E },
                                           handed_off: false, is_test: true }]);

    // O bot responde e o id do WhatsApp tem de ser guardado.
    const antes = sent.length;
    await diz('oi', { de: E });
    const enviada = sent.slice(antes).find(x => x.number === E);
    enviada?.waId ? ok(`envio devolveu o id do WhatsApp (${enviada.waId})`) : no('sem waId no envio');

    const { data: reg } = await escopoMensagemTeste(sb.from('messages').select('wa_id,status'))
      .eq('phone', E).eq('direction','out').order('created_at', { ascending: false }).limit(1);
    reg?.[0]?.wa_id === enviada?.waId ? ok('id gravado na mensagem') : no(`wa_id gravado: ${reg?.[0]?.wa_id}`);
    reg?.[0]?.status === 'PENDING' ? ok('status inicial PENDING (aceito, não entregue)') : no(`status: ${reg?.[0]?.status}`);

    // Chega o ACK: a mensagem promove para entregue.
    await ack(enviada.waId, 'DELIVERY_ACK');
    const { data: dep } = await escopoMensagemTeste(sb.from('messages').select('status,status_at'))
      .eq('wa_id', enviada.waId).limit(1);
    dep?.[0]?.status === 'DELIVERY_ACK' ? ok('ACK de entrega promove o status') : no(`status após ACK: ${dep?.[0]?.status}`);
    dep?.[0]?.status_at ? ok('registra quando confirmou') : no('sem status_at');

    // Leitura também sobe o status.
    await ack(enviada.waId, 'READ');
    const { data: lida } = await escopoMensagemTeste(sb.from('messages').select('status'))
      .eq('wa_id', enviada.waId).limit(1);
    lida?.[0]?.status === 'READ' ? ok('ACK de leitura registrado') : no(`status: ${lida?.[0]?.status}`);

    // ACK atrasado não pode rebaixar READ para SERVER_ACK.
    await ack(enviada.waId, 'SERVER_ACK');
    const { data: monotona } = await escopoMensagemTeste(sb.from('messages').select('status'))
      .eq('wa_id', enviada.waId).limit(1);
    monotona?.[0]?.status === 'READ' ? ok('ACK regressivo não rebaixa o status') : no(`status regrediu: ${monotona?.[0]?.status}`);

    // A Evolution pode publicar a entrega antes de devolver o sendText. O ACK
    // fica persistido e é conciliado assim que a linha de saída nasce.
    earlyAckNext = 'DELIVERY_ACK';
    const antesCorrida = sent.length;
    await diz('Sérgio', { de: E });
    const corrida = sent.slice(antesCorrida).find(x => x.number === E);
    const { data: corridaDb } = await escopoMensagemTeste(sb.from('messages').select('status'))
      .eq('wa_id', corrida?.waId).eq('direction', 'out').limit(1);
    corridaDb?.[0]?.status === 'DELIVERY_ACK'
      ? ok('ACK anterior ao insert é persistido e conciliado')
      : no(`ACK da corrida ficou em ${corridaDb?.[0]?.status}`);

    // ACK de id desconhecido não pode explodir nem alterar o freio.
    const freioAntesDoEstranho = await (await fetch(`http://localhost:${APP_PORT}/admin/api/envio/freio`, auth)).json();
    await ack('NAO-EXISTE-999', 'DELIVERY_ACK');
    const freioDepoisDoEstranho = await (await fetch(`http://localhost:${APP_PORT}/admin/api/envio/freio`, auth)).json();
    freioDepoisDoEstranho.ultimaEntrega === freioAntesDoEstranho.ultimaEntrega
      ? ok('ACK de id desconhecido é ignorado sem alterar o freio')
      : no('ACK desconhecido alterou o freio');

    // ERROR = recusa do WhatsApp, não demora. Precisa ser distinguido.
    const antes2 = sent.length;
    await diz('1', { de: E });
    const seg = sent.slice(antes2).find(x => x.number === E);
    if (seg?.waId) {
      await ack(seg.waId, 'ERROR', { instance: 'outra-instancia' });
      const { data: estrangeira } = await escopoMensagemTeste(sb.from('messages').select('status'))
        .eq('wa_id', seg.waId).limit(1);
      estrangeira?.[0]?.status === 'PENDING'
        ? ok('ACK de outra instância é ignorado') : no(`outra instância alterou para ${estrangeira?.[0]?.status}`);

      await ack(seg.waId, 'ERROR');
      const { data: rej } = await escopoMensagemTeste(sb.from('messages').select('status'))
        .eq('wa_id', seg.waId).limit(1);
      rej?.[0]?.status === 'ERROR' ? ok('ACK de ERROR é registrado') : no(`status: ${rej?.[0]?.status}`);
      const e2 = await (await fetch(`http://localhost:${APP_PORT}/admin/api/entrega?minutos=30`, auth)).json();
      e2.rejeitadas >= 1 ? ok(`resumo conta as rejeitadas (${e2.rejeitadas})`) : no(`rejeitadas: ${e2.rejeitadas}`);
      e2.saudavel === false ? ok('rejeição derruba o veredito de saúde') : no(`saudavel: ${e2.saudavel}`);
    }
    const pagRej = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    pagRej.includes('REJEITADA pelo WhatsApp') ? ok('dashboard mostra "REJEITADA" por mensagem') : no('rótulo de rejeição ausente');
    pagRej.includes('recusa isolada') ? ok('alarme distingue recusa isolada de pane global') : no('alarme não distingue');

    const ent = await (await fetch(`http://localhost:${APP_PORT}/admin/api/entrega?minutos=30`, auth)).json();
    typeof ent.enviadas === 'number' ? ok(`resumo de entrega responde (${ent.entregues}/${ent.enviadas})`) : no('resumo não respondeu');
    'saudavel' in ent ? ok('resumo diz se está saudável (ou null sem dado)') : no('sem veredito');

    const page = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    page.includes('pillEnt') ? ok('pílula de entrega no topo do dashboard') : no('pílula ausente');
    page.includes('PENDING/SERVER_ACK') ? ok('alarme explica aceite sem entrega') : no('alarme ausente');
    page.includes('entregue') ? ok('status por mensagem no fluxo') : no('status por mensagem ausente');

    const logAck = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`, auth)).json();
    (logAck.eventos || []).some(e => e.event === 'webhook.ack')
      ? ok('caixa preta registra os ACKs') : no('ACK não registrado na caixa preta');

    await limparTelefones([E]);
  }

  /* ---------- 12h · Freio de envio: recusa em série para o bot ---------- */
  head('12h · Freio de envio (parar de insistir quando o WhatsApp recusa)');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token }, method: 'POST' };
    const authGet = { headers: { Authorization: 'Bearer ' + token } };
    const FREIO_PHONES = [F, F2, F3, F4];
    const freio = async () => (await (await fetch(`http://localhost:${APP_PORT}/admin/api/envio/freio`, authGet)).json());
    const liberar = () => fetch(`http://localhost:${APP_PORT}/admin/api/envio/liberar`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirmar: 'LIBERAR_MANUALMENTE',
        motivo: 'override controlado da suíte E2E'
      })
    });

    await liberar();
    await limparTelefones(FREIO_PHONES);
    (await freio()).bloqueado === false ? ok('começa com o envio liberado') : no('freio já engatado antes do teste');

    await ack('ACK-EXTERNO-ERROR', 'ERROR');
    const externo = await freio();
    !externo.bloqueado && externo.rejeicoesSeguidas === 0
      ? ok('ERROR desconhecido não entra na contagem')
      : no(`ERROR desconhecido alterou o freio: ${JSON.stringify(externo)}`);

    // Reentrega do mesmo ACK ERROR vale uma recusa, não três.
    const antesPrimeira = sent.length;
    await diz('oi', { de: F });
    const primeira = sent.slice(antesPrimeira).find(x => x.number === F);
    if (primeira?.waId) {
      await ack(primeira.waId, 'ERROR');
      await ack(primeira.waId, 'ERROR');
      await ack(primeira.waId, 'ERROR');
    }
    const duplicada = await freio();
    !duplicada.bloqueado && duplicada.rejeicoesSeguidas === 1
      ? ok('ACK ERROR duplicado conta uma única recusa')
      : no(`ACK duplicado contou errado: ${JSON.stringify(duplicada)}`);

    // A segunda recusa isola somente F. Mesmo acima do limite numérico, um
    // único contato inválido jamais pode silenciar todos os clientes.
    const antesSegunda = sent.length;
    await diz('Sérgio', { de: F });
    const segundaF = sent.slice(antesSegunda).find(x => x.number === F);
    if (segundaF?.waId) await ack(segundaF.waId, 'ERROR');
    const umDestino = await freio();
    !umDestino.bloqueado && umDestino.destinatariosRejeitados === 1
      ? ok('recusas de um único contato não bloqueiam o canal inteiro')
      : no(`um contato bloqueou globalmente: ${JSON.stringify(umDestino)}`);

    const antesIsolado = sent.length;
    await diz('1', { de: F });
    sent.length === antesIsolado
      ? ok('destinatário reincidente é isolado individualmente')
      : no('destinatário com duas recusas continuou recebendo tentativas');

    // Outros contatos continuam; só uma sequência espalhada por três
    // destinatários prova uma pane do canal e engata o freio global.
    for (const telefone of [F2, F3]) {
      const antes = sent.length;
      await diz('oi', { de: telefone });
      const m = sent.slice(antes).find(x => x.number === telefone);
      if (m?.waId) await ack(m.waId, 'ERROR');
    }
    const engatou = (await freio()).bloqueado;
    engatou
      ? ok('recusas consecutivas em 3 destinatários engatam o freio global')
      : no('pane espalhada não engatou o freio');

    const f1 = await freio();
    f1.motivo ? ok(`freio registra o motivo (${String(f1.motivo).slice(0, 40)}…)`) : no('freio sem motivo');
    f1.desde ? ok('freio registra desde quando') : no('freio sem horário');

    if (segundaF?.waId) {
      await ack(segundaF.waId, 'DELIVERY_ACK');
      (await freio()).bloqueado === true
        ? ok('ACK tardio de envio anterior não desfaz a pane persistida')
        : no('ACK antigo liberou o freio global');
    }

    if (primeira?.waId) {
      await ack(primeira.waId, 'DELIVERY_ACK', { instance: 'outra-instancia' });
      (await freio()).bloqueado === true
        ? ok('entrega de outra instância não libera o freio') : no('outra instância liberou o freio');
    }

    // Com o freio engatado o bot NÃO pode enviar mais nada.
    const antesBloq = sent.length;
    await diz('e agora?', { de: F });
    sent.length === antesBloq ? ok('com o freio engatado o bot não envia') : no('bot enviou com o freio engatado');

    const { data: bloq } = await escopoMensagemTeste(sb.from('messages').select('status,body'))
      .eq('phone', F).eq('direction','out').in('status', ['BLOQUEADO', 'BLOQUEADO_DESTINO']).limit(1);
    bloq?.length ? ok(`a resposta que não saiu fica registrada como ${bloq[0].status}`) : no('resposta bloqueada não registrada');

    const ent = await (await fetch(`http://localhost:${APP_PORT}/admin/api/entrega?minutos=30`, authGet)).json();
    typeof ent.naoEnviadas === 'number' ? ok(`resumo separa as não enviadas (${ent.naoEnviadas})`) : no('resumo não separa BLOQUEADO');
    ent.freio?.bloqueado === true ? ok('resumo de entrega expõe o freio') : no('resumo sem o freio');

    const saude = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
    saude.freio?.bloqueado === true ? ok('/health expõe o freio engatado') : no('/health sem o freio');
    saude.operational === false ? ok('/health não produz falso verde operacional') : no('/health operacional com envio bloqueado');

    const logF = await (await fetch(`http://localhost:${APP_PORT}/admin/api/log?limit=400`, authGet)).json();
    const nomes = new Set((logF.eventos || []).map(e => e.event));
    nomes.has('freio.engatado') ? ok('caixa preta registra o freio engatando') : no('freio ausente da caixa preta');
    (nomes.has('freio.naoEnviou') || nomes.has('freio.destinoNaoEnviou'))
      ? ok('caixa preta registra a resposta que não saiu') : no('não registra a resposta engolida');

    // A liberação manual é persistida e religa o canal para outros contatos.
    await liberar();
    (await freio()).bloqueado === false ? ok('liberação manual religa o envio') : no('liberação manual não funcionou');

    const antesVolta = sent.length;
    await diz('voltei', { de: F4 });
    sent.length > antesVolta ? ok('depois de liberado o bot volta a responder') : no('bot continua mudo após liberar');

    await fetch(`http://localhost:${APP_PORT}/admin/api/envio/bloquear`, {
      ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'teste' })
    });
    (await freio()).bloqueado === true ? ok('bloqueio manual disponível') : no('bloqueio manual não funcionou');

    const ultima = sent.slice(antesVolta).find(x => x.number === F4);
    if (ultima?.waId) {
      await ack(ultima.waId, 'DELIVERY_ACK');
      (await freio()).bloqueado === true
        ? ok('ACK tardio anterior ao bloqueio não solta o freio')
        : no('mensagem antiga liberou o freio indevidamente');
    }

    const pag = await (await fetch(`http://localhost:${APP_PORT}/admin`)).text();
    pag.includes('Testar envio') ? ok('dashboard tem o teste de envio') : no('teste de envio ausente');
    pag.includes('Liberar envio') ? ok('dashboard tem a liberação do envio') : no('liberação ausente');
    pag.includes('CANAL BLOQUEADO') ? ok('dashboard mostra o envio bloqueado') : no('aviso de bloqueio ausente');
    pag.includes('NÃO ENVIADA') ? ok('rótulo da mensagem não enviada na página') : no('rótulo ausente');

    // Sonda: um envio só, com espera do ACK real. A request fica aberta
    // enquanto o webhook de entrega chega em paralelo.
    const antesSonda = sent.length;
    const pedidoSonda = fetch(`http://localhost:${APP_PORT}/admin/api/envio/sonda`, {
      ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: F, texto: 'sonda de teste' })
    });
    let enviadaSonda = null;
    for (let i = 0; i < 30 && !enviadaSonda; i++) {
      enviadaSonda = sent.slice(antesSonda).find(x => x.number === F) || null;
      if (!enviadaSonda) await sleep(50);
    }
    if (enviadaSonda?.waId) await ack(enviadaSonda.waId, 'DELIVERY_ACK');
    const sonda = await (await pedidoSonda).json();
    sonda.waId ? ok('sonda envia e devolve o id') : no('sonda não enviou');
    sonda.entregue === true ? ok('sonda espera e confirma a entrega real') : no(`sonda: ${JSON.stringify(sonda)}`);
    (await freio()).bloqueado === false
      ? ok('sonda entregue libera o freio de forma persistida') : no('sonda entregue não liberou o freio');

    const ruim = await fetch(`http://localhost:${APP_PORT}/admin/api/envio/sonda`, {
      ...auth, headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: '123' })
    });
    ruim.status === 400 ? ok('sonda recusa número inválido') : no(`sonda aceitou número inválido (${ruim.status})`);

    // Testa o cálculo de boot de forma pura. A versão anterior inseria linhas
    // `is_test=false` e timestamps futuros no Supabase compartilhado.
    const { calcularVereditoEnvio } = await import('../src/database.js');
    const baseVeredito = Date.now();
    const linha = (id, phone, status, ms) => ({
      id, phone, status,
      created_at: new Date(baseVeredito + ms).toISOString(),
      status_at: new Date(baseVeredito + ms).toISOString()
    });
    let v = calcularVereditoEnvio([
      linha(1, F, 'ERROR', 0), linha(2, F, 'ERROR', 1), linha(3, F, 'ERROR', 2)
    ]);
    v?.rejeicoesSeguidas === 3 && v?.destinatariosRejeitados?.length === 1
      ? ok('boot distingue sequência de um contato de pane global')
      : no(`veredito isolado: ${JSON.stringify(v)}`);

    v = calcularVereditoEnvio([
      linha(1, F, 'ERROR', 0), linha(2, F2, 'ERROR', 1),
      linha(3, F3, 'ERROR', 2), linha(4, F4, 'DELIVERY_ACK', 3)
    ]);
    v?.recusado === false && v?.rejeicoesSeguidas === 0
      ? ok('entrega posterior vence recusas anteriores no boot')
      : no(`veredito de entrega: ${JSON.stringify(v)}`);

    v = calcularVereditoEnvio([
      linha(1, F, 'DELIVERY_ACK', 0), linha(2, '__canal__', 'MANUAL_BLOCK', 1)
    ]);
    v?.bloqueioManual === true
      ? ok('bloqueio manual persistido vence ACK tardio de mensagem antiga')
      : no(`veredito manual: ${JSON.stringify(v)}`);

    await liberar();
    await limparTelefones(FREIO_PHONES);
  }

  /* ---------- 13 · Produção mostra só conversa real ---------- */
  head('13 · Solicitações: só conversa real, com filtro de período');
  {
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    const get = async q => (await fetch(`http://localhost:${APP_PORT}/admin/api/${q}`, auth)).json();

    // O banco pode ter atendimento real de verdade. Os asserts comparam com o
    // conjunto de números da suíte, nunca com "zero".
    const NOSSOS = new Set([A, B, C, D]);
    const nossos = arr => arr.filter(r => NOSSOS.has(r.phone));

    const comTestes = await get('triages?testes=1');
    const nossasTriagens = nossos(comTestes);
    nossasTriagens.length ? ok(`?testes=1 traz as ${nossasTriagens.length} triagens da suíte`) : no('?testes=1 não trouxe as triagens da suíte');
    nossasTriagens.every(r => r.is_test === true)
      ? ok('todas marcadas como is_test') : no('alguma triagem da suíte não foi marcada');

    const padrao = await get('triages');
    nossos(padrao).length === 0
      ? ok('padrão esconde testes — em produção só atendimento real aparece')
      : no(`padrão vazou ${nossos(padrao).length} linha(s) de teste`);
    padrao.every(r => r.is_test === false) ? ok('nenhuma linha visível está marcada como teste') : no('linha de teste visível no padrão');

    const st = await get('stats');
    st.testes >= nossasTriagens.length ? ok(`stats informa ${st.testes} testes ocultos`) : no(`stats.testes = ${st.testes}`);
    st.total === padrao.length ? ok(`stats.total (${st.total}) bate com a lista visível`) : no(`stats.total ${st.total} ≠ lista ${padrao.length}`);

    const msgs = await get('messages');
    nossos(msgs).length === 0 ? ok('fluxo de mensagens também esconde testes') : no(`${nossos(msgs).length} mensagens de teste visíveis`);

    // Período
    const hoje = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const depois = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);

    const doDia = nossos(await get(`triages?testes=1&de=${hoje}&ate=${hoje}`));
    doDia.length === nossasTriagens.length ? ok('filtro "hoje" inclui o dia inteiro') : no(`hoje: ${doDia.length}/${nossasTriagens.length}`);

    const futuro = await get(`triages?testes=1&de=${amanha}&ate=${depois}`);
    nossos(futuro).length === 0 ? ok('período futuro devolve vazio') : no(`período futuro devolveu ${nossos(futuro).length}`);

    // Fuso: uma mensagem das 22h em Sobral (UTC-3) é gravada como 01:00Z do dia
    // seguinte. Comparar a data local contra limites UTC a jogava no dia errado.
    {
      await limparTabelaTeste('triages', [TZ_PHONE]);

      // 22:00 locais de hoje = 01:00Z de amanhã.
      const hojeLocal = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
      const instante = new Date(hojeLocal + 'T22:00:00-03:00').toISOString();

      await sb.from('triages').insert([{
        phone: TZ_PHONE, name: 'Noite', is_test: true, status: 'pending',
        origin: 'chatbot', created_at: instante
      }]);

      const noDia = await get(`triages?testes=1&de=${hojeLocal}&ate=${hojeLocal}`);
      noDia.some(r => r.phone === TZ_PHONE)
        ? ok(`mensagem das 22h fica no dia local correto (${hojeLocal}, gravada ${instante.slice(11,16)}Z)`)
        : no(`22h caiu fora do dia local ${hojeLocal}`);

      const diaSeguinte = await get(`triages?testes=1&de=${somaUm(hojeLocal)}&ate=${somaUm(hojeLocal)}`);
      diaSeguinte.some(r => r.phone === TZ_PHONE)
        ? no('22h vazou para o dia seguinte') : ok('22h não vaza para o dia seguinte');

      await limparTabelaTeste('triages', [TZ_PHONE]);
    }

    const invalida = await get('triages?testes=1&de=nao-e-data');
    Array.isArray(invalida) ? ok('data inválida é ignorada, não quebra a rota') : no('data inválida quebrou a rota');

    const sessoesAntes = (await sb.from('bot_sessions').select('phone,is_test')).data || [];
    const nossasSessoes = sessoesAntes.filter(r => NOSSOS.has(r.phone));
    nossasSessoes.length && nossasSessoes.every(r => r.is_test === true)
      ? ok(`sessões da suíte marcadas como teste (${nossasSessoes.length})`)
      : no(`sessões não marcadas: ${JSON.stringify(nossasSessoes)}`);

    /* ---------- purge: apaga as fixtures, por último ---------- */
    const reaisAntes = (await sb.from('triages').select('phone').eq('is_test', false)).data?.length ?? 0;

    const del = await (await fetch(`http://localhost:${APP_PORT}/admin/api/testes`,
      { method: 'DELETE', ...auth })).json();
    del.ok ? ok('rota de limpeza respondeu') : no('limpeza falhou');
    del.apagados?.triages >= nossasTriagens.length
      ? ok(`apagou ${del.apagados.triages} triagens, ${del.apagados.messages} mensagens, ${del.apagados.bot_sessions} sessões`)
      : no(`apagou pouco: ${JSON.stringify(del.apagados)}`);
    del.apagados?.bot_sessions >= nossasSessoes.length
      ? ok('sessões de teste também foram apagadas') : no(`sessões apagadas: ${del.apagados?.bot_sessions}`);

    const nossosPhones = FIXTURE_PHONES.filter(p => /^\d+$/.test(p));
    const sobrouTeste = (await sb.from('triages').select('phone')
      .eq('is_test', true).in('phone', nossosPhones)).data?.length ?? 0;
    sobrouTeste === 0
      ? ok('nenhuma fixture desta execução sobrou no banco')
      : no(`sobraram ${sobrouTeste} fixtures desta execução`);

    const reaisDepois = (await sb.from('triages').select('phone').eq('is_test', false)).data?.length ?? 0;
    reaisDepois === reaisAntes
      ? ok(`atendimentos reais intactos (${reaisDepois}) — a limpeza não os toca`)
      : no(`real perdido: ${reaisAntes} → ${reaisDepois}`);
  }

} catch (err) {
  no('exceção no teste: ' + err.message);
  console.error(err);
} finally {
  // Sempre encerra o app antes de limpar, para o monitor não recriar linhas
  // depois do DELETE. Falhas de boot também passam por este caminho.
  if (app && app.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { app.kill('SIGKILL'); resolve(); }, 1500);
      app.once('exit', () => { clearTimeout(timer); resolve(); });
      app.kill('SIGTERM');
    });
  }
  try {
    await limpar();
    await limparEventosTeste();
  } catch (e) {
    no('cleanup seguro falhou', e.message);
  }
  if (mockServer?.listening) await new Promise(resolve => mockServer.close(resolve));
  console.log('\n' + '─'.repeat(58));
  console.log(fail === 0
    ? `\x1b[32m\x1b[1m✔ ${pass} verificações passaram.\x1b[0m`
    : `\x1b[31m\x1b[1m✖ ${fail} falha(s) · ${pass} ok\x1b[0m`);
  console.log('─'.repeat(58) + '\n');
  if (fail) console.log('Log do app (fim):\n' + appLog.split('\n').slice(-25).join('\n'));
  process.exitCode = fail ? 1 : 0;
}

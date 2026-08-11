#!/usr/bin/env node
/**
 * Carga local segura: Evolution falsa + Supabase de teste.
 * Nenhuma mensagem real de WhatsApp é enviada.
 *
 * Uso recomendado:
 *   SUPABASE_TEST_URL=... SUPABASE_TEST_SERVICE_KEY=... npm run carga -- 40
 *
 * Banco compartilhado exige opt-in explícito:
 *   CARGA_ALLOW_SHARED_SUPABASE=I_UNDERSTAND npm run carga -- 20
 */
import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const N = Math.min(100, Math.max(1, Number(process.argv[2]) || 40));
const MOCK_PORT = 4210;
const APP_PORT = 4211;
const RUN = crypto.randomBytes(6).toString('hex');
const INSTANCE = `carga-${RUN}-${process.pid}`;
const WEBHOOK_SECRET = `carga-webhook-${RUN}`;
const ADMIN_PASSWORD = `carga-admin-${RUN}`;
const PHONE_SEED = (BigInt(`0x${RUN}`) % 10_000_000_000n).toString().padStart(10, '0');
const phone = i => `000${PHONE_SEED}${String(i).padStart(4, '0')}`;
const telefones = Array.from({ length: N }, (_, i) => phone(i + 1));
const RACE_PHONE = phone(9999);
const TEST_PHONES = [...telefones, RACE_PHONE];

const SUPABASE_URL = process.env.SUPABASE_TEST_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const compartilhado = !process.env.SUPABASE_TEST_URL || !process.env.SUPABASE_TEST_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Carga exige SUPABASE_TEST_URL e SUPABASE_TEST_SERVICE_KEY');
}
if (compartilhado && process.env.CARGA_ALLOW_SHARED_SUPABASE !== 'I_UNDERSTAND') {
  throw new Error(
    'Carga bloqueada: use Supabase de teste ou confirme CARGA_ALLOW_SHARED_SUPABASE=I_UNDERSTAND'
  );
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const { data: schemaVersion, error: schemaError } = await sb.rpc('chatbot_schema_version');
if (schemaError || Number(schemaVersion) !== 2026080801) {
  throw new Error(`Carga exige setup.sql 2026080801: ${schemaError?.message || schemaVersion}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmt = n => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const enviadas = [];
let pico = 0;
let mockServer = null;
let child = null;
let childLog = '';
let falhou = false;

async function limpar() {
  for (const tabela of ['messages', 'triages', 'bot_sessions']) {
    let q = sb.from(tabela).delete().in('phone', TEST_PHONES).eq('is_test', true);
    if (tabela === 'messages') q = q.eq('instance', INSTANCE);
    const { error } = await q;
    if (error) throw new Error(`limpeza ${tabela}: ${error.message}`);
  }
}

async function waitReady() {
  let ultimo = null;
  for (let i = 0; i < 100; i++) {
    try {
      ultimo = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
      if (ultimo.ready) return ultimo;
    } catch {}
    await sleep(250);
  }
  throw new Error(`app não ficou ready: ${JSON.stringify(ultimo)}\n${childLog.slice(-2000)}`);
}

async function quiesce(timeoutMs = 120_000) {
  const fim = Date.now() + timeoutMs;
  await sleep(80);
  while (Date.now() < fim) {
    const health = await (await fetch(`http://localhost:${APP_PORT}/health`)).json();
    pico = Math.max(pico, Number(health.inflight) || 0);
    if (!health.inflight && !health.filasPorTelefone) {
      await sleep(120);
      return;
    }
    await sleep(60);
  }
  throw new Error('processamento não drenou no tempo esperado');
}

async function post(phone_, texto, id = crypto.randomUUID()) {
  const response = await fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-evolution-webhook-secret': WEBHOOK_SECRET },
    body: JSON.stringify({
      event: 'messages.upsert',
      instance: INSTANCE,
      data: {
        key: { remoteJid: `${phone_}@s.whatsapp.net`, fromMe: false, id },
        pushName: 'Carga',
        message: { conversation: texto },
        messageType: 'conversation',
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    })
  });
  if (!response.ok) throw new Error(`webhook ${response.status}: ${await response.text()}`);
}

try {
  const mock = express();
  mock.use(express.json());
  let webhook = {
    enabled: true,
    url: `http://localhost:${APP_PORT}/webhook/messages`,
    events: ['MESSAGES_UPSERT'],
    headers: null
  };
  mock.get('/', (_req, res) => res.json({ version: '2.3.7-carga' }));
  mock.get('/instance/fetchInstances', (_req, res) => res.json([{
    name: INSTANCE,
    connectionStatus: 'open',
    ownerJid: '00000000000000000@s.whatsapp.net',
    profileName: 'Carga (mock)',
    token: 'carga-evolution-key'
  }]));
  mock.post('/chat/sendPresence/:instance', (_req, res) => res.json({ ok: true }));
  mock.post('/message/sendText/:instance', (req, res) => {
    const waId = `${INSTANCE}-OUT-${enviadas.length + 1}`;
    enviadas.push({ number: req.body.number, text: req.body.text, at: Date.now(), waId });
    res.json({ key: { id: waId }, status: 'PENDING' });
    setTimeout(() => {
      fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-evolution-webhook-secret': WEBHOOK_SECRET },
        body: JSON.stringify({
          event: 'messages.update', instance: INSTANCE,
          data: { keyId: waId, status: 'DELIVERY_ACK' }
        })
      }).catch(() => {});
    }, 15);
  });
  mock.get('/webhook/find/:instance', (_req, res) => res.json(webhook));
  mock.post('/webhook/set/:instance', (req, res) => {
    webhook = { ...webhook, ...(req.body.webhook || {}) };
    res.json(webhook);
  });

  mockServer = await new Promise((resolve, reject) => {
    const server = mock.listen(MOCK_PORT, () => resolve(server));
    server.once('error', reject);
  });

  child = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY: SUPABASE_KEY,
      EVOLUTION_API_URL: `http://localhost:${MOCK_PORT}`,
      EVOLUTION_API_KEY: 'carga-evolution-key',
      EVOLUTION_INSTANCE: INSTANCE,
      EVOLUTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ADMIN_PASSWORD,
      PORT: String(APP_PORT),
      ALT_PORT: String(APP_PORT),
      PUBLIC_URL: `http://localhost:${APP_PORT}`,
      REPLY_DELAY_MIN_MS: '0',
      REPLY_DELAY_MAX_MS: '0',
      KEEPALIVE_HOURS: '0',
      MONITOR_SECONDS: '1',
      TEST_PHONES: TEST_PHONES.join(','),
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { childLog += data; });
  child.stderr.on('data', data => { childLog += data; });
  child.on('error', error => { childLog += `\n[spawn] ${error.message}`; });

  await waitReady();
  await limpar();
  console.log(`\n\x1b[1m═══ CARGA SEGURA · ${N} conversas ═══\x1b[0m`);

  const roteiro = ['oi', 'Sérgio', '1', '3', 'Jeep Compass', '1', '2', '1', '3', '1'];
  const inicio = Date.now();
  for (const texto of roteiro) {
    await Promise.all(telefones.map(p => post(p, texto)));
    await quiesce();
  }
  const total = Date.now() - inicio;
  const totalEntradas = N * roteiro.length;

  const { data: triagens, error: triError } = await sb.from('triages')
    .select('phone,name,category,vehicle,service,level,period,date_pref')
    .in('phone', telefones).eq('is_test', true);
  if (triError) throw triError;
  const completas = (triagens || []).filter(t =>
    t.category && t.vehicle && t.service && t.level && t.period && t.date_pref
  );
  const duplicadas = (triagens || []).length - new Set((triagens || []).map(t => t.phone)).size;

  console.log(`  duração             ${fmt(total / 1000)} s`);
  console.log(`  vazão               ${fmt(totalEntradas / (total / 1000))} mensagens/s`);
  console.log(`  pico em voo         ${pico}`);
  console.log(`  triagens            ${triagens?.length || 0}/${N}`);
  console.log(`  contexto completo   ${completas.length}/${N}`);
  console.log(`  duplicadas          ${duplicadas}`);

  console.log('\n\x1b[1mCorrida no mesmo telefone\x1b[0m');
  await Promise.all([
    post(RACE_PHONE, 'oi', `${RUN}-race-1`),
    post(RACE_PHONE, 'Sérgio', `${RUN}-race-2`)
  ]);
  await quiesce();
  const { data: sessao, error: sessaoError } = await sb.from('bot_sessions')
    .select('step,data').eq('phone', RACE_PHONE).eq('is_test', true).maybeSingle();
  if (sessaoError) throw sessaoError;
  console.log(`  passo final         ${sessao?.step || '—'}`);
  console.log(`  nome capturado      ${sessao?.data?.name || '—'}`);

  if ((triagens?.length || 0) !== N || completas.length !== N || duplicadas !== 0) {
    throw new Error('integridade sob carga fora do esperado');
  }
  console.log('\n  \x1b[32m✔ carga concluída sem enviar WhatsApp real\x1b[0m');
} catch (error) {
  falhou = true;
  console.error(`\n\x1b[31m✖ carga falhou:\x1b[0m ${error.message}`);
  if (childLog) console.error(childLog.split('\n').slice(-20).join('\n'));
} finally {
  try { await limpar(); } catch (error) { falhou = true; console.error(`limpeza: ${error.message}`); }
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(5000).then(() => { if (child.exitCode == null) child.kill('SIGKILL'); })
    ]);
  }
  if (mockServer) await new Promise(resolve => mockServer.close(resolve));
  process.exitCode = falhou ? 1 : 0;
}

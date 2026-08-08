#!/usr/bin/env node
/**
 * Teste de carga e de concorrência.
 *
 * Sobe uma Evolution FALSA (nenhuma mensagem real sai) e roda o app de verdade
 * contra o Supabase de verdade, com o delay humanizado desligado para medir o
 * custo do sistema e não o da pausa proposital.
 *
 * Mede duas coisas diferentes:
 *   1. VAZÃO — N conversas simultâneas percorrendo o fluxo inteiro
 *   2. CORRIDA — duas mensagens do MESMO número chegando juntas
 *
 * A segunda é a que importa: cliente que digita rápido manda duas mensagens
 * antes da primeira ser processada.
 *
 *   node scripts/carga.js [conversas]
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const N = Number(process.argv[2]) || 40;
const MOCK_PORT = 4210;
const APP_PORT = 4211;
const BASE = 5588100000000;

const enviadas = [];
let pico = 0, emVoo = 0;

const mock = express();
mock.use(express.json());
mock.get('/', (_q, r) => r.json({ version: 'carga' }));
mock.get('/instance/fetchInstances', (_q, r) => r.json([{
  name: '3041', connectionStatus: 'open', ownerJid: '558881553041@s.whatsapp.net', profileName: 'carga'
}]));
mock.post('/chat/sendPresence/:i', (_q, r) => r.json({ ok: true }));
mock.post('/message/sendText/:i', (q, r) => {
  enviadas.push({ number: q.body.number, text: q.body.text, at: Date.now() });
  r.json({ key: { id: 'M' + enviadas.length } });
});
mock.get('/webhook/find/:i', (_q, r) => r.json({ enabled: true, url: `http://localhost:${APP_PORT}/webhook/messages`, events: ['MESSAGES_UPSERT'] }));
mock.post('/webhook/set/:i', (q, r) => r.json({ ...q.body.webhook }));
const mockServer = mock.listen(MOCK_PORT);

const telefones = Array.from({ length: N }, (_, i) => String(BASE + i));

const app = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    EVOLUTION_API_URL: `http://localhost:${MOCK_PORT}`,
    PORT: String(APP_PORT), ALT_PORT: String(APP_PORT),
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    REPLY_DELAY_MIN_MS: '0', REPLY_DELAY_MAX_MS: '0',   // mede o sistema, não a pausa
    KEEPALIVE_HOURS: '0', NODE_ENV: 'test',
    TEST_PHONES: telefones.join(',')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
app.stdout.on('data', d => { log += d; });
app.stderr.on('data', d => { log += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sb = createClient(process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY, { auth: { persistSession: false } });

async function subiu() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${APP_PORT}/health`)).ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

async function inflight() {
  try { return (await (await fetch(`http://localhost:${APP_PORT}/health`)).json()).inflight; }
  catch { return -1; }
}

async function quiesce(limite = 120000) {
  const fim = Date.now() + limite;
  await sleep(80);
  while (Date.now() < fim) {
    const n = await inflight();
    if (n > pico) pico = n;
    if (n === 0) { await sleep(150); return true; }
    await sleep(60);
  }
  return false;
}

function post(phone, texto, id) {
  return fetch(`http://localhost:${APP_PORT}/webhook/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'messages.upsert', instance: '3041',
      data: {
        key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: id || `${phone}-${Math.random().toString(36).slice(2, 8)}` },
        pushName: 'Carga', message: { conversation: texto },
        messageType: 'conversation', messageTimestamp: Math.floor(Date.now() / 1000)
      }
    })
  });
}

async function limpar() {
  for (const t of ['messages', 'triages', 'bot_sessions']) {
    await sb.from(t).delete().in('phone', telefones);
  }
}

const fmt = n => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

try {
  console.log(`\n\x1b[1m═══ CARGA · ${N} conversas simultâneas ═══\x1b[0m`);
  if (!await subiu()) { console.error('app não subiu:\n' + log); process.exit(1); }
  await limpar();

  /* ---------------- 1 · Vazão ---------------- */
  // Percurso: oi → nome → intenção → categoria → modelo → serviço → nível → período → data → confirma
  const roteiro = ['oi', 'Sérgio', '1', '3', 'Jeep Compass', '1', '2', '1', '3', '1'];

  console.log(`\n\x1b[1m1 · Vazão\x1b[0m`);
  console.log(`  ${roteiro.length} mensagens por conversa · ${N * roteiro.length} mensagens no total`);

  const t0 = Date.now();
  const marcos = [];

  for (let passo = 0; passo < roteiro.length; passo++) {
    const tp = Date.now();
    // Todas as conversas mandam a mensagem do passo ao mesmo tempo.
    await Promise.all(telefones.map(p => post(p, roteiro[passo])));
    const ok = await quiesce();
    marcos.push({ passo: passo + 1, texto: roteiro[passo], ms: Date.now() - tp, ok });
    if (!ok) { console.log(`  \x1b[31mnão drenou no passo ${passo + 1}\x1b[0m`); break; }
  }

  const total = Date.now() - t0;
  const msgs = N * roteiro.length;

  for (const m of marcos) {
    const porMsg = m.ms / N;
    console.log(`  passo ${String(m.passo).padStart(2)} "${m.texto.slice(0, 14).padEnd(14)}" ${String(m.ms).padStart(6)} ms · ${fmt(porMsg)} ms/conversa`);
  }

  console.log(`\n  total            ${fmt(total / 1000)} s`);
  console.log(`  vazão            ${fmt(msgs / (total / 1000))} mensagens/s`);
  console.log(`  por mensagem     ${fmt(total / msgs)} ms`);
  console.log(`  pico simultâneo  ${pico} em processamento`);

  /* ---------------- 2 · Integridade ---------------- */
  console.log(`\n\x1b[1m2 · Integridade sob carga\x1b[0m`);
  const { data: tri } = await sb.from('triages').select('phone,name,category,vehicle,service,level,period,date_pref').in('phone', telefones);
  const completas = (tri || []).filter(t => t.category && t.vehicle && t.service && t.level && t.period && t.date_pref);

  console.log(`  triagens gravadas       ${tri?.length ?? 0}/${N}`);
  console.log(`  com contexto completo   ${completas.length}/${N}`);
  const dup = (tri || []).length - new Set((tri || []).map(t => t.phone)).size;
  console.log(`  duplicadas              ${dup}`);

  const respostasPorConversa = telefones.map(p => enviadas.filter(e => e.number === p).length);
  const min = Math.min(...respostasPorConversa), max = Math.max(...respostasPorConversa);
  console.log(`  respostas por conversa  min ${min} · max ${max} (esperado ${roteiro.length})`);

  /* ---------------- 3 · Corrida no mesmo número ---------------- */
  console.log(`\n\x1b[1m3 · Corrida: duas mensagens do mesmo número ao mesmo tempo\x1b[0m`);
  const R = '5588199999901';
  await sb.from('triages').delete().eq('phone', R);
  await sb.from('bot_sessions').delete().eq('phone', R);
  await sb.from('messages').delete().eq('phone', R);

  const antes = enviadas.length;
  // Cliente digita rápido: "oi" e o nome saem juntos, sem esperar a resposta.
  await Promise.all([post(R, 'oi', 'race-1'), post(R, 'Sérgio', 'race-2')]);
  await quiesce();

  const respostas = enviadas.slice(antes).filter(e => e.number === R);
  const sess = (await sb.from('bot_sessions').select('*').eq('phone', R)).data?.[0];

  console.log(`  respostas enviadas      ${respostas.length}`);
  respostas.forEach((r, i) => console.log(`    ${i + 1}. ${r.text.split('\n')[0].slice(0, 62)}`));
  console.log(`  passo final da sessão   ${sess?.step}`);
  console.log(`  nome capturado          ${sess?.data?.name ?? '(nenhum)'}`);

  const perguntouNomeDuasVezes = respostas.filter(r => /qual é o seu nome/i.test(r.text)).length > 1;
  const avancou = sess?.step === 'ask_intent' || sess?.data?.name;

  if (perguntouNomeDuasVezes) console.log(`  \x1b[31m✖ perguntou o nome duas vezes — corrida confirmada\x1b[0m`);
  else if (!avancou) console.log(`  \x1b[31m✖ perdeu a segunda mensagem — corrida confirmada\x1b[0m`);
  else console.log(`  \x1b[32m✔ serializou corretamente\x1b[0m`);

  await sb.from('triages').delete().eq('phone', R);
  await sb.from('bot_sessions').delete().eq('phone', R);
  await sb.from('messages').delete().eq('phone', R);

  /* ---------------- 4 · Volume gerado ---------------- */
  console.log(`\n\x1b[1m4 · Volume de dados por conversa\x1b[0m`);
  const { data: msgsDb } = await sb.from('messages').select('body').in('phone', telefones);
  const bytes = (msgsDb || []).reduce((a, m) => a + Buffer.byteLength(m.body || '', 'utf8'), 0);
  console.log(`  mensagens no banco      ${msgsDb?.length ?? 0} (${fmt((msgsDb?.length ?? 0) / N)} por conversa)`);
  console.log(`  texto armazenado        ${fmt(bytes / 1024)} KB (${fmt(bytes / N / 1024)} KB por conversa)`);
  console.log(`  projeção 100/dia        ${fmt(bytes / N * 100 * 30 / 1048576)} MB/mês só de mensagens`);

} catch (e) {
  console.error('\nfalhou:', e.message);
  console.error(log.split('\n').slice(-15).join('\n'));
} finally {
  await limpar();
  app.kill('SIGKILL');
  mockServer.close();
  console.log('');
  process.exit(0);
}

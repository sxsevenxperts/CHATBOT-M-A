#!/usr/bin/env node
/**
 * Diagnóstico de 60 segundos. Diz exatamente o que está quebrado e como
 * consertar — em vez de um guia de markdown que ninguém consegue seguir.
 *
 *   npm run doctor
 */
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const ok = m => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31m✖\x1b[0m ${m}`); if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`); fails++; };
const warn = (m, fix) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`); };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

let fails = 0;

/* ---------- 1. Variáveis ---------- */
head('1 · Variáveis de ambiente');

const REQ = ['SUPABASE_URL', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'];
for (const k of REQ) {
  process.env[k] ? ok(`${k} definida`) : bad(`${k} FALTANDO`, `adicione ${k} no .env / nas variáveis do EasyPanel`);
}

const supaKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
supaKey
  ? ok(process.env.SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY definida (ideal)' : 'SUPABASE_KEY definida (anon — prefira a service_role)')
  : bad('Nenhuma chave do Supabase', 'defina SUPABASE_SERVICE_KEY');

const rawEvo = process.env.EVOLUTION_API_URL || '';
if (/\/manager\/?$/i.test(rawEvo)) {
  warn('EVOLUTION_API_URL termina em /manager', 'remova o /manager — é o frontend, não a API (o código corrige, mas ajuste o .env)');
} else if (rawEvo) {
  ok('EVOLUTION_API_URL sem /manager');
}

if (!process.env.PUBLIC_URL) warn('PUBLIC_URL não definida', 'sem ela o webhook não se aponta sozinho no boot');
else if (/:\d+$/.test(process.env.PUBLIC_URL)) bad('PUBLIC_URL com porta', 'use https://dominio (sem :3000 — o HTTPS público atende na 443)');
else ok(`PUBLIC_URL = ${process.env.PUBLIC_URL}`);

if (!process.env.ADMIN_PASSWORD) warn('ADMIN_PASSWORD não definida', 'o dashboard ficará com a senha padrão "admin"');

/* ---------- 2. Supabase ---------- */
head('2 · Supabase');

if (process.env.SUPABASE_URL && supaKey) {
  const sb = createClient(process.env.SUPABASE_URL, supaKey, { auth: { persistSession: false } });
  for (const t of ['triages', 'bot_sessions', 'messages']) {
    const { error, count } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) bad(`tabela "${t}": ${error.message}`, 'rode o setup.sql no SQL Editor do Supabase');
    else ok(`tabela "${t}" acessível (${count ?? 0} registros)`);
  }

  const COLUNAS = 'subject,seen,intent,category,vehicle,service,need,level,period,date_pref,origin,recommended';
  const { error: colErr } = await sb.from('triages').select(COLUNAS).limit(1);
  if (colErr) bad(`colunas do contexto ausentes: ${colErr.message}`, 'rode o setup.sql novamente (ele é idempotente)');
  else ok(`colunas do contexto presentes (${COLUNAS.split(',').length})`);

  const { data: tz } = await sb.from('triages').select('created_at').limit(1);
  if (tz && tz[0] && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(String(tz[0].created_at))) {
    bad('created_at sem fuso horário', 'rode o setup.sql: ele converte para TIMESTAMPTZ');
  } else {
    ok('created_at com fuso horário');
  }
} else {
  bad('Supabase não testado (faltam credenciais)');
}

/* ---------- 3. Evolution API ---------- */
head('3 · Evolution API');

const base = rawEvo.replace(/\/+$/, '').replace(/\/manager$/i, '');
const instance = process.env.EVOLUTION_INSTANCE;
let connected = false;

if (base && process.env.EVOLUTION_API_KEY) {
  const evo = axios.create({ baseURL: base, timeout: 15000, headers: { apikey: process.env.EVOLUTION_API_KEY } });

  try {
    const root = await evo.get('/');
    ok(`API respondeu — Evolution v${root.data?.version || '?'}`);
  } catch (e) {
    bad(`API não respondeu em ${base}: ${e.message}`, 'confira a URL e se a instância Evolution está no ar');
  }

  try {
    const { data } = await evo.get('/instance/fetchInstances');
    const list = Array.isArray(data) ? data : data?.instances || [];
    ok(`chave válida — ${list.length} instância(s)`);

    const found = list.find(i => (i.name || i.instanceName) === instance);
    if (!found) {
      bad(`instância "${instance}" não existe`, `use uma destas: ${list.map(i => i.name || i.instanceName).join(', ') || '(nenhuma)'}`);
    } else {
      connected = found.connectionStatus === 'open';
      connected
        ? ok(`instância "${instance}" conectada — ${found.ownerJid} (${found.profileName || 's/nome'})`)
        : bad(`instância "${instance}" com status "${found.connectionStatus}"`, 'abra /admin e escaneie o QR Code');
    }
  } catch (e) {
    bad(`falha de autenticação: ${e.response?.status || ''} ${e.message}`, 'confira a EVOLUTION_API_KEY');
  }

  /* ---------- 4. Webhook ---------- */
  head('4 · Webhook');
  try {
    const { data: wh } = await evo.get(`/webhook/find/${encodeURIComponent(instance)}`);
    const expected = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/webhook/messages` : null;

    if (!wh?.enabled) bad('webhook desabilitado', 'clique "Sincronizar webhook" no /admin');
    else ok('webhook habilitado');

    console.log(`     atual:    ${wh?.url || '(nenhum)'}`);
    if (expected) console.log(`     esperado: ${expected}`);

    if (expected && wh?.url !== expected) {
      bad('URL do webhook divergente', 'reinicie o app (ele corrige no boot) ou use "Sincronizar webhook" no /admin');
    } else if (expected) {
      ok('URL do webhook correta');
    }

    const events = wh?.events || [];
    if (events.includes('SEND_MESSAGE')) {
      bad('evento SEND_MESSAGE habilitado — causa LOOP INFINITO', 'deixe só MESSAGES_UPSERT ("Sincronizar webhook" no /admin resolve)');
    } else if (events.includes('MESSAGES_UPSERT')) {
      ok(`eventos ok (${events.length}): ${events.join(', ')}`);
    } else {
      bad('MESSAGES_UPSERT não está habilitado', 'o bot nunca receberá mensagens — sincronize o webhook');
    }
  } catch (e) {
    bad(`não foi possível ler o webhook: ${e.message}`);
  }
} else {
  bad('Evolution não testada (faltam credenciais)');
}

/* ---------- Resumo ---------- */
console.log('\n' + '─'.repeat(56));
if (fails === 0) {
  console.log('\x1b[32m\x1b[1m✔ Tudo pronto.\x1b[0m Mande uma mensagem no WhatsApp para testar.');
} else {
  console.log(`\x1b[31m\x1b[1m✖ ${fails} problema(s).\x1b[0m Resolva as linhas marcadas com → acima.`);
}
console.log('─'.repeat(56) + '\n');

process.exit(fails ? 1 : 0);

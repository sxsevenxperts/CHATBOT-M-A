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
import crypto from 'node:crypto';

const ok = m => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m, fix) => { console.log(`  \x1b[31m✖\x1b[0m ${m}`); if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`); fails++; };
const warn = (m, fix) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`); };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

let fails = 0;
let inconclusivos = 0;
const numeroEnv = (nome, fallback) => {
  const valor = Number(process.env[nome]);
  return Number.isFinite(valor) ? valor : fallback;
};

/* ---------- 1. Variáveis ---------- */
head('1 · Variáveis de ambiente');

const REQ = ['SUPABASE_URL', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'];
for (const k of REQ) {
  process.env[k] ? ok(`${k} definida`) : bad(`${k} FALTANDO`, `adicione ${k} no .env / nas variáveis do EasyPanel`);
}

const supaKey = process.env.SUPABASE_SERVICE_KEY;
supaKey
  ? ok('SUPABASE_SERVICE_KEY definida')
  : bad('SUPABASE_SERVICE_KEY ausente', 'a chave anon não pode acessar os dados privados do backend');

const rawEvo = process.env.EVOLUTION_API_URL || '';
if (/\/manager\/?$/i.test(rawEvo)) {
  warn('EVOLUTION_API_URL termina em /manager', 'remova o /manager — é o frontend, não a API (o código corrige, mas ajuste o .env)');
} else if (rawEvo) {
  ok('EVOLUTION_API_URL sem /manager');
}

if (!process.env.PUBLIC_URL) bad('PUBLIC_URL não definida', 'sem ela o webhook não se aponta sozinho no boot');
else if (/:\d+$/.test(process.env.PUBLIC_URL)) bad('PUBLIC_URL com porta', 'use https://dominio (sem :3000 — o HTTPS público atende na 443)');
else ok(`PUBLIC_URL = ${process.env.PUBLIC_URL}`);

if (!process.env.ADMIN_PASSWORD && !process.env.DASHBOARD_PASSWORD) {
  bad('ADMIN_PASSWORD não definida', 'o painel administrativo falha fechado até configurar uma senha forte');
} else if (String(process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD).length < 12) {
  warn('senha administrativa curta', 'use pelo menos 12 caracteres aleatórios no EasyPanel');
} else {
  ok('senha administrativa configurada sem fallback padrão');
}
const limiteFreio = Math.max(1, numeroEnv('FREIO_REJEICOES', 3));
const minimoDestinos = Math.min(limiteFreio, Math.max(1, numeroEnv('FREIO_DESTINOS_MIN', 3)));
const instance = process.env.EVOLUTION_INSTANCE;
ok(`freio global: ${limiteFreio} recusas em ${minimoDestinos} destinatário(s) distinto(s)`);

/* ---------- 2. Supabase ---------- */
head('2 · Supabase');

let messagesHasInstance = false;
if (process.env.SUPABASE_URL && supaKey) {
  const sb = createClient(process.env.SUPABASE_URL, supaKey, { auth: { persistSession: false } });
  for (const t of ['triages', 'bot_sessions', 'messages', 'connection_events']) {
    const { error, count } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) bad(`tabela "${t}": ${error.message}`, 'rode o setup.sql no SQL Editor do Supabase');
    else ok(`tabela "${t}" acessível (${count ?? 0} registros)`);
  }

  const COLUNAS = 'subject,seen,intent,category,vehicle,service,need,level,period,date_pref,origin,recommended';
  const { error: colErr } = await sb.from('triages').select(COLUNAS).limit(1);
  if (colErr) bad(`colunas do contexto ausentes: ${colErr.message}`, 'rode o setup.sql novamente (ele é idempotente)');
  else ok(`colunas do contexto presentes (${COLUNAS.split(',').length})`);

  const SCHEMA_ACK = {
    messages: 'wa_id,status,status_at,is_test',
    bot_sessions: 'recovered_at,is_test',
    connection_events: 'instance,event,status,fora_min,tentativas,detalhe,created_at'
  };
  for (const [tabela, colunas] of Object.entries(SCHEMA_ACK)) {
    const { error } = await sb.from(tabela).select(colunas).limit(1);
    if (error) bad(`schema de "${tabela}" incompleto: ${error.message}`, 'rode o setup.sql atualizado');
    else ok(`schema operacional de "${tabela}" presente`);
  }

  const { error: instanceErr } = await sb.from('messages').select('instance').limit(1);
  if (instanceErr) {
    bad('messages.instance não existe', 'aplique o setup.sql atualizado; o runtime novo falha fechado sem esta coluna');
  } else {
    messagesHasInstance = true;
    const { count: legadas, error: legadoErr } = await sb.from('messages')
      .select('id', { count: 'exact', head: true }).is('instance', null);
    if (legadoErr) {
      bad(`não consegui medir o legado sem instância: ${legadoErr.message}`);
    } else if (legadas > 0) {
      warn(`${legadas} mensagem(ns) ainda estão em modo legado (instance NULL)`,
           `confirme que pertencem à instância ${instance || 'atual'} e execute o backfill controlado descrito no setup.sql`);
    } else {
      ok('histórico de mensagens isolado por instância, sem legado NULL');
    }
  }

  const { data: schemaVersion, error: schemaVersionError } = await sb.rpc('chatbot_schema_version');
  if (schemaVersionError || Number(schemaVersion) !== 2026080801) {
    bad(`schema transacional desatualizado: ${schemaVersionError?.message || schemaVersion || 'sem versão'}`,
        'rode o setup.sql 2026080801 antes do deploy do código');
  } else {
    ok('schema transacional 2026080801 (RPC + índices do inbox)');
  }

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

      const credencialExposta = found.token ?? found.apikey ?? found.apiKey ?? null;
      if (credencialExposta && String(credencialExposta) === String(process.env.EVOLUTION_API_KEY)) {
        ok('retries legados do webhook trazem apikey compatível com o rollout protegido');
      } else {
        warn('a instância não expõe apikey compatível nos eventos legados',
             'ative o header em duas fases antes de exigir autenticação, para não perder retries iniciados antes do deploy');
      }
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
      ok(`MESSAGES_UPSERT habilitado — o bot recebe mensagens`);
      events.includes('MESSAGES_UPDATE')
        ? ok('MESSAGES_UPDATE habilitado — dá para saber se a mensagem foi ENTREGUE')
        : bad('MESSAGES_UPDATE não habilitado',
              'sem ele, envio aceito e não entregue fica invisível — clique "Sincronizar webhook" no /admin');
    } else {
      bad('MESSAGES_UPSERT não está habilitado', 'o bot nunca receberá mensagens — sincronize o webhook');
    }

    const headers = wh?.headers || wh?.webhookHeaders || {};
    const headerKey = Object.keys(headers)
      .find(k => k.toLowerCase() === 'x-evolution-webhook-secret');
    const esperado = process.env.EVOLUTION_WEBHOOK_SECRET ||
      crypto.createHash('sha256')
        .update(`m&a:webhook:${process.env.EVOLUTION_API_KEY || ''}`)
        .digest('hex');
    if (headerKey && String(headers[headerKey]) === esperado) {
      ok('webhook autenticado com segredo exclusivo');
    } else {
      bad('webhook ainda não envia o header de autenticação', 'reinicie o app ou clique "Sincronizar webhook" no /admin');
    }
  } catch (e) {
    bad(`não foi possível ler o webhook: ${e.message}`);
  }
} else {
  bad('Evolution não testada (faltam credenciais)');
}

/* ---------- 5. Entrega ---------- */
head('5 · Entrega das mensagens (aceite ≠ entrega)');

if (process.env.SUPABASE_URL && supaKey) {
  const sb2 = createClient(process.env.SUPABASE_URL, supaKey, { auth: { persistSession: false } });
  const desde = new Date(Date.now() - 6 * 3600_000).toISOString();
  let entregaQuery = sb2.from('messages')
    .select('id, status, status_at, created_at, phone').eq('direction', 'out').eq('is_test', false)
    .gte('created_at', desde)
    .order('created_at', { ascending: false }).order('id', { ascending: false });
  if (messagesHasInstance) {
    entregaQuery = entregaQuery.or(`instance.eq.${instance},instance.is.null`);
  }
  const { data, error } = await entregaQuery;

  if (error) {
    bad(`não consegui ler as mensagens: ${error.message}`);
  } else if (!data.length) {
    warn('nenhuma mensagem enviada nas últimas 6h', 'sem dado para julgar a entrega');
    inconclusivos++;
  } else {
    const ENTREGUES = ['DELIVERY_ACK', 'READ', 'PLAYED'];
    const DEFINITIVOS = [...ENTREGUES, 'ERROR'];
    const enviadas = data.filter(m => m.status !== 'BLOQUEADO');
    const entregues = enviadas.filter(m => ENTREGUES.includes(m.status)).length;
    const rejeitadas = enviadas.filter(m => m.status === 'ERROR').length;
    const naoEnviadas = data.length - enviadas.length;
    const maduro = new Date(Date.now() - 120_000).toISOString();
    const semAck = enviadas.filter(m => m.created_at < maduro &&
      (!m.status || ['PENDING', 'SERVER_ACK'].includes(m.status))).length;
    const definitivas = enviadas.filter(m => DEFINITIVOS.includes(m.status));
    let rejeicoesSeguidas = 0;
    const destinosDaSequencia = new Set();
    for (const m of definitivas) {
      if (m.status !== 'ERROR') break;
      rejeicoesSeguidas++;
      destinosDaSequencia.add(m.phone);
    }
    // Um PENDING/SERVER_ACK novo e já maduro vence uma entrega antiga. O
    // doctor anterior escolhia apenas definitivos e produzia falso verde.
    const avaliaveis = enviadas.filter(m => DEFINITIVOS.includes(m.status) || m.created_at < maduro);
    const ultimoStatus = avaliaveis[0]?.status || null;
    console.log(`     ${enviadas.length} enviadas · ${entregues} confirmadas · ${rejeitadas} recusadas · ` +
                `${naoEnviadas} barradas pelo freio · ${semAck} sem confirmação`);
    if (rejeitadas > 0) {
      if (ultimoStatus === 'ERROR' && rejeicoesSeguidas >= limiteFreio &&
          destinosDaSequencia.size >= minimoDestinos) {
        bad(`${rejeicoesSeguidas} mensagens seguidas recusadas em ${destinosDaSequencia.size} destinatários`,
            'freio correto: atenda manualmente e use uma única sonda no /admin antes de religar');
      } else if (ultimoStatus === 'ERROR') {
        warn(`recusa isolada (${rejeicoesSeguidas}/${limiteFreio}; ${destinosDaSequencia.size}/${minimoDestinos} destinatários)`,
             'somente o contato reincidente deve ser isolado; os demais atendimentos continuam');
      } else {
        warn(`${rejeitadas} recusa(s) antigas, mas uma entrega posterior normalizou o canal`);
      }
    }
    if (naoEnviadas > 0) {
      warn(`${naoEnviadas} resposta(s) não saíram por causa do freio de envio`,
           'o bot está mudo de propósito — libere no /admin depois de um teste entregue');
    }
    if (ENTREGUES.includes(ultimoStatus)) {
      ok('o envio avaliável mais recente tem entrega confirmada');
    } else if (!ultimoStatus) {
      warn('os envios mais novos ainda estão dentro dos 2 minutos de tolerância');
      inconclusivos++;
    } else if (['PENDING', 'SERVER_ACK'].includes(ultimoStatus) || !ultimoStatus) {
      bad(`envio mais recente preso em ${ultimoStatus || 'SEM STATUS'} por mais de 2 minutos`,
          'aceite não é entrega; confira a conta WhatsApp e use uma única sonda no /admin');
    } else if (ultimoStatus === 'ERROR' &&
               !(rejeicoesSeguidas >= limiteFreio && destinosDaSequencia.size >= minimoDestinos)) {
      warn('o envio avaliável mais recente foi recusado para um destinatário, sem pane global');
      inconclusivos++;
    }
  }
}

/* ---------- 6. Freio de envio ---------- */
head('6 · Freio de envio (o bot para quando o WhatsApp recusa)');

const alvo = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (!alvo) {
  bad('PUBLIC_URL não definida', 'sem ela não consigo validar o runtime público');
} else {
  try {
    const r = await fetch(`${alvo}/health`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok) bad(`/health respondeu HTTP ${r.status}`, 'verifique os logs do container no EasyPanel');
    j.db?.ok === true ? ok('/health confirma Supabase operacional')
      : bad(`/health: banco indisponível (${j.db?.error || 'sem detalhe'})`);
    j.whatsapp?.ok === true ? ok('/health confirma WhatsApp conectado')
      : bad(`/health: WhatsApp indisponível (${j.whatsapp?.error || j.whatsapp?.info?.status || 'sem detalhe'})`);
    j.webhook?.ok === true ? ok('/health confirma webhook sincronizado')
      : bad(`/health: webhook divergente (${j.webhook?.error || 'sem detalhe'})`);
    j.canal?.ok === true ? ok('/health confirma veredito persistido do canal')
      : bad(`/health: freio canônico indisponível (${j.canal?.error || 'sem detalhe'})`,
            'o webhook deve permanecer em 503 até o banco restaurar o estado de envio');
    j.config?.instance === instance ? ok(`/health está na instância correta (${instance})`)
      : bad(`/health está na instância "${j.config?.instance || 'não informada'}"`, `configure EVOLUTION_INSTANCE=${instance} no EasyPanel`);
    j.config?.webhookProtegido === true ? ok('/health confirma webhook protegido')
      : bad('/health não confirma autenticação do webhook', 'publique a correção e sincronize o webhook');
    j.ready === true ? ok('/health ready = true')
      : bad('/health ready = false', 'corrija banco, freio canônico, WhatsApp ou webhook antes de liberar o atendimento');
    j.operational === true ? ok('/health operational = true')
      : bad('/health operational = false', 'o bot não está apto a responder; confira o freio e as dependências');
    if (!j.freio) {
      bad('a versão em produção não expõe o freio de envio', 'faça o deploy da última versão');
    } else if (j.freio.bloqueado) {
      bad(`freio ENGATADO desde ${j.freio.desde}: ${j.freio.motivo}`,
          `${j.freio.naoEnviadas || 0} resposta(s) não saíram — atenda manualmente e teste o envio no /admin`);
    } else {
      ok(`freio liberado (limite: ${j.freio.limite} recusas seguidas)`);
    }
  } catch (e) {
    bad(`não consegui consultar ${alvo}/health: ${e.message}`, 'confira o domínio público e o container no EasyPanel');
  }
}

/* ---------- Resumo ---------- */
console.log('\n' + '─'.repeat(56));
if (fails === 0 && inconclusivos === 0) {
  console.log('\x1b[32m\x1b[1m✔ Tudo pronto.\x1b[0m Configuração, runtime e entrega recente confirmados.');
} else if (fails === 0) {
  console.log(`\x1b[33m\x1b[1m! Configuração pronta, entrega inconclusiva (${inconclusivos}).\x1b[0m ` +
              'Uma sonda real exige autorização operacional explícita.');
} else {
  console.log(`\x1b[31m\x1b[1m✖ ${fails} problema(s).\x1b[0m Resolva as linhas marcadas com → acima.`);
}
console.log('─'.repeat(56) + '\n');

process.exit(fails ? 1 : inconclusivos ? 2 : 0);

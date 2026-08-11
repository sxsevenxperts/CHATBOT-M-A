import './env.js';
import { createClient } from '@supabase/supabase-js';
import { warn } from './recorder.js';
import { isTestPhone } from './testflag.js';

let supabase;
let messagesHasInstance = false;
let ultimaLimpezaAcks = 0;
const WEBHOOK_LEASE_MS = 10 * 60_000;

export async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  // Backend-only: setup.sql revoga anon/authenticated por conter telefone e
  // conversa. Aceitar anon como fallback produziria um boot que nunca grava.
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórias');

  supabase = createClient(url, key, { auth: { persistSession: false } });

  // Falha cedo e com mensagem clara se o setup.sql não rodou. Conferir só
  // a existência da tabela dava falso verde quando as colunas de ACK faltavam.
  const schemaObrigatorio = {
    triages: 'id,phone,subject,intent,category,vehicle,service,need,level,period,date_pref,origin,recommended,is_test,created_at',
    bot_sessions: 'phone,step,data,handed_off,is_test,recovered_at,updated_at',
    messages: 'id,phone,direction,body,is_test,wa_id,status,status_at,instance,created_at',
    connection_events: 'id,instance,event,status,fora_min,tentativas,detalhe,created_at'
  };

  for (const [table, columns] of Object.entries(schemaObrigatorio)) {
    const { error } = await supabase.from(table).select(columns, { count: 'exact', head: true });
    if (error) {
      throw new Error(
        `Schema "${table}" incompleto ou inacessível (${error.message}). ` +
        'Rode o setup.sql no SQL Editor do Supabase.'
      );
    }
  }

  // Os índices e a RPC fazem parte do contrato, não apenas as colunas. Sem a
  // versão nova o inbox/freio distribuído não é seguro, portanto o webhook
  // permanece em 503 até o setup.sql ser aplicado por completo.
  const { data: versao, error: versionError } = await supabase.rpc('chatbot_schema_version');
  if (versionError || Number(versao) !== 2026080801) {
    throw new Error(
      `Schema transacional desatualizado (${versionError?.message || versao || 'sem versão'}). ` +
      'Rode o setup.sql atualizado no SQL Editor do Supabase.'
    );
  }
  messagesHasInstance = true;

  return supabase;
}

export function db() {
  if (!supabase) throw new Error('Supabase não inicializado');
  return supabase;
}

/* ---------------- Sessões ---------------- */

export async function getSession(phone) {
  const { data, error } = await db().from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveSession(phone, { step, data, handed_off }) {
  // is_test também aqui: sem isso a sessão de teste sobrevivia à limpeza e o
  // bot continuava silenciado para um número que só existiu num teste.
  const row = { phone, updated_at: new Date().toISOString(), is_test: isTestPhone(phone) };
  if (step !== undefined) row.step = step;
  if (data !== undefined) row.data = data;
  if (handed_off !== undefined) row.handed_off = handed_off;

  const { error } = await db().from('bot_sessions').upsert(row, { onConflict: 'phone' });
  if (error) throw error;
}

export async function resetSession(phone) {
  const { error } = await db().from('bot_sessions').delete().eq('phone', phone);
  if (error) throw error;
}

/**
 * Conversas que estavam no meio do fluxo quando a conexão caiu.
 *
 * Critérios, todos necessários para não incomodar quem não deve:
 *   - ainda não passou para a atendente (handed_off = false)
 *   - não é teste
 *   - última atividade ANTES do início da queda — quem escreveu depois já foi
 *     atendido normalmente
 *   - dentro da janela de rearme; conversa mais velha que isso já morreu
 *   - ainda não recebeu a mensagem de retomada desta queda
 */
export async function getSessoesInterrompidas({
  desde, ate = null, limite = 20, referencia = null
}) {
  // Isolamento simétrico: produção ignora teste, teste ignora produção.
  // Sem isso, rodar a suíte mexia em sessão de cliente real — aconteceu.
  const emTeste = process.env.NODE_ENV === 'test';

  let q = db().from('bot_sessions').select('*')
    .eq('handed_off', false)
    .eq('is_test', emTeste)
    .gt('updated_at', desde);

  if (emTeste) {
    const phones = String(process.env.TEST_PHONES || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    if (!phones.length) return [];
    q = q.in('phone', phones);
  }

  if (ate) q = q.lt('updated_at', ate);

  const { data, error } = await q.order('updated_at', { ascending: false }).limit(limite);
  if (error) throw error;

  // Nunca duas vezes pela mesma queda.
  const corte = referencia || desde;
  return (data || []).filter(s => !s.recovered_at || s.recovered_at < corte);
}

export async function marcarRetomada(phone) {
  const { error } = await db().from('bot_sessions')
    .update({ recovered_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) throw error;
}

/* ---------------- Mensagens ---------------- */

const ENTREGUES = ['DELIVERY_ACK', 'READ', 'PLAYED'];
const REJEITADAS = ['ERROR'];
const DEFINITIVOS = [...ENTREGUES, ...REJEITADAS];
const EVENTOS_CANAL = ['AUTO_BLOCK', 'MANUAL_BLOCK', 'MANUAL_RELEASE', 'PROBE_DELIVERED', 'PROBE_ERROR'];
const LIBERADORES_CANAL = [...ENTREGUES, 'MANUAL_RELEASE', 'PROBE_DELIVERED'];
const ORDEM_ACK = { PENDING: 0, SERVER_ACK: 1, DELIVERY_ACK: 2, READ: 3, PLAYED: 4 };
const ACK_ANTERIORES = {
  PENDING: [null],
  SERVER_ACK: [null, 'PENDING'],
  ERROR: [null, 'PENDING', 'SERVER_ACK'],
  DELIVERY_ACK: [null, 'PENDING', 'SERVER_ACK', 'ERROR'],
  READ: [null, 'PENDING', 'SERVER_ACK', 'ERROR', 'DELIVERY_ACK'],
  PLAYED: [null, 'PENDING', 'SERVER_ACK', 'ERROR', 'DELIVERY_ACK', 'READ']
};

export const canalScope = () => `__ch_${String(process.env.EVOLUTION_INSTANCE || 'default').slice(0, 14)}`;
const instanciaAtual = () => String(process.env.EVOLUTION_INSTANCE || 'default');

function rowComInstancia(row) {
  return messagesHasInstance ? { ...row, instance: instanciaAtual() } : row;
}

function filtrarInstancia(query, { incluirLegado = false } = {}) {
  if (!messagesHasInstance) return query;
  // NULL representa o histórico anterior à coluna. Produção o lê durante a
  // transição para não esquecer o freio; testes nunca o herdam, nem reatribuem
  // linhas reais para sua instância efêmera.
  if (incluirLegado && process.env.NODE_ENV !== 'test') {
    return query.or(`instance.eq.${instanciaAtual()},instance.is.null`);
  }
  return query.eq('instance', instanciaAtual());
}

function filtrarAlvoAck(query, { legado = false } = {}) {
  if (!messagesHasInstance) return query;
  if (legado && process.env.NODE_ENV !== 'test') return query.is('instance', null);
  return query.eq('instance', instanciaAtual());
}

/**
 * ACKs podem chegar repetidos e fora de ordem. Nunca rebaixa READ para
 * SERVER_ACK, nunca troca uma entrega real por ERROR tardio e só aceita sair
 * de ERROR quando apareceu prova de entrega.
 */
function deveAtualizarStatus(atual, proximo) {
  if (!atual) return true;
  if (atual === proximo) return false;

  if (ENTREGUES.includes(atual)) {
    return ENTREGUES.includes(proximo) && ORDEM_ACK[proximo] > ORDEM_ACK[atual];
  }
  if (atual === 'ERROR') return ENTREGUES.includes(proximo);
  if (proximo === 'ERROR') return true;

  const a = ORDEM_ACK[atual];
  const p = ORDEM_ACK[proximo];
  if (a !== undefined && p !== undefined) return p > a;
  return true;
}

export async function logMessage(phone, direction, body, waId = null, status = null, options = {}) {
  // Log é observabilidade: nunca deve derrubar o atendimento.
  const { error } = await db().from('messages').insert([rowComInstancia({
    phone, direction, body,
    is_test: options.isTest ?? isTestPhone(phone),
    wa_id: waId,
    status,
    status_at: status ? new Date().toISOString() : null
  })]);
  if (error) {
    // Retry pós-send: se a primeira resposta do banco se perdeu, o índice por
    // instance+wa_id prova que a saída já está registrada.
    if (error.code === '23505' && direction === 'out' && waId) {
      return { ok: true, status, reconciledAck: null, duplicate: true };
    }
    warn('db.logMensagemFalhou', { erro: error.message });
    return { ok: false, status, reconciledAck: null };
  }

  // Um ACK pode chegar antes de sendText devolver. Nesse caso o webhook o
  // guarda como linha `ack`; assim que a saída existe, conciliamos e apagamos
  // a caixa de entrada. Isto sobrevive inclusive a restart entre os eventos.
  let reconciledAck = null;
  if (direction === 'out' && waId) {
    try {
      const orfao = await buscarAckOrfao(waId);
      if (orfao) {
        const transicao = await atualizarStatusMensagem(waId, orfao.status, { persistirOrfao: false });
        if (transicao.matched) {
          reconciledAck = transicao.status || orfao.status;
        }
      }
    } catch (e) {
      // A saída já foi aceita pelo WhatsApp; não a duplica por uma falha de
      // observabilidade. O webhook continuará retentando o ACK.
      warn('db.ackOrfaoConciliacaoFalhou', { erro: e.message });
    }
  }
  return { ok: true, status: reconciledAck || status, reconciledAck };
}

async function buscarAckOrfao(waId) {
  let q = db().from('messages')
    .select('id,status,status_at,created_at')
    .eq('direction', 'ack')
    .eq('phone', canalScope())
    .eq('wa_id', waId)
    .order('created_at', { ascending: true })
    .limit(20);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { data, error } = await q;
  if (error) {
    warn('db.ackOrfaoLeituraFalhou', { erro: error.message });
    throw error;
  }
  // Em schema legado, duas réplicas podem ter inserido o mesmo ACK antes de
  // existir o índice único. Reduz todas as cópias pela mesma máquina de
  // estados para uma entrega nunca ser perdida para um ERROR/PENDING tardio.
  let vencedor = null;
  for (const item of data || []) {
    if (!vencedor || deveAtualizarStatus(vencedor.status, item.status)) vencedor = item;
  }
  return vencedor;
}

async function salvarAckOrfao(waId, status) {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const atual = await buscarAckOrfao(waId);
    const agora = new Date().toISOString();
    if (atual) {
      if (!deveAtualizarStatus(atual.status, status)) return atual;

      // CAS: se outra réplica promoveu o ACK depois do SELECT, este UPDATE
      // casa zero linhas e o laço recalcula contra o vencedor persistido.
      let q = db().from('messages')
        .update({ status, status_at: agora })
        .eq('id', atual.id);
      q = atual.status === null ? q.is('status', null) : q.eq('status', atual.status);
      const { data, error } = await q.select('id');
      if (error) {
        warn('db.ackOrfaoFalhou', { erro: error.message });
        throw error;
      }
      if ((data || []).length) return buscarAckOrfao(waId);
      continue;
    }

    await limparAcksOrfaosExpirados();
    const { error } = await db().from('messages').insert([rowComInstancia({
      phone: canalScope(),
      direction: 'ack',
      body: null,
      is_test: process.env.NODE_ENV === 'test',
      wa_id: waId,
      status,
      status_at: agora
    })]);
    if (!error) return buscarAckOrfao(waId);
    // O índice único transforma INSERT concorrente em nova rodada de CAS.
    if (error.code === '23505') continue;
    warn('db.ackOrfaoFalhou', { erro: error.message });
    throw error;
  }

  throw new Error(`ACK ${waId} sofreu concorrência excessiva e não foi persistido`);
}

async function limparAcksOrfaosExpirados() {
  if (Date.now() - ultimaLimpezaAcks < 300_000) return;
  ultimaLimpezaAcks = Date.now();
  const corte = new Date(Date.now() - 30 * 60_000).toISOString();
  let q = db().from('messages').delete()
    .eq('direction', 'ack')
    .eq('phone', canalScope())
    .lt('created_at', corte);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { error } = await q;
  if (error) {
    warn('db.ackOrfaoExpiracaoFalhou', { erro: error.message });
    // Limpeza é higiene; o INSERT do ACK atual ainda pode prosseguir.
  }
}

async function removerAcksDominados(waId, statusAplicado) {
  const candidatos = Object.keys(ACK_ANTERIORES);
  const dominados = candidatos.filter(candidato =>
    candidato === statusAplicado || !deveAtualizarStatus(statusAplicado, candidato)
  );
  if (!dominados.length) return;
  let q = db().from('messages').delete()
    .eq('direction', 'ack')
    .eq('phone', canalScope())
    .eq('wa_id', waId)
    .in('status', dominados);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { error } = await q;
  if (error) {
    warn('db.ackOrfaoLimpezaFalhou', { erro: error.message });
    throw error;
  }
}

async function aplicarStatusAtomico(waId, status, { legado = false } = {}) {
  const anteriores = ACK_ANTERIORES[status];
  if (!anteriores) return { data: [], error: null };

  let q = db().from('messages')
    .update({ status, status_at: new Date().toISOString() })
    .eq('direction', 'out')
    .eq('wa_id', waId);
  q = filtrarAlvoAck(q, { legado });

  const textos = anteriores.filter(Boolean);
  if (anteriores.includes(null) && textos.length) {
    q = q.or(`status.is.null,status.in.(${textos.join(',')})`);
  } else if (anteriores.includes(null)) {
    q = q.is('status', null);
  } else {
    q = q.in('status', textos);
  }
  return q.select('id,phone,status');
}

async function lerSaidaPorWaId(waId, { legado = false } = {}) {
  let q = db().from('messages')
    .select('id,phone,status,status_at')
    .eq('direction', 'out')
    .eq('wa_id', waId)
    .order('created_at', { ascending: false })
    .limit(1);
  q = filtrarAlvoAck(q, { legado });
  const { data, error } = await q;
  return { atual: (data || [])[0] || null, error };
}

/**
 * ACK de entrega chegou: promove o status da mensagem uma única vez.
 *
 * O retorno separa três casos que antes eram confundidos:
 * - matched=false: o id não pertence a uma mensagem deste bot;
 * - matched=true/changed=false: ACK duplicado ou regressivo;
 * - changed=true: transição nova, a única que pode mexer no freio.
 */
export async function atualizarStatusMensagem(waId, status, { persistirOrfao = true } = {}) {
  if (!waId || !status) return { matched: false, changed: false };
  status = String(status).toUpperCase();
  if (!ACK_ANTERIORES[status]) return { matched: false, changed: false };

  // O inbox é a fonte canônica do ACK. Primeiro funde eventos concorrentes
  // e fora de ordem; só depois aplica o vencedor à mensagem de saída. Assim
  // um ERROR tardio nunca apaga uma DELIVERY/READ que chegou antes.
  if (persistirOrfao) {
    const vencedor = await salvarAckOrfao(waId, status);
    if (vencedor?.status) status = vencedor.status;
  }

  // A condição do UPDATE expressa toda a máquina de estados. O PostgreSQL a
  // reavalia sob lock de linha; portanto ERROR concorrente nunca rebaixa uma
  // DELIVERY/READ/PLAYED que já venceu.
  const primeira = await aplicarStatusAtomico(waId, status);
  if (primeira.error) {
    warn('db.statusMensagemFalhou', { erro: primeira.error.message });
    throw primeira.error;
  }
  if ((primeira.data || []).length) {
    const atualizada = [...primeira.data].sort((a, b) => Number(b.id) - Number(a.id))[0];
    await removerAcksDominados(waId, status);
    return { matched: true, changed: true, previous: null, status, phone: atualizada.phone };
  }

  let alvoLegado = false;
  let { atual, error: readError } = await lerSaidaPorWaId(waId);
  if (readError) {
    warn('db.statusMensagemFalhou', { erro: readError.message });
    throw readError;
  }

  // Após adicionar messages.instance, ACKs ainda podem chegar para saídas
  // legadas NULL. Tenta esse alvo separadamente para manter cada condição
  // atômica e não misturar dois filtros OR no PostgREST.
  if (!atual && messagesHasInstance && process.env.NODE_ENV !== 'test') {
    const legado = await aplicarStatusAtomico(waId, status, { legado: true });
    if (legado.error) {
      warn('db.statusMensagemFalhou', { erro: legado.error.message });
      throw legado.error;
    }
    if ((legado.data || []).length) {
      const atualizada = [...legado.data].sort((a, b) => Number(b.id) - Number(a.id))[0];
      await removerAcksDominados(waId, status);
      return { matched: true, changed: true, previous: null, status, phone: atualizada.phone };
    }
    ({ atual, error: readError } = await lerSaidaPorWaId(waId, { legado: true }));
    alvoLegado = !!atual;
    if (readError) {
      warn('db.statusMensagemFalhou', { erro: readError.message });
      throw readError;
    }
  }

  if (!atual) {
    // Handshake simétrico: quem gravar por último (saída ou ACK) enxerga o
    // outro lado. Fecha a janela entre o SELECT sem linha e o INSERT do inbox.
    let reconciliada = await aplicarStatusAtomico(waId, status);
    if (!(reconciliada.data || []).length && messagesHasInstance && process.env.NODE_ENV !== 'test') {
      reconciliada = await aplicarStatusAtomico(waId, status, { legado: true });
    }
    if (reconciliada.error) throw reconciliada.error;
    if ((reconciliada.data || []).length) {
      const linha = [...reconciliada.data].sort((a, b) => Number(b.id) - Number(a.id))[0];
      await removerAcksDominados(waId, status);
      return { matched: true, changed: true, previous: null, status, phone: linha.phone };
    }
    return { matched: false, changed: false, queued: persistirOrfao };
  }

  // A linha pode ter sido inserida entre o UPDATE e o SELECT. Uma segunda
  // aplicação atômica fecha somente essa corrida de criação (não é CAS).
  if (deveAtualizarStatus(atual.status, status)) {
    const segunda = await aplicarStatusAtomico(waId, status, { legado: alvoLegado });
    if (segunda.error) {
      warn('db.statusMensagemFalhou', { erro: segunda.error.message });
      throw segunda.error;
    }
    if ((segunda.data || []).length) {
      await removerAcksDominados(waId, status);
      return { matched: true, changed: true, previous: atual.status, status, phone: atual.phone };
    }
  }

  await removerAcksDominados(waId, atual.status);
  return { matched: true, changed: false, previous: atual.status, status: atual.status, phone: atual.phone };
}

/** Status atual de uma mensagem pelo id do WhatsApp — usado pela sonda. */
export async function statusPorWaId(waId) {
  if (!waId) return null;
  let { atual, error } = await lerSaidaPorWaId(waId);
  if (!atual && !error && messagesHasInstance && process.env.NODE_ENV !== 'test') {
    ({ atual, error } = await lerSaidaPorWaId(waId, { legado: true }));
  }
  if (error) { warn('db.statusPorWaIdFalhou', { erro: error.message }); return null; }
  return atual ? { status: atual.status, status_at: atual.status_at } : null;
}

/* ---------------- Inbox durável do webhook ---------------- */

async function buscarEntradaWebhook(waId) {
  let q = db().from('messages')
    .select('id,phone,body,wa_id,status,status_at,created_at')
    .eq('direction', 'inbox')
    .eq('wa_id', waId)
    .order('created_at', { ascending: false })
    .limit(1);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { data, error } = await q;
  if (error) throw error;
  return (data || [])[0] || null;
}

/** Persiste antes do HTTP 2xx; reentrega da Evolution vira a mesma linha. */
export async function persistirEntradaWebhook({ waId, phone, payload }) {
  if (!waId || !phone) throw new Error('Webhook de entrada sem id ou telefone');
  const existente = await buscarEntradaWebhook(waId);
  if (existente) return { ...existente, duplicate: true };

  const agora = new Date().toISOString();
  const row = rowComInstancia({
    phone,
    direction: 'inbox',
    body: JSON.stringify(payload),
    is_test: isTestPhone(phone),
    wa_id: waId,
    status: 'RECEIVED',
    status_at: agora
  });
  const { data, error } = await db().from('messages').insert([row])
    .select('id,phone,body,wa_id,status,status_at,created_at');
  if (!error) return { ...data[0], duplicate: false };

  // Rolling deploy: a outra réplica pode ter vencido o INSERT.
  if (error.code === '23505') {
    const vencedor = await buscarEntradaWebhook(waId);
    if (vencedor) return { ...vencedor, duplicate: true };
  }
  throw error;
}

/** Claim atômico: somente uma réplica processa cada entrada. */
export async function reivindicarEntradaWebhook(entrada) {
  // A serialização em memória não atravessa rolling deploy. Antes do claim,
  // prioriza a entrada pendente mais antiga; o índice parcial
  // idx_messages_instance_inbox_processing_unique é a garantia atômica de
  // uma única execução por telefone entre réplicas.
  let primeira = db().from('messages')
    .select('id')
    .eq('phone', entrada.phone)
    .eq('direction', 'inbox')
    .neq('status', 'PROCESSED')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  primeira = filtrarInstancia(primeira, { incluirLegado: true });
  const { data: fila, error: filaError } = await primeira;
  if (filaError) throw filaError;
  if (String(fila?.[0]?.id || '') !== String(entrada.id)) {
    return { claimed: false, claimAt: null };
  }

  const agora = new Date().toISOString();
  const expirou = new Date(Date.now() - WEBHOOK_LEASE_MS).toISOString();
  let q = db().from('messages')
    .update({ status: 'PROCESSING', status_at: agora })
    .eq('id', entrada.id)
    .eq('direction', 'inbox');
  q = filtrarInstancia(q, { incluirLegado: true });

  if (entrada.status === 'PROCESSING') {
    q = q.eq('status', 'PROCESSING').lt('status_at', expirou);
  } else {
    q = q.in('status', ['RECEIVED', 'ERROR']);
  }
  const { data, error } = await q.select('id,status_at');
  // Outra réplica já processa uma mensagem deste telefone.
  if (error?.code === '23505') return { claimed: false, claimAt: null };
  if (error) throw error;
  const claim = (data || [])[0];
  return claim
    ? { claimed: true, claimAt: claim.status_at }
    : { claimed: false, claimAt: null };
}

export async function concluirEntradaWebhook(id, claimAt) {
  if (!claimAt) throw new Error('Claim do inbox ausente ao concluir');
  let q = db().from('messages')
    .update({ status: 'PROCESSED', status_at: new Date().toISOString() })
    .eq('id', id).eq('direction', 'inbox').eq('status', 'PROCESSING')
    .eq('status_at', claimAt);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { data, error } = await q.select('id');
  if (error) throw error;
  if (!(data || []).length) throw new Error('Lease do inbox perdido antes da conclusão');
}

export async function falharEntradaWebhook(id, claimAt) {
  if (!claimAt) return false;
  let q = db().from('messages')
    .update({ status: 'ERROR', status_at: new Date().toISOString() })
    .eq('id', id).eq('direction', 'inbox').eq('status', 'PROCESSING')
    .eq('status_at', claimAt);
  q = filtrarInstancia(q, { incluirLegado: true });
  const { data, error } = await q.select('id');
  if (error) throw error;
  return (data || []).length > 0;
}

export async function listarEntradasWebhookPendentes({ limite = 100 } = {}) {
  const emTeste = process.env.NODE_ENV === 'test';
  let q = db().from('messages')
    .select('id,phone,body,wa_id,status,status_at,created_at')
    .eq('direction', 'inbox')
    .neq('status', 'PROCESSED')
    .eq('is_test', emTeste)
    .order('created_at', { ascending: true })
    .limit(limite);
  q = filtrarInstancia(q, { incluirLegado: true });
  if (emTeste) {
    const phones = String(process.env.TEST_PHONES || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    if (!phones.length) return [];
    q = q.in('phone', phones);
  }
  const { data, error } = await q;
  if (error) throw error;
  const expirou = Date.now() - WEBHOOK_LEASE_MS;
  return (data || []).filter(item =>
    item.status !== 'PROCESSING' || new Date(item.status_at || 0).getTime() < expirou
  );
}

/** Calcula o veredito pela ordem de ENVIO, não pela hora tardia do ACK. */
export function calcularVereditoEnvio(rows = []) {
  const brutas = [...rows].sort((a, b) => {
    const porCriacao = String(b.created_at || '').localeCompare(String(a.created_at || ''));
    return porCriacao || (Number(b.id) || 0) - (Number(a.id) || 0);
  });

  // A RPC já validou o snapshot sob lock. Aqui o source_id detecta uma saída,
  // sonda ou decisão administrativa inserida antes do marcador. Mudança
  // posterior na mesma linha é ACK tardio e não invalida o AUTO_BLOCK.
  const ordenadas = brutas.filter((item, indice) => {
    if (item.status !== 'AUTO_BLOCK') return true;
    const campos = Object.fromEntries(
      String(item.body || '').split(';').map(parte => {
        const i = parte.indexOf('=');
        return i > 0 ? [parte.slice(0, i), parte.slice(i + 1)] : ['', ''];
      }).filter(([chave]) => chave)
    );
    const esperado = campos.source_id;
    if (!esperado) return true; // compatibilidade com marcador anterior
    const proximoDado = brutas.slice(indice + 1).find(x => x.status !== 'AUTO_BLOCK');
    return String(proximoDado?.id || '') === esperado;
  });
  const m = ordenadas[0];
  if (!m) return null;

  let bloqueioManual = false;
  let bloqueioPersistido = false;
  let rejeicoesSeguidas = 0;
  const destinos = new Set();
  for (const item of ordenadas) {
    if (LIBERADORES_CANAL.includes(item.status)) break;
    if (item.status === 'MANUAL_BLOCK' || item.status === 'AUTO_BLOCK') {
      bloqueioManual = true;
      bloqueioPersistido = true;
      break;
    }
    // PROBE_ERROR é apenas o marcador administrativo da mesma saída já
    // registrada como ERROR; não pode contar a sonda duas vezes.
    if (item.status === 'PROBE_ERROR') continue;
    if (item.status === 'ERROR') {
      rejeicoesSeguidas++;
      destinos.add(item.phone || '__desconhecido__');
      continue;
    }
  }
  return {
    sourceId: m.id,
    status: m.status,
    em: m.status_at || m.created_at,
    recusado: m.status === 'ERROR' || m.status === 'PROBE_ERROR',
    bloqueioManual,
    bloqueioPersistido,
    rejeicoesSeguidas,
    destinatariosRejeitados: [...destinos]
  };
}

/**
 * Último veredito conhecido do canal de envio.
 *
 * O freio mora em memória, então um deploy zeraria ele e o bot voltaria a
 * insistir num canal recusando — o exato comportamento que o freio existe para
 * impedir. Aqui o boot pergunta ao banco como terminou a última mensagem que
 * teve resposta definitiva do WhatsApp.
 */
export async function ultimoVereditoEnvio({ horas = null, incluirTestes = false } = {}) {
  const desde = horas ? new Date(Date.now() - horas * 3600_000).toISOString() : null;

  let saidas = db().from('messages')
    .select('id, phone, body, status, status_at, created_at')
    .eq('direction', 'out')
    .in('status', DEFINITIVOS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);
  saidas = filtrarInstancia(saidas, { incluirLegado: true });
  // Ambientes são simétricos: produção só considera dados reais; a suíte só
  // considera suas fixtures. Misturar ambos fazia um E2E herdar o freio real.
  saidas = saidas.eq('is_test', !!incluirTestes);
  if (incluirTestes) {
    const phones = String(process.env.TEST_PHONES || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    if (phones.length) saidas = saidas.in('phone', phones);
  }
  if (desde) saidas = saidas.gte('created_at', desde);

  let sistema = db().from('messages')
    .select('id, phone, body, status, status_at, created_at')
    .eq('direction', 'system')
    .eq('phone', canalScope())
    .in('status', EVENTOS_CANAL)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(100);
  sistema = filtrarInstancia(sistema, { incluirLegado: true });
  sistema = sistema.eq('is_test', !!incluirTestes);
  if (desde) sistema = sistema.gte('created_at', desde);

  const [out, sys] = await Promise.all([saidas, sistema]);
  const error = out.error || sys.error;
  if (error) {
    warn('db.ultimoVereditoFalhou', { erro: error.message });
    throw error;
  }
  return calcularVereditoEnvio([...(out.data || []), ...(sys.data || [])]);
}

/** Persiste bloqueio/liberação do canal sem exigir uma tabela nova. */
export async function registrarEventoCanal(status, detalhe = null, { expectedSource = null } = {}) {
  if (!EVENTOS_CANAL.includes(status)) throw new Error(`Evento de canal inválido: ${status}`);
  const agora = new Date().toISOString();
  const descricao = detalhe ? String(detalhe).slice(0, 250) : '';
  const body = expectedSource?.id
    ? `source_id=${Number(expectedSource.id)};` +
      `source_status=${String(expectedSource.status || '')};` +
      `source_at=${String(expectedSource.em || '')};${descricao}`
    : (descricao || null);
  const { error } = await db().from('messages').insert([rowComInstancia({
    phone: canalScope(),
    direction: 'system',
    body,
    is_test: process.env.NODE_ENV === 'test',
    wa_id: null,
    status,
    status_at: agora
  })]);
  if (error) throw error;
}

/** Insere AUTO_BLOCK somente se a fonte ainda for o snapshot lido. */
export async function registrarAutoBlockCondicional(veredito, detalhe = null) {
  if (!veredito?.sourceId) return false;
  const { data, error } = await db().rpc('registrar_auto_block_if_current', {
    p_instance: instanciaAtual(),
    p_scope: canalScope(),
    p_source_id: veredito.sourceId,
    p_source_status: veredito.status || null,
    p_source_at: veredito.em || null,
    p_detail: detalhe ? String(detalhe).slice(0, 250) : null,
    p_is_test: process.env.NODE_ENV === 'test'
  });
  if (error) throw error;
  return data === true;
}

/** Duas recusas seguidas isolam somente aquele destinatário. */
export async function resumoDestinoEnvio(phone, { limite = 2, incluirTestes = false } = {}) {
  let q = db().from('messages')
    .select('id, status, created_at')
    .eq('phone', phone)
    .eq('direction', 'out')
    .in('status', DEFINITIVOS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.max(1, limite));
  q = filtrarInstancia(q, { incluirLegado: true });
  q = q.eq('is_test', !!incluirTestes);
  const { data, error } = await q;
  if (error) throw error;

  let rejeicoesSeguidas = 0;
  for (const m of data || []) {
    if (m.status !== 'ERROR') break;
    rejeicoesSeguidas++;
  }
  return { bloqueado: rejeicoesSeguidas >= limite, rejeicoesSeguidas, limite };
}

/** Destinatários isolados sem confundir o estado deles com pane global. */
export async function listarDestinosBloqueados({ limite = 2, incluirTestes = false } = {}) {
  let q = db().from('messages')
    .select('id,phone,status,created_at')
    .eq('direction', 'out')
    .in('status', DEFINITIVOS)
    .eq('is_test', !!incluirTestes)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1000);
  q = filtrarInstancia(q, { incluirLegado: true });
  if (incluirTestes) {
    const phones = String(process.env.TEST_PHONES || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    if (!phones.length) return [];
    q = q.in('phone', phones);
  }
  const { data, error } = await q;
  if (error) throw error;

  const porTelefone = new Map();
  for (const item of data || []) {
    if (porTelefone.get(item.phone)?.encerrado) continue;
    const atual = porTelefone.get(item.phone) || {
      phone: item.phone, rejeicoesSeguidas: 0,
      ultimaRejeicao: null, encerrado: false
    };
    if (item.status === 'ERROR') {
      atual.rejeicoesSeguidas++;
      atual.ultimaRejeicao ||= item.created_at;
    } else {
      atual.encerrado = true;
    }
    porTelefone.set(item.phone, atual);
  }
  return [...porTelefone.values()]
    .filter(item => item.rejeicoesSeguidas >= limite)
    .map(({ encerrado, ...item }) => item)
    .slice(0, 50);
}

/**
 * As mensagens que saíram estão realmente CHEGANDO?
 *
 * Aceite não é entrega. Este resumo é o detector da falha silenciosa que
 * consumiu 08/08/2026: envio aceito com PENDING e nada no celular do cliente.
 */
// ERROR é o WhatsApp REJEITANDO a mensagem — diferente de "ainda sem
// confirmação". Foi o que revelou, em 08/08/2026, que o problema não era
// demora: era recusa. Merece nome próprio no diagnóstico.
export async function resumoEntrega({ minutos = 30, incluirTestes = false } = {}) {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  // Dá um tempo de graça: ACK não chega no mesmo instante.
  const maduro = new Date(Date.now() - 120_000).toISOString();

  let q = db().from('messages')
    .select('id, status, status_at, created_at')
    .eq('direction', 'out').eq('is_test', !!incluirTestes)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  q = filtrarInstancia(q, { incluirLegado: true });
  if (incluirTestes) {
    const phones = String(process.env.TEST_PHONES || '')
      .split(',').map(v => v.trim()).filter(Boolean);
    if (phones.length) q = q.in('phone', phones);
  }
  const { data, error } = await q;
  if (error) throw error;

  // BLOQUEADO nunca chegou a sair (freio de envio). Contar como "enviada sem
  // confirmação" faria o alarme apontar para o WhatsApp quando a causa é o
  // próprio freio — que já tem alarme próprio.
  const todas = (data || []).filter(m => !['BLOQUEADO', 'BLOQUEADO_DESTINO'].includes(m.status));
  const naoEnviadas = (data || []).length - todas.length;
  const antigas = todas.filter(m => m.created_at < maduro);
  const entregues = todas.filter(m => ENTREGUES.includes(m.status)).length;
  const rejeitadas = todas.filter(m => REJEITADAS.includes(m.status)).length;
  const semAck = antigas.filter(m => !m.status || ['PENDING', 'SERVER_ACK'].includes(m.status)).length;

  // Uma entrega posterior encerra a sequência de recusas. O código antigo
  // olhava "existe algum ERROR na janela?" e reengatava o freio mesmo depois
  // de uma sonda entregue.
  const definitivas = todas.filter(m => DEFINITIVOS.includes(m.status));
  let rejeicoesSeguidas = 0;
  for (const item of definitivas) {
    if (item.status !== 'ERROR') break;
    rejeicoesSeguidas++;
  }

  // ACK definitivo vale imediatamente. PENDING/SERVER_ACK só vira evidência
  // de falha depois dos dois minutos de graça.
  const avaliaveis = todas.filter(m => DEFINITIVOS.includes(m.status) || m.created_at < maduro);
  const ultimo = avaliaveis[0] || null;

  return {
    minutos,
    enviadas: todas.length,
    entregues,
    rejeitadas,
    naoEnviadas,
    noServidor: todas.filter(m => m.status === 'SERVER_ACK').length,
    semConfirmacao: semAck,
    rejeicoesSeguidas,
    ultimoStatus: ultimo?.status || null,
    ultimoVereditoEm: ultimo?.status_at || ultimo?.created_at || null,
    // null = sem dado suficiente; o veredito mais novo sempre vence o velho.
    saudavel: !ultimo ? null : ENTREGUES.includes(ultimo.status)
  };
}

export async function getMessages({ limit = 100, incluirTestes = false, de = null, ate = null } = {}) {
  let q = db().from('messages').select('*').in('direction', ['in', 'out']);
  q = filtrarInstancia(q, { incluirLegado: true });
  if (!incluirTestes) q = q.eq('is_test', false);
  if (de) q = q.gte('created_at', de);
  if (ate) q = q.lt('created_at', ate);

  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

/* ---------------- Histórico de conexão ---------------- */

/**
 * Grava queda/volta da conexão.
 *
 * A caixa preta é em memória e zera a cada deploy — não responde "quantas
 * vezes caiu esta semana?". Isto sobrevive, e é o que transforma "acho que cai
 * muito" em número.
 */
export async function registrarEventoConexao({ instance, event, status, foraMin, tentativas, detalhe }) {
  const { error } = await db().from('connection_events').insert([{
    instance: instance || null,
    event,
    status: status || null,
    fora_min: Number.isFinite(foraMin) ? foraMin : null,
    tentativas: tentativas || 0,
    detalhe: detalhe || null
  }]);
  if (error) warn('db.eventoConexaoFalhou', { erro: error.message });
}

/** Quedas, tempo fora e disponibilidade no período. */
export async function resumoConexao({ dias = 7, instance = null } = {}) {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString();

  let q = db()
    .from('connection_events').select('*')
    .gte('created_at', desde)
    .order('created_at', { ascending: false });
  if (instance) q = q.eq('instance', instance);
  const { data, error } = await q;
  if (error) throw error;

  const eventos = data || [];
  const quedas = eventos.filter(e => e.event === 'caiu');
  const voltas = eventos.filter(e => e.event === 'voltou');
  const minutosFora = voltas.reduce((a, v) => a + (v.fora_min || 0), 0);
  const minutosNoPeriodo = dias * 24 * 60;

  return {
    dias,
    quedas: quedas.length,
    voltas: voltas.length,
    minutosFora,
    // Só conta o que temos registro; sem histórico, não invento disponibilidade.
    disponibilidade: eventos.length
      ? Number((100 - (minutosFora / minutosNoPeriodo) * 100).toFixed(2))
      : null,
    maiorQuedaMin: voltas.reduce((m, v) => Math.max(m, v.fora_min || 0), 0) || null,
    ultimaQueda: quedas[0]?.created_at || null,
    eventos: eventos.slice(0, 40)
  };
}

/* ---------------- Keepalive ---------------- */

/**
 * Consulta mínima só para gerar atividade no projeto.
 *
 * O plano free do Supabase pausa projetos após 7 dias sem atividade e não
 * oferece nenhuma opção para desligar isso. Uma consulta periódica mantém o
 * contador zerado. Só o plano Pro remove o auto-pause por contrato.
 */
export async function keepalive() {
  const { error } = await db().from('triages').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return true;
}

/* ---------------- Triagens ---------------- */

const INTENT_LABELS = {
  lavar: 'Lavagem', estetica: 'Estética / detalhamento', agendar: 'Agendamento',
  valores: 'Consultar valores', duvida: 'Dúvida'
};

export async function saveTriage(t) {
  // `subject` é o resumo de uma linha usado na lista do dashboard.
  const subject = t.service || INTENT_LABELS[t.intent] || t.subject || 'Atendimento';

  const notas = [];
  if (t.has_question) notas.push('Cliente tem uma dúvida antes de fechar');
  if (t.profile_name && t.profile_name !== t.name) notas.push(`Perfil do WhatsApp: ${t.profile_name}`);
  if (t.note) notas.push(t.note);

  const { data, error } = await db().from('triages').insert([{
    phone: t.phone,
    name: t.name || 'Cliente',
    subject,
    intent: t.intent || null,
    category: t.category || null,
    vehicle: t.vehicle || null,
    service: t.service || null,
    need: t.need || null,
    level: t.level || null,
    period: t.period || null,
    date_pref: t.date_pref || null,
    recommended: !!t.recommended,
    origin: 'chatbot',
    note: notas.length ? notas.join(' · ') : null,
    status: 'pending',
    seen: false,
    is_test: isTestPhone(t.phone)
  }]).select();

  if (error) throw error;
  return data[0];
}

/**
 * @param {{limit?:number, incluirTestes?:boolean, de?:string, ate?:string}} f
 *   `de`/`ate` são ISO; `ate` é exclusivo, então o chamador passa o dia seguinte.
 */
export async function getTriages({ limit = 100, incluirTestes = false, de = null, ate = null } = {}) {
  let q = db().from('triages').select('*');
  if (!incluirTestes) q = q.eq('is_test', false);
  if (de) q = q.gte('created_at', de);
  if (ate) q = q.lt('created_at', ate);

  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

export async function updateTriageStatus(id, status) {
  const { data, error } = await db()
    .from('triages')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id).select();

  if (error) throw error;
  return data[0];
}

/** Os números do topo respeitam os mesmos filtros da lista. */
export async function getStats({ incluirTestes = false, de = null, ate = null } = {}) {
  let q = db().from('triages').select('status');
  if (!incluirTestes) q = q.eq('is_test', false);
  if (de) q = q.gte('created_at', de);
  if (ate) q = q.lt('created_at', ate);

  const { data, error } = await q;
  if (error) throw error;

  return data.reduce(
    (acc, r) => ({ ...acc, total: acc.total + 1, [r.status]: (acc[r.status] || 0) + 1 }),
    { total: 0, pending: 0, contacted: 0, completed: 0, rejected: 0 }
  );
}

/**
 * Apaga tudo o que está marcado como teste.
 *
 * Os testes servem para validar agora; o banco de produção não deve carregar
 * cliente inventado. Roda no boot fora de ambiente de teste e pelo botão do
 * dashboard. Só toca linhas com is_test = true.
 */
export async function purgeTestes({ phones = null } = {}) {
  const out = {};
  const escopo = Array.isArray(phones) ? [...new Set(phones.map(String).filter(Boolean))] : null;
  if (escopo && !escopo.length) {
    return { messages: 0, triages: 0, bot_sessions: 0 };
  }
  for (const tabela of ['messages', 'triages', 'bot_sessions']) {
    let q = db().from(tabela).delete().eq('is_test', true);
    if (escopo?.length) q = q.in('phone', escopo);
    const { data, error } = await q.select('*');
    if (error) throw new Error(`${tabela}: ${error.message}`);
    out[tabela] = data?.length || 0;
  }
  return out;
}

/** Quantos testes existem, para o dashboard oferecer o botão de mostrá-los. */
export async function contarTestes({ de = null, ate = null } = {}) {
  let q = db().from('triages').select('*', { count: 'exact', head: true }).eq('is_test', true);
  if (de) q = q.gte('created_at', de);
  if (ate) q = q.lt('created_at', ate);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

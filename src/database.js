import './env.js';
import { createClient } from '@supabase/supabase-js';
import { warn } from './recorder.js';
import { isTestPhone } from './testflag.js';

let supabase;

export async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  // service_role ignora RLS — é o certo para backend. Cai na anon key se não houver.
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

  if (!url || !key) throw new Error('SUPABASE_URL e SUPABASE_KEY (ou SUPABASE_SERVICE_KEY) são obrigatórias');

  supabase = createClient(url, key, { auth: { persistSession: false } });

  // Falha cedo e com mensagem clara se o setup.sql não rodou.
  for (const table of ['triages', 'bot_sessions', 'messages']) {
    const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) {
      throw new Error(
        `Tabela "${table}" inacessível (${error.message}). ` +
        'Rode o setup.sql no SQL Editor do Supabase.'
      );
    }
  }

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

export async function logMessage(phone, direction, body, waId = null, status = null) {
  // Log é observabilidade: nunca deve derrubar o atendimento.
  const { error } = await db().from('messages').insert([{
    phone, direction, body,
    is_test: isTestPhone(phone),
    wa_id: waId,
    status,
    status_at: status ? new Date().toISOString() : null
  }]);
  if (error) warn('db.logMensagemFalhou', { erro: error.message });
}

/** ACK de entrega chegou: promove o status da mensagem. */
export async function atualizarStatusMensagem(waId, status) {
  if (!waId || !status) return false;
  const { data, error } = await db().from('messages')
    .update({ status, status_at: new Date().toISOString() })
    .eq('wa_id', waId).select('id');
  if (error) { warn('db.statusMensagemFalhou', { erro: error.message }); return false; }
  return (data || []).length > 0;
}

/** Status atual de uma mensagem pelo id do WhatsApp — usado pela sonda. */
export async function statusPorWaId(waId) {
  if (!waId) return null;
  const { data, error } = await db().from('messages')
    .select('status, status_at').eq('wa_id', waId).limit(1);
  if (error) { warn('db.statusPorWaIdFalhou', { erro: error.message }); return null; }
  return (data || [])[0] || null;
}

/**
 * Último veredito conhecido do canal de envio.
 *
 * O freio mora em memória, então um deploy zeraria ele e o bot voltaria a
 * insistir num canal recusando — o exato comportamento que o freio existe para
 * impedir. Aqui o boot pergunta ao banco como terminou a última mensagem que
 * teve resposta definitiva do WhatsApp.
 */
export async function ultimoVereditoEnvio({ horas = 24 } = {}) {
  const desde = new Date(Date.now() - horas * 3600_000).toISOString();
  const { data, error } = await db().from('messages')
    .select('status, status_at, created_at')
    .eq('direction', 'out').eq('is_test', false)
    .in('status', ['ERROR', 'DELIVERY_ACK', 'READ', 'PLAYED'])
    .gte('created_at', desde)
    .order('created_at', { ascending: false }).limit(1);
  if (error) { warn('db.ultimoVereditoFalhou', { erro: error.message }); return null; }
  const m = (data || [])[0];
  if (!m) return null;
  return { status: m.status, em: m.status_at || m.created_at, recusado: m.status === 'ERROR' };
}

/**
 * As mensagens que saíram estão realmente CHEGANDO?
 *
 * Aceite não é entrega. Este resumo é o detector da falha silenciosa que
 * consumiu 08/08/2026: envio aceito com PENDING e nada no celular do cliente.
 */
const ENTREGUES = ['DELIVERY_ACK', 'READ', 'PLAYED'];
// ERROR é o WhatsApp REJEITANDO a mensagem — diferente de "ainda sem
// confirmação". Foi o que revelou, em 08/08/2026, que o problema não era
// demora: era recusa. Merece nome próprio no diagnóstico.
const REJEITADAS = ['ERROR'];

export async function resumoEntrega({ minutos = 30 } = {}) {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  // Dá um tempo de graça: ACK não chega no mesmo instante.
  const maduro = new Date(Date.now() - 120_000).toISOString();

  const { data, error } = await db().from('messages')
    .select('status, created_at')
    .eq('direction', 'out').eq('is_test', false)
    .gte('created_at', desde);
  if (error) throw error;

  // BLOQUEADO nunca chegou a sair (freio de envio). Contar como "enviada sem
  // confirmação" faria o alarme apontar para o WhatsApp quando a causa é o
  // próprio freio — que já tem alarme próprio.
  const todas = (data || []).filter(m => m.status !== 'BLOQUEADO');
  const naoEnviadas = (data || []).length - todas.length;
  const antigas = todas.filter(m => m.created_at < maduro);
  const entregues = todas.filter(m => ENTREGUES.includes(m.status)).length;
  const rejeitadas = todas.filter(m => REJEITADAS.includes(m.status)).length;
  const semAck = antigas.filter(m => !m.status || m.status === 'PENDING').length;

  return {
    minutos,
    enviadas: todas.length,
    entregues,
    rejeitadas,
    naoEnviadas,
    noServidor: todas.filter(m => m.status === 'SERVER_ACK').length,
    semConfirmacao: semAck,
    // null = sem dado suficiente para julgar. false = não está chegando.
    saudavel: antigas.length === 0 && !rejeitadas ? null : (entregues > 0 && !rejeitadas)
  };
}

export async function getMessages({ limit = 100, incluirTestes = false, de = null, ate = null } = {}) {
  let q = db().from('messages').select('*');
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
export async function resumoConexao({ dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString();

  const { data, error } = await db()
    .from('connection_events').select('*')
    .gte('created_at', desde)
    .order('created_at', { ascending: false });
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
export async function purgeTestes() {
  const out = {};
  for (const tabela of ['messages', 'triages', 'bot_sessions']) {
    const { data, error } = await db().from(tabela).delete().eq('is_test', true).select('*');
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

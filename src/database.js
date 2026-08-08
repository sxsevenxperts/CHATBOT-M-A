import './env.js';
import { createClient } from '@supabase/supabase-js';

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
  const row = { phone, updated_at: new Date().toISOString() };
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

/* ---------------- Mensagens ---------------- */

export async function logMessage(phone, direction, body) {
  // Log é observabilidade: nunca deve derrubar o atendimento.
  const { error } = await db().from('messages').insert([{ phone, direction, body }]);
  if (error) console.error('[db] falha ao logar mensagem:', error.message);
}

export async function getMessages(limit = 100) {
  const { data, error } = await db()
    .from('messages').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
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
    seen: false
  }]).select();

  if (error) throw error;
  return data[0];
}

export async function getTriages(limit = 100) {
  const { data, error } = await db()
    .from('triages').select('*').order('created_at', { ascending: false }).limit(limit);
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

export async function getStats() {
  const { data, error } = await db().from('triages').select('status');
  if (error) throw error;

  return data.reduce(
    (acc, r) => ({ ...acc, total: acc.total + 1, [r.status]: (acc[r.status] || 0) + 1 }),
    { total: 0, pending: 0, contacted: 0, completed: 0, rejected: 0 }
  );
}

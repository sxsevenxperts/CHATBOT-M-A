/**
 * Caixa preta: registro dos últimos eventos, em memória.
 *
 * Antes disto, tudo o que o sistema fazia existia apenas no console do
 * container — invisível para quem opera. Diagnosticar significava pedir os
 * logs a alguém com acesso ao servidor.
 *
 * Agora cada evento relevante fica num anel de tamanho fixo e aparece no
 * dashboard. Continua indo para o console também, para quem tiver acesso.
 *
 * É deliberadamente em memória: zera a cada deploy e nunca cresce. O que
 * precisa durar (triagens, mensagens, sessões) está no Supabase.
 */

const MAX = 400;
const anel = [];
let seq = 0;

const contagem = { info: 0, warn: 0, error: 0 };

/** Corta textos longos: a caixa preta é para operar, não para reler conversas. */
function enxugar(meta) {
  if (!meta || typeof meta !== 'object') return meta ?? null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'string') out[k] = v.length > 80 ? v.slice(0, 80) + '…' : v;
    else if (typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 120);
    else out[k] = v;
  }
  return out;
}

function linha(level, event, meta) {
  const partes = Object.entries(meta || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return `[${event}]${partes ? ' ' + partes : ''}`;
}

export function rec(level, event, meta = null) {
  const limpo = enxugar(meta);
  const ev = { seq: ++seq, at: new Date().toISOString(), level, event, meta: limpo };

  anel.push(ev);
  if (anel.length > MAX) anel.shift();
  contagem[level] = (contagem[level] || 0) + 1;

  const texto = linha(level, event, limpo);
  if (level === 'error') console.error(texto);
  else if (level === 'warn') console.warn(texto);
  else console.log(texto);

  return ev;
}

export const info  = (event, meta) => rec('info', event, meta);
export const warn  = (event, meta) => rec('warn', event, meta);
export const error = (event, meta) => rec('error', event, meta);

/** Erros de exceção, com a mensagem já extraída do formato do axios. */
export function falha(event, err, meta = {}) {
  const detalhe = err?.response?.data
    ? JSON.stringify(err.response.data).slice(0, 200)
    : err?.message || String(err);
  return rec('error', event, { ...meta, erro: detalhe });
}

/**
 * @param {{level?: string, limit?: number}} opts
 * @returns {Array} do mais recente para o mais antigo
 */
export function list({ level = null, limit = 200 } = {}) {
  const filtrado = level && level !== 'all' ? anel.filter(e => e.level === level) : anel;
  return filtrado.slice(-Math.min(limit, MAX)).reverse();
}

export function resumo() {
  return {
    total: seq,
    emMemoria: anel.length,
    capacidade: MAX,
    porNivel: { ...contagem },
    maisAntigo: anel[0]?.at || null,
    maisRecente: anel[anel.length - 1]?.at || null
  };
}

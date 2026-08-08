import { num } from './env.js';
import { info, warn, falha } from './recorder.js';

/**
 * Freio de envio.
 *
 * Em 08/08/2026 o WhatsApp começou a devolver ACK ERROR em TODO envio deste
 * número: a Evolution aceitava (PENDING) e nada chegava. O bot seguiu
 * "conversando" por horas — cada resposta rejeitada reforçava o padrão de
 * automação no número, e o cliente ficava sem resposta sem ninguém saber.
 *
 * Regra nova: rejeição seguida engata o freio. O app para de enviar, registra
 * a mensagem que deixou de sair (status BLOQUEADO) e passa o caso para o
 * humano. Só volta a enviar quando uma entrega REAL acontece — a sonda manual
 * da dashboard. Nunca por tentativa automática: insistir foi o que agravou.
 */

const LIMITE = () => Math.max(1, num('FREIO_REJEICOES', 3));

const st = {
  bloqueado: false,
  desde: null,
  motivo: null,
  rejeicoesSeguidas: 0,
  ultimaRejeicao: null,
  ultimaEntrega: null,
  naoEnviadas: 0
};

/** ACK ERROR: o WhatsApp recusou. Três seguidas e o freio engata. */
export function registrarRejeicao(waId = null) {
  st.rejeicoesSeguidas += 1;
  st.ultimaRejeicao = new Date().toISOString();
  if (!st.bloqueado && st.rejeicoesSeguidas >= LIMITE()) {
    bloquear(`${st.rejeicoesSeguidas} envios seguidos recusados pelo WhatsApp (ACK ERROR)`);
  } else if (!st.bloqueado) {
    warn('freio.rejeicao', { id: waId, seguidas: st.rejeicoesSeguidas, limite: LIMITE() });
  }
  return st.bloqueado;
}

/** Entrega confirmada: o canal está de pé. Zera o contador e solta o freio. */
export function registrarEntrega(waId = null) {
  st.rejeicoesSeguidas = 0;
  st.ultimaEntrega = new Date().toISOString();
  if (st.bloqueado) {
    st.bloqueado = false;
    st.desde = null;
    st.motivo = null;
    info('freio.liberadoPorEntrega', { id: waId });
  }
  return false;
}

export function bloquear(motivo = 'bloqueio manual') {
  if (st.bloqueado) return st;
  st.bloqueado = true;
  st.desde = new Date().toISOString();
  st.motivo = motivo;
  falha('freio.engatado', new Error(motivo), {
    acao: 'atender manualmente pelo WhatsApp; usar "Testar envio" na dashboard antes de religar o bot'
  });
  return st;
}

export function liberar(quem = 'dashboard') {
  const estava = st.bloqueado;
  st.bloqueado = false;
  st.desde = null;
  st.motivo = null;
  st.rejeicoesSeguidas = 0;
  if (estava) info('freio.liberado', { por: quem });
  return st;
}

export function bloqueado() {
  return st.bloqueado;
}

/** Uma resposta deixou de sair por causa do freio. */
export function contarNaoEnviada() {
  st.naoEnviadas += 1;
  return st.naoEnviadas;
}

export function ver() {
  return { ...st, limite: LIMITE() };
}

/** Só para os testes: devolve o módulo ao estado de fábrica. */
export function _reset() {
  st.bloqueado = false;
  st.desde = null;
  st.motivo = null;
  st.rejeicoesSeguidas = 0;
  st.ultimaRejeicao = null;
  st.ultimaEntrega = null;
  st.naoEnviadas = 0;
}

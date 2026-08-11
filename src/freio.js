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
const MIN_DESTINOS = () => Math.min(LIMITE(), Math.max(1, num('FREIO_DESTINOS_MIN', 3)));

export function limite() {
  return LIMITE();
}

const st = {
  bloqueado: false,
  desde: null,
  motivo: null,
  rejeicoesSeguidas: 0,
  destinatariosRejeitados: 0,
  ultimaRejeicao: null,
  ultimaEntrega: null,
  naoEnviadas: 0
};

/** ACK ERROR: o WhatsApp recusou. Três seguidas e o freio engata. */
export function registrarRejeicao(waId = null) {
  st.rejeicoesSeguidas += 1;
  st.destinatariosRejeitados = Math.max(st.destinatariosRejeitados, 1);
  st.ultimaRejeicao = new Date().toISOString();
  if (!st.bloqueado && st.rejeicoesSeguidas >= LIMITE() &&
      st.destinatariosRejeitados >= MIN_DESTINOS()) {
    bloquear(`${st.rejeicoesSeguidas} envios seguidos recusados pelo WhatsApp (ACK ERROR)`);
  } else if (!st.bloqueado) {
    warn('freio.rejeicao', { id: waId, seguidas: st.rejeicoesSeguidas, limite: LIMITE() });
  }
  return st.bloqueado;
}

/** Entrega confirmada: o canal está de pé. Zera o contador e solta o freio. */
export function registrarEntrega(waId = null) {
  st.rejeicoesSeguidas = 0;
  st.destinatariosRejeitados = 0;
  st.ultimaEntrega = new Date().toISOString();
  if (st.bloqueado) {
    st.bloqueado = false;
    st.desde = null;
    st.motivo = null;
    info('freio.liberadoPorEntrega', { id: waId });
  }
  return false;
}

/**
 * Reidrata a sequência persistida no banco depois de restart/deploy.
 * Uma ou duas recusas não podem silenciar todo o bot quando o limite é três;
 * a próxima recusa nova continua a contagem correta.
 */
export function restaurarRejeicoes(quantidade = 0, ultima = null) {
  return sincronizar({
    status: quantidade ? 'ERROR' : 'DELIVERY_ACK',
    em: ultima,
    rejeicoesSeguidas: Math.max(0, Number(quantidade) || 0),
    destinatariosRejeitados: Array.from({ length: Math.max(0, Number(quantidade) || 0) }, (_, i) => `legado-${i}`)
  });
}

/** Faz a memória refletir o veredito persistido, independentemente da ordem dos webhooks. */
export function sincronizar(veredito = null, origem = 'banco') {
  if (!veredito) return ver();

  const destinos = Array.isArray(veredito.destinatariosRejeitados)
    ? veredito.destinatariosRejeitados.length
    : Math.max(0, Number(veredito.destinatariosRejeitados) || 0);
  st.rejeicoesSeguidas = Math.max(0, Number(veredito.rejeicoesSeguidas) || 0);
  st.destinatariosRejeitados = destinos;
  st.ultimaRejeicao = st.rejeicoesSeguidas ? (veredito.em || st.ultimaRejeicao) : null;

  const deveBloquear = !!veredito.bloqueioManual ||
    (st.rejeicoesSeguidas >= LIMITE() && destinos >= MIN_DESTINOS());

  if (deveBloquear && !st.bloqueado) {
    bloquear(veredito.bloqueioManual
      ? veredito.status === 'AUTO_BLOCK'
        ? 'pane global de entrega persistida'
        : 'bloqueio manual persistido'
      : `${st.rejeicoesSeguidas} envios seguidos recusados em ${destinos} destinatários (ACK ERROR)`);
    if (veredito.em) st.desde = veredito.em;
  } else if (!deveBloquear && st.bloqueado) {
    st.bloqueado = false;
    st.desde = null;
    st.motivo = null;
    if (['DELIVERY_ACK', 'READ', 'PLAYED', 'PROBE_DELIVERED'].includes(veredito.status)) {
      st.ultimaEntrega = veredito.em || new Date().toISOString();
    }
    info('freio.sincronizadoLiberado', { por: origem, status: veredito.status || '—' });
  }
  return ver();
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
  st.destinatariosRejeitados = 0;
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
  return { ...st, limite: LIMITE(), minimoDestinatarios: MIN_DESTINOS() };
}

/** Só para os testes: devolve o módulo ao estado de fábrica. */
export function _reset() {
  st.bloqueado = false;
  st.desde = null;
  st.motivo = null;
  st.rejeicoesSeguidas = 0;
  st.destinatariosRejeitados = 0;
  st.ultimaRejeicao = null;
  st.ultimaEntrega = null;
  st.naoEnviadas = 0;
}

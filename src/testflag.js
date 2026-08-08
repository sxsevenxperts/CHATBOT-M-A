import './env.js';
import { str } from './env.js';

/**
 * Decide se um número é de teste.
 *
 * Existe para que o painel de Solicitações mostre só atendimento de verdade.
 * Sem isso, cada teste sujava a lista da atendente com cliente inventado.
 *
 * Um número é de teste quando:
 *   1. é o próprio número da instância — conversar consigo mesmo é sempre teste;
 *   2. está em TEST_PHONES (lista separada por vírgula).
 *
 * A marcação acontece na gravação, então o histórico não muda de classificação
 * depois: o que entrou como real continua real.
 */

const digitos = v => String(v || '').replace(/\D/g, '');

let proprioNumero = null;

/** Chamado no boot, com o ownerJid da instância conectada. */
export function setProprioNumero(jid) {
  proprioNumero = digitos(String(jid || '').split('@')[0]);
  return proprioNumero;
}

export function getProprioNumero() {
  return proprioNumero;
}

export function isTestPhone(phone) {
  const d = digitos(phone);
  if (!d) return false;
  if (proprioNumero && d === proprioNumero) return true;

  return str('TEST_PHONES')
    .split(',')
    .map(digitos)
    .filter(Boolean)
    .includes(d);
}

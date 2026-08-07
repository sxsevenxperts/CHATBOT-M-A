import dotenv from 'dotenv';

/**
 * Carrega o .env no momento em que ESTE módulo é avaliado.
 *
 * Motivo: em ESM os imports são avaliados ANTES de qualquer statement do
 * módulo que importa. Chamar dotenv.config() no corpo do index.js é tarde
 * demais — os módulos importados já leram process.env vazio.
 *
 * Todo módulo que precisa de env importa este primeiro. Ainda assim, as
 * leituras abaixo são tardias (dentro de funções), então a ordem de import
 * deixa de ser um ponto de falha.
 */
dotenv.config();

export const str = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim();
export const num = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};

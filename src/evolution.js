import './env.js';
import { str } from './env.js';
import axios from 'axios';

/**
 * Cliente da Evolution API v2.
 *
 * Duas armadilhas que já custaram caro aqui:
 *  1. A base URL NÃO pode terminar em /manager. /manager é o frontend web;
 *     ele responde 200 com HTML e a chamada "funciona" sem fazer nada.
 *  2. sendText na v2 usa payload achatado {number, text}. O formato v1
 *     ({options, textMessage:{text}}) devolve 400.
 */

function normalizeBaseUrl(raw) {
  if (!raw) throw new Error('EVOLUTION_API_URL não configurada');
  return raw.trim().replace(/\/+$/, '').replace(/\/manager$/i, '');
}

// Leitura tardia e memoizada: no momento do import o .env pode não ter
// sido carregado ainda (ver src/env.js).
let _conf = null;
let _client = null;

function conf() {
  if (!_conf) {
    _conf = {
      baseUrl: normalizeBaseUrl(str('EVOLUTION_API_URL')),
      apiKey: str('EVOLUTION_API_KEY'),
      instance: str('EVOLUTION_INSTANCE')
    };
    if (!_conf.instance) throw new Error('EVOLUTION_INSTANCE não configurada');
  }
  return _conf;
}

function client() {
  if (!_client) {
    const c = conf();
    _client = axios.create({
      baseURL: c.baseUrl,
      timeout: 20000,
      headers: { apikey: c.apiKey, 'Content-Type': 'application/json' }
    });
  }
  return _client;
}

export function getConfig() {
  const c = conf();
  return { baseUrl: c.baseUrl, instance: c.instance };
}

/** Confere que a API responde e que a instância está conectada. */
export async function checkConnection() {
  const { data } = await client().get('/instance/fetchInstances');
  const list = Array.isArray(data) ? data : data?.instances || [];
  const instance = list.find(i => (i.name || i.instanceName) === conf().instance);

  if (!instance) {
    const nomes = list.map(i => i.name || i.instanceName).join(', ') || '(nenhuma)';
    throw new Error(`Instância "${conf().instance}" não existe. Disponíveis: ${nomes}`);
  }

  return {
    name: instance.name || instance.instanceName,
    status: instance.connectionStatus,
    connected: instance.connectionStatus === 'open',
    ownerJid: instance.ownerJid,
    profileName: instance.profileName
  };
}

export async function listInstances() {
  const { data } = await client().get('/instance/fetchInstances');
  const list = Array.isArray(data) ? data : data?.instances || [];
  return list.map(i => ({
    name: i.name || i.instanceName,
    status: i.connectionStatus,
    connected: i.connectionStatus === 'open',
    ownerJid: i.ownerJid,
    profileName: i.profileName,
    profilePicUrl: i.profilePicUrl
  }));
}

/**
 * Pede à Evolution para restabelecer a sessão.
 *
 * Serve para queda transitória (status `connecting`/`close`), que se resolve
 * sozinha. Se a sessão foi invalidada pelo WhatsApp, devolve um QR — aí só
 * escaneando. Em ambos os casos é melhor tentar do que esperar alguém notar.
 */
export async function reconnect() {
  const { data } = await client().get(`/instance/connect/${encodeURIComponent(conf().instance)}`);
  return {
    precisaQr: !!data?.base64,
    qr: data?.base64 || null,
    pairingCode: data?.pairingCode || null
  };
}

/** Reinicia a instância. Resolve estado travado sem precisar do Evolution Manager. */
export async function restartInstance() {
  const { data } = await client().post(`/instance/restart/${encodeURIComponent(conf().instance)}`);
  return data;
}

/** QR code para pareamento (só existe quando a instância está desconectada). */
export async function getQrCode(instanceName) {
  instanceName = instanceName || conf().instance;
  const { data } = await client().get(`/instance/connect/${encodeURIComponent(instanceName)}`);
  return { base64: data?.base64 || null, code: data?.code || null, pairingCode: data?.pairingCode || null };
}

/** Envia texto. Payload v2: {number, text}. */
export async function sendText(number, text) {
  const to = String(number).replace(/\D/g, '');
  const { data } = await client().post(`/message/sendText/${encodeURIComponent(conf().instance)}`, {
    number: to,
    text
  });
  return data;
}

/**
 * Mostra "digitando…" no chat do cliente. Best-effort: se a rota não existir
 * nesta build da Evolution, o atendimento segue sem o indicador.
 */
export async function sendPresence(number, presence = 'composing') {
  const to = String(number).replace(/\D/g, '');
  try {
    await client().post(`/chat/sendPresence/${encodeURIComponent(conf().instance)}`, {
      number: to, presence, delay: 1200
    });
  } catch {
    /* indicador é cosmético — nunca deve bloquear a resposta */
  }

}

/** Aponta o webhook da instância para a nossa URL, só com os eventos que usamos. */
export async function setWebhook(url) {
  const { data } = await client().post(`/webhook/set/${encodeURIComponent(conf().instance)}`, {
    webhook: {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      // Só MESSAGES_UPSERT. Habilitar SEND_MESSAGE faz o bot receber
      // webhook das próprias respostas -> loop infinito.
      events: ['MESSAGES_UPSERT']
    }
  });
  return data;
}

export async function getWebhook() {
  const { data } = await client().get(`/webhook/find/${encodeURIComponent(conf().instance)}`);
  return data;
}

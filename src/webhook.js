import { handleMessage } from './flow.js';
import crypto from 'node:crypto';
import {
  atualizarStatusMensagem,
  persistirEntradaWebhook,
  reivindicarEntradaWebhook,
  concluirEntradaWebhook,
  falharEntradaWebhook,
  listarEntradasWebhookPendentes
} from './database.js';
import {
  getConfig, validarWebhookSecret, WEBHOOK_SECRET_HEADER, validarEvolutionApiKey
} from './evolution.js';
import { reconciliarFreioPersistido } from './canal.js';
import { info, warn, falha } from './recorder.js';
import { serializar, filasAbertas } from './serial.js';

/**
 * Recebe os webhooks MESSAGES_UPSERT da Evolution API v2.
 *
 * Formato real da v2 (o que quebrou a primeira versão deste arquivo):
 *   { event: "messages.upsert", instance: "3041",
 *     data: { key: { remoteJid, fromMe, id }, pushName,
 *             message: { conversation: "..." }, messageType } }
 *
 * Não existe `body.remoteJid` nem `body.body` — está tudo sob `data`.
 */

const WEBHOOK_PATH = '/webhook/messages';

// Evolution reentrega o mesmo evento em falha de rede. Sem isto o cliente
// recebe a mesma pergunta duas vezes.
// Quantos eventos estão sendo processados agora. Serve de observabilidade em
// /health e permite que os testes esperem a quiescência em vez de chutar sleeps.
let inflight = 0;
export const getInflight = () => inflight;
export { filasAbertas };

let ackQueue = Promise.resolve();

function serializarAcks(task) {
  const job = ackQueue.then(task, task);
  ackQueue = job.catch(() => {});
  return job;
}

async function casarAck(waId, status) {
  let transicao = { matched: false, changed: false };
  // A Evolution pode publicar o webhook milissegundos antes de sendText
  // devolver e o app inserir wa_id. Retentar por 520 ms fecha essa corrida.
  for (const espera of [0, 120, 400]) {
    if (espera) await new Promise(resolve => setTimeout(resolve, espera));
    transicao = await atualizarStatusMensagem(waId, status);
    if (transicao.matched) break;
  }
  return transicao;
}

/** Texto pode vir em ~8 lugares diferentes dependendo do tipo de mensagem. */
function extractText(message) {
  if (!message) return '';

  const inner = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message;

  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.buttonsResponseMessage?.selectedDisplayText ||
    inner.templateButtonReplyMessage?.selectedDisplayText ||
    inner.listResponseMessage?.title ||
    inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    ''
  ).toString().trim();
}

export function setupWebhook(app, { isReady = () => true } = {}) {
  app.post(WEBHOOK_PATH, (req, res) => {
    // Durante o rollout, a Evolution ainda usa a configuração antiga sem o
    // header por alguns instantes. 503 vem antes da autenticação para que ela
    // retente depois que o boot terminar de sincronizar e confirmar o segredo.
    if (!isReady()) {
      warn('webhook.bootPendente', { evento: req.body?.event || '—' });
      return res.status(503).json({ ok: false, retry: true, error: 'inicializando' });
    }

    // A instância é conhecida publicamente; ela não é autenticação. O header
    // abaixo é configurado automaticamente na Evolution durante o boot.
    if (!validarWebhookSecret(req.get(WEBHOOK_SECRET_HEADER)) &&
        !validarEvolutionApiKey(req.body?.apikey)) {
      warn('webhook.naoAutorizado', { ip: req.ip || '—' });
      return res.status(401).json({ ok: false, error: 'webhook não autorizado' });
    }

    const event = String(req.body?.event || '').toLowerCase();
    const ackDuravel = event.startsWith('messages.update');

    // ACK e entrada só recebem 2xx depois da persistência durável. O fluxo de
    // conversa continua assíncrono (delay humanizado), mas agora um restart
    // depois do 200 retoma pelo inbox em vez de perder a mensagem do cliente.
    inflight++;
    const job = processar(req.body);

    // ACK é pequeno e a Evolution 2.3.7 espera até 30s. Só devolve 2xx depois
    // de atualizar a saída ou persistir o órfão; falha de banco recebe 503 e
    // mantém as retentativas da Evolution vivas.
    job.then(() => res.status(200).json({ ok: true }))
      .catch(err => {
        falha('webhook.erro', err);
        res.status(503).json({
          ok: false,
          retry: true,
          error: ackDuravel ? 'ACK não persistido' : 'entrada não persistida'
        });
      })
      .finally(() => { inflight--; });
  });

  async function processar(body) {
    {
      body = body || {};
      const event = String(body.event || '').toLowerCase();
      const recebidaDe = String(body.instance || '').trim();
      const esperada = getConfig().instance;

      // A rota é pública e pode receber eventos atrasados/indevidos. Um ACK
      // de outra instância jamais pode bloquear ou liberar a instância 3041.
      if (!recebidaDe || recebidaDe !== esperada) {
        info('webhook.ignorado', {
          motivo: recebidaDe ? 'outra instância' : 'instância ausente',
          instancia: recebidaDe || '—'
        });
        return;
      }

      // ACK de entrega: é o que separa "aceito" de "chegou".
      if (event.startsWith('messages.update')) {
        await serializarAcks(async () => {
          const itens = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean);
          let casouAlgum = false;
          for (const it of itens) {
            const waId = it?.keyId || it?.key?.id || it?.id || null;
            const st = it?.status || it?.update?.status || null;
            if (!waId || !st) continue;
            const status = String(st).toUpperCase();
            const transicao = await casarAck(waId, status);
            info('webhook.ack', {
              id: waId,
              status,
              casou: transicao.matched,
              mudou: transicao.changed,
              enfileirado: !!transicao.queued,
              anterior: transicao.previous || null
            });
            casouAlgum ||= !!transicao.matched;
          }

          // O banco é a fonte canônica. Assim ACKs concorrentes ou tardios
          // nunca deixam o freio em ordem diferente do histórico persistido.
          if (casouAlgum) {
            await reconciliarFreioPersistido('webhook');
          }
        });
        return;
      }

      if (event && !event.startsWith('messages.upsert')) {
        info('webhook.ignorado', { motivo: 'outro evento', evento: event });
        return;
      }

      // `data` costuma ser objeto, mas algumas versões mandam array.
      const items = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean);

      for (const item of items) {
        const key = item.key || {};
        const remoteJid = key.remoteJid || '';

        if (key.fromMe) {
          info('webhook.ignorado', { motivo: 'fromMe (anti-loop)' });
          continue;
        }
        if (!remoteJid || remoteJid.endsWith('@g.us')) {
          info('webhook.ignorado', { motivo: 'grupo' });
          continue;
        }
        if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) {
          info('webhook.ignorado', { motivo: 'status/broadcast' });
          continue;
        }
        const phone = remoteJid.split('@')[0].split(':')[0];
        const waId = key.id || 'sem-id-' + crypto.createHash('sha256')
          .update(JSON.stringify(item)).digest('hex').slice(0, 32);
        const entrada = await persistirEntradaWebhook({ waId, phone, payload: item });
        if (entrada.status === 'PROCESSED') {
          info('webhook.ignorado', { motivo: 'reentrega processada', id: waId });
          continue;
        }
        agendarEntrada(entrada);
      }
    }
  }

  // Sonda de saúde: confirma no navegador que a rota existe.
  app.get(WEBHOOK_PATH, (_req, res) =>
    res.json({ ok: true, hint: 'endpoint ativo; a Evolution API deve usar POST aqui' })
  );

  info('webhook.rota', { path: WEBHOOK_PATH });
}

function agendarEntrada(entrada) {
  inflight++;
  const job = serializar(entrada.phone, async () => {
    const claim = await reivindicarEntradaWebhook(entrada);
    if (!claim.claimed) return;
    try {
      const item = JSON.parse(entrada.body);
      const text = extractText(item.message);
      const pushName = item.pushName || '';
      info('webhook.recebido', {
        de: entrada.phone,
        perfil: pushName || '—',
        texto: text || '[sem texto]'
      });
      const resultado = await handleMessage({
        phone: entrada.phone,
        text,
        pushName,
        inboxId: entrada.wa_id
      });
      if (['send_blocked', 'handoff_pending'].includes(resultado?.action)) {
        throw new Error(`Resposta pendente: ${resultado.action}`);
      }
      await concluirEntradaWebhook(entrada.id, claim.claimAt);
    } catch (e) {
      try {
        const devolvido = await falharEntradaWebhook(entrada.id, claim.claimAt);
        if (!devolvido) {
          warn('webhook.leasePerdido', { id: entrada.wa_id, de: entrada.phone });
        }
      }
      catch (persistencia) {
        e.message += `; falha ao devolver inbox para retry: ${persistencia.message}`;
      }
      throw e;
    }
  });
  job.catch(err => falha('webhook.processamentoFalhou', err, {
    id: entrada.wa_id,
    de: entrada.phone,
    acao: 'mantido no inbox para retry automático'
  })).finally(() => { inflight--; });
}

/** Reagenda mensagens aceitas antes de um restart ou falha transitória. */
export async function retomarEntradasWebhook() {
  const pendentes = await listarEntradasWebhookPendentes({ limite: 100 });
  pendentes.forEach(agendarEntrada);
  return pendentes.length;
}

export { WEBHOOK_PATH };

import { handleMessage } from './flow.js';

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

const seenIds = new Set();
const SEEN_MAX = 2000;

function rememberId(id) {
  if (!id) return false;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) {
    // Descarta a metade mais antiga (Set preserva ordem de inserção).
    const keep = [...seenIds].slice(-SEEN_MAX / 2);
    seenIds.clear();
    keep.forEach(k => seenIds.add(k));
  }
  return false;
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

export function setupWebhook(app) {
  app.post(WEBHOOK_PATH, (req, res) => {
    // Responde na hora e processa depois.
    //
    // O atendimento leva alguns segundos de propósito (delay humanizado de
    // 3–5s + envio pela Evolution). Se a resposta HTTP esperasse por isso, a
    // Evolution estouraria o timeout dela e reentregaria o evento. A dedupe
    // por id do `rememberId` cobre reentregas, mas não gerar retentativa é
    // melhor do que absorvê-la.
    res.status(200).json({ ok: true });

    inflight++;
    processar(req.body)
      .catch(err => {
        console.error('[webhook] erro ao processar:', err?.message || err);
        if (err?.response?.data) console.error('[webhook] detalhe:', err.response.data);
      })
      .finally(() => { inflight--; });
  });

  async function processar(body) {
    {
      body = body || {};
      const event = String(body.event || '').toLowerCase();

      if (event && !event.startsWith('messages.upsert')) {
        console.log(`[webhook] ignorado: evento ${event}`);
        return;
      }

      // `data` costuma ser objeto, mas algumas versões mandam array.
      const items = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean);

      for (const item of items) {
        const key = item.key || {};
        const remoteJid = key.remoteJid || '';

        if (key.fromMe) {
          console.log('[webhook] ignorado: mensagem própria (fromMe)');
          continue;
        }
        if (!remoteJid || remoteJid.endsWith('@g.us')) {
          console.log('[webhook] ignorado: grupo');
          continue;
        }
        if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) {
          console.log('[webhook] ignorado: status/broadcast');
          continue;
        }
        if (rememberId(key.id)) {
          console.log(`[webhook] ignorado: evento repetido ${key.id}`);
          continue;
        }

        const phone = remoteJid.split('@')[0].split(':')[0];
        const text = extractText(item.message);
        const pushName = item.pushName || '';

        console.log(`[webhook] ← ${phone} (${pushName || 'sem nome'}): ${text || '[sem texto]'}`);

        // Sequencial de propósito: duas mensagens do mesmo cliente no mesmo
        // lote precisam avançar o fluxo em ordem.
        await handleMessage({ phone, text, pushName });
      }
    }
  }

  // Sonda de saúde: confirma no navegador que a rota existe.
  app.get(WEBHOOK_PATH, (_req, res) =>
    res.json({ ok: true, hint: 'endpoint ativo; a Evolution API deve usar POST aqui' })
  );

  console.log(`[webhook] rota registrada: POST ${WEBHOOK_PATH}`);
}

export { WEBHOOK_PATH };

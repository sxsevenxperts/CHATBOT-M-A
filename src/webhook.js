import express from 'express';
import { handleIncomingMessage } from './bot.js';

export function setupWebhook(app) {
  const WEBHOOK_PATH = '/webhook/messages';

  // POST: Receber webhook do Evolution API
  app.post(WEBHOOK_PATH, express.json(), async (req, res) => {
    try {
      const message = req.body;

      console.log('📨 Webhook recebido:', {
        from: message.remoteJid,
        type: message.type,
        body: message.body
      });

      // Validar se é uma mensagem de texto
      if (message.type === 'textMessage' && message.body) {
        await handleIncomingMessage({
          remoteJid: message.remoteJid,
          body: message.body,
          messageTimestamp: message.messageTimestamp
        });
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao processar webhook:', error);
      res.status(500).json({ error: 'Erro ao processar mensagem' });
    }
  });

  console.log(`\n🎣 Webhook configurado em: ${WEBHOOK_PATH}`);
  console.log(`Configurar no Evolution API Manager:\nURL: http://seu-dominio.com${WEBHOOK_PATH}\n`);
}

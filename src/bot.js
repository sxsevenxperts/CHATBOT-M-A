import axios from 'axios';
import { saveTriage, getSupabase } from './database.js';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE;

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json'
  }
});

const SERVICES = ['Lavagem Básica', 'Lavagem Premium', 'Polimento'];
const BUSINESS_HOURS = {
  1: { start: 7, end: 18 }, // Seg-Sex
  2: { start: 7, end: 18 },
  3: { start: 7, end: 18 },
  4: { start: 7, end: 18 },
  5: { start: 7, end: 18 },
  6: { start: 7, end: 14 }, // Sábado
  0: null // Domingo fechado
};

const triageFlow = new Map();

export async function initBot() {
  console.log('✅ Bot Evolution API inicializado');
  console.log(`📱 Instância: ${EVOLUTION_INSTANCE}`);
  console.log(`🔑 API conectada\n`);

  // Simula webhook para receber mensagens
  setupWebhookListener();
}

function setupWebhookListener() {
  // Nota: Em produção, o Evolution API envia webhooks para um endpoint.
  // Aqui simulamos o recebimento periodicamente.
  console.log('🎧 Aguardando mensagens do Evolution API...');
}

export async function handleIncomingMessage(message) {
  const { remoteJid, body, messageTimestamp } = message;
  const phoneNumber = remoteJid.split('@')[0];

  console.log(`📨 Mensagem de ${phoneNumber}: ${body}`);

  if (!triageFlow.has(phoneNumber)) {
    triageFlow.set(phoneNumber, { step: 0, data: { phone: phoneNumber } });
    await sendMessage(phoneNumber, '👋 Olá! Bem-vindo ao M & A Lava a Jato!\n\n📝 Qual é o seu nome?');
    return;
  }

  const flow = triageFlow.get(phoneNumber);
  const data = flow.data;

  switch (flow.step) {
    case 0: // Nome
      data.name = body;
      flow.step = 1;
      await sendMessage(phoneNumber, '👤 Você já é nosso cliente?', ['Sim', 'Não']);
      break;

    case 1: // É cliente?
      data.is_customer = body.toLowerCase() === 'sim' ? true : false;
      flow.step = 2;
      await sendMessage(phoneNumber, '🚗 Qual é o tipo do seu veículo?\n\nEx: Carro, Moto, Caminhonete');
      break;

    case 2: // Tipo de carro
      data.vehicle = body;
      flow.step = 3;
      const servicesText = SERVICES.map((s, i) => `${i + 1}. ${s}`).join('\n');
      await sendMessage(phoneNumber, `🧼 Qual serviço deseja?\n\n${servicesText}`, SERVICES);
      break;

    case 3: // Serviço
      if (!SERVICES.includes(body)) {
        await sendMessage(phoneNumber, '❌ Serviço não reconhecido. Tente novamente.', SERVICES);
        return;
      }

      data.service = body;
      triageFlow.delete(phoneNumber);

      // Salva triagem no banco
      await saveTriage(data);

      // Notifica atendente
      await notifyAttendant(data);

      // Confirma ao cliente
      await sendMessage(
        phoneNumber,
        `✅ Perfeito, ${data.name}!\n\nSeu pedido foi registrado. Um atendente entrará em contato em breve!\n\n📍 M & A Lava a Jato\nCampo dos Velhos, Sobral - CE\n☎️ 88 99431-2939`
      );
      break;

    default:
      await sendMessage(phoneNumber, '❓ Não entendi. Tente novamente.');
  }
}

export async function sendMessage(phoneNumber, text, buttons = null) {
  try {
    const payload = {
      number: phoneNumber,
      options: {
        delay: 1000,
        presence: 'composing',
        linkPreview: false
      },
      textMessage: {
        text: text
      }
    };

    if (buttons && buttons.length > 0) {
      payload.buttonMessage = {
        title: text,
        buttons: buttons.map(btn => ({
          buttonId: btn,
          buttonText: { displayText: btn }
        }))
      };
    }

    await evolutionClient.post(`/message/sendText/${EVOLUTION_INSTANCE}`, payload);
    console.log(`📤 Mensagem enviada para ${phoneNumber}`);
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem para ${phoneNumber}:`, error.response?.data || error.message);
  }
}

async function notifyAttendant(triageData) {
  try {
    const message = `
🔔 *NOVA TRIAGEM*

👤 *Nome:* ${triageData.name}
📱 *Telefone:* ${triageData.phone}
🚗 *Veículo:* ${triageData.vehicle}
🧼 *Serviço:* ${triageData.service}
👥 *Cliente Antigo:* ${triageData.is_customer ? 'Sim' : 'Não'}
⏰ *Hora:* ${new Date().toLocaleString('pt-BR')}

⬇️ Responda no WhatsApp para dar continuidade.
    `.trim();

    await sendMessage(WHATSAPP_PHONE, message);
    console.log('📬 Notificação enviada ao atendente');
  } catch (error) {
    console.error('Erro ao notificar atendente:', error.message);
  }
}

export function getTriageFlow() {
  return triageFlow;
}

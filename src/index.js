import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { initBot } from './bot.js';
import { initDashboard } from './dashboard.js';
import { initSupabase } from './database.js';
import { setupWebhook } from './webhook.js';

const PORT = process.env.PORT || 3000;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3001;

async function main() {
  try {
    console.log('🚀 Iniciando M & A WhatsApp Bot...\n');

    // Inicializa banco de dados
    console.log('📊 Conectando ao Supabase...');
    await initSupabase();

    // Inicializa bot WhatsApp
    console.log('📱 Inicializando bot (Evolution API)...');
    await initBot();

    // Cria servidor Express para webhook
    const app = express();
    app.use(express.json());

    // Configura webhook pra receber mensagens
    setupWebhook(app);

    // Inicia servidor de webhook
    app.listen(PORT, () => {
      console.log(`🔌 Servidor de webhook escutando na porta ${PORT}`);
    });

    // Inicializa dashboard em porta diferente
    console.log(`📈 Inicializando dashboard na porta ${DASHBOARD_PORT}...`);
    initDashboard(DASHBOARD_PORT);

    console.log('\n✅ Sistema iniciado com sucesso!\n');
    console.log('📌 Webhook API: http://localhost:' + PORT);
    console.log('📌 Dashboard: http://localhost:' + DASHBOARD_PORT);
    console.log('📌 Senha dashboard: ' + (process.env.DASHBOARD_PASSWORD || 'admin123'));
    console.log('\n⚠️  Configure o webhook no Evolution API Manager\n');

  } catch (error) {
    console.error('❌ Erro ao iniciar:', error);
    process.exit(1);
  }
}

main();

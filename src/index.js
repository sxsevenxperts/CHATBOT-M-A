import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { initBot } from './bot.js';
import { initAdminDashboard } from './admin-dashboard.js';
import { initSupabase } from './database.js';
import { setupWebhook } from './webhook.js';

const PORT = process.env.PORT || 3000;
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;

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

    // Inicializa Admin Dashboard
    console.log(`🎯 Inicializando Admin Dashboard na porta ${ADMIN_PORT}...`);
    initAdminDashboard(ADMIN_PORT);

    console.log('\n✅ Sistema iniciado com sucesso!\n');
    console.log('📌 Webhook API: http://localhost:' + PORT);
    console.log('📌 Admin Dashboard: http://localhost:' + ADMIN_PORT);
    console.log('📌 Senha: ' + (process.env.ADMIN_PASSWORD || 'admin123'));
    console.log('\n🎯 Dashboard Features:');
    console.log('   ✅ Conectar WhatsApp via Evolution API');
    console.log('   ✅ Gerenciar triagens');
    console.log('   ✅ Ver fluxo de mensagens');
    console.log('   ✅ Múltiplas instâncias\n');

  } catch (error) {
    console.error('❌ Erro ao iniciar:', error);
    process.exit(1);
  }
}

main();

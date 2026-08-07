import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { initBot } from './bot.js';
import { setupAdminRoutes } from './admin-dashboard.js';
import { initSupabase } from './database.js';
import { setupWebhook } from './webhook.js';

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    console.log('🚀 Iniciando M & A WhatsApp Bot...\n');

    // Inicializa banco de dados
    console.log('📊 Conectando ao Supabase...');
    await initSupabase();

    // Inicializa bot WhatsApp
    console.log('📱 Inicializando bot (Evolution API)...');
    await initBot();

    // Cria servidor Express
    const app = express();
    app.use(express.json());

    // Configura webhook pra receber mensagens
    setupWebhook(app);

    // Configura Admin Dashboard no app principal
    setupAdminRoutes(app);

    // Inicia servidor
    app.listen(PORT, () => {
      console.log(`\n✅ Sistema iniciado com sucesso!\n`);
      console.log('📌 Webhook API: http://localhost:' + PORT + '/webhook/messages');
      console.log('📌 Admin Dashboard: http://localhost:' + PORT + '/admin');
      console.log('📌 Senha: ' + (process.env.ADMIN_PASSWORD || 'admin123'));
      console.log('\n🎯 Dashboard Features:');
      console.log('   ✅ Conectar WhatsApp via Evolution API');
      console.log('   ✅ Gerenciar triagens');
      console.log('   ✅ Ver fluxo de mensagens');
      console.log('   ✅ Múltiplas instâncias\n');
    });

  } catch (error) {
    console.error('❌ Erro ao iniciar:', error);
    process.exit(1);
  }
}

main();

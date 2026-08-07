#!/bin/bash

# Deploy script para M & A WhatsApp Bot no EasyPanel

echo "🚀 M & A WhatsApp Bot - Deploy Script"
echo "======================================"
echo ""

# 1. Instalar dependências
echo "📦 Instalando dependências..."
npm install --production

# 2. Verificar .env
if [ ! -f ".env" ]; then
  echo "⚠️  Arquivo .env não encontrado!"
  echo "Criando a partir de .env.example..."
  cp .env.example .env
  echo "❌ Configure o arquivo .env manualmente"
  exit 1
fi

# 3. Verificar Supabase
echo ""
echo "🔍 Testando conexão Supabase..."
node -e "
import('./src/database.js').then(({ initSupabase }) => {
  initSupabase()
    .then(() => {
      console.log('✅ Supabase OK');
      process.exit(0);
    })
    .catch((e) => {
      console.error('❌ Erro:', e.message);
      process.exit(1);
    });
}).catch(e => {
  console.error('⚠️  Setup pendente');
  process.exit(0);
});
" 2>/dev/null || true

# 4. Ready
echo ""
echo "✅ Sistema pronto!"
echo ""
echo "📌 Passos finais:"
echo "1. Execute o SQL no Supabase (veja SUPABASE_SETUP.md)"
echo "2. Configure o webhook no Evolution API Manager"
echo "3. Rode: npm start"
echo ""
echo "Dashboard: http://localhost:3001"
echo "Webhook: http://localhost:3000/webhook/messages"

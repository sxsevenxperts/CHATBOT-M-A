# 🚗 M & A WhatsApp Bot - Triagem Automática

Bot de triagem automática para M & A Lava a Jato usando Evolution API e Supabase.

## 🎯 Funcionalidades

- ✅ Triagem automática no WhatsApp (nome, cliente antigo, veículo, serviço)
- ✅ Dashboard admin em tempo real para gerenciar triagens
- ✅ Integração com Evolution API (robusta e escalável)
- ✅ Banco de dados Supabase
- ✅ Notificação automática para atendente
- ✅ Status das triagens (pendente, contatado, concluído, rejeitado)

## 🛠️ Pré-requisitos

- Node.js 18+
- Conta Supabase (gratuita)
- Instância Evolution API (já configurada)
- NPM ou Yarn

## 📋 Setup Rápido

### 1. Clonar e instalar dependências

```bash
cd "CHATBOT M & A"
npm install
```

### 2. Configurar Supabase

1. Ir em [supabase.com](https://supabase.com) e criar uma conta
2. Criar novo projeto
3. Ir em SQL Editor → copiar o conteúdo de `setup.sql` e executar
4. Copiar a URL e a chave anon do projeto
5. Criar arquivo `.env` na raiz do projeto:

```bash
cp .env.example .env
```

6. Preencher no `.env`:

```env
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_KEY=sua-chave-anon

EVOLUTION_API_URL=https://automacao-evolution-api.qfotry.easypanel.host/manager
EVOLUTION_API_KEY=630E8916D6EA-4E90-B4F2-DCF17500612F
EVOLUTION_INSTANCE=3041

WHATSAPP_PHONE=5588994312939

PORT=3000
DASHBOARD_PORT=3001
DASHBOARD_PASSWORD=admin123
NODE_ENV=production
```

### 3. Rodar localmente (teste)

```bash
npm start
```

Acessar dashboard em: `http://localhost:3001`
Senha padrão: `admin123`

### 4. Deploy no EasyPanel

1. Fazer commit e push pra GitHub
2. No EasyPanel:
   - Criar novo aplicativo Node.js
   - Conectar repo GitHub
   - Build command: `npm install`
   - Start command: `npm start`
   - Adicionar variáveis de ambiente (`.env`)
   - Deploy

## 📱 Como funciona o bot

**Fluxo da triagem:**

```
Cliente envia mensagem
        ↓
Bot pergunta: "Qual é seu nome?"
        ↓
Bot pergunta: "Você já é nosso cliente?"
        ↓
Bot pergunta: "Qual é o tipo do seu veículo?"
        ↓
Bot pergunta: "Qual serviço deseja?"
        ↓
Dados salvos no Supabase
        ↓
Atendente notificado
        ↓
Cliente recebe mensagem de confirmação
```

## 🔧 Estrutura do Projeto

```
src/
├── index.js          # Orquestrador principal
├── bot.js            # Lógica do bot (fluxo de triagem)
├── database.js       # Integração com Supabase
└── dashboard.js      # Server do dashboard admin

setup.sql            # Script SQL pra Supabase
.env.example         # Template de variáveis
package.json         # Dependências
```

## 🔐 Segurança

- Dashboard protegido por senha
- Evolution API autenticado com API Key
- Supabase com RLS (Row Level Security)

## 🚀 Próximas Melhorias

- [ ] Integrar com agenda/calendário
- [ ] Webhook pra notificações em tempo real
- [ ] WhatsApp media (fotos de antes/depois)
- [ ] Sistema de promoções/cupons
- [ ] CRM integrado

## 📞 Suporte

Para dúvidas sobre Evolution API:
- Docs: [evolution.fqtry.com](https://evolution.fqtry.com)
- Manager: https://automacao-evolution-api.qfotry.easypanel.host/manager

Para Supabase:
- Docs: [supabase.com/docs](https://supabase.com/docs)

---

**Desenvolvido com ❤️ para M & A Lava a Jato**

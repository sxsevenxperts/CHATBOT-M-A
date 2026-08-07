# 🚀 Deployment M & A WhatsApp Bot

**Tempo estimado:** 10 minutos

---

## 1️⃣ SUPABASE - Criar Tabelas (2 min)

### Passo 1: Abra o SQL Editor
- Ir em: https://app.supabase.com/project/ivpmlwucyguqzrzcyvyc/sql/new
- Fazer login se necessário

### Passo 2: Copiar SQL
Abra o arquivo `setup.sql` deste repo e copie **todo o conteúdo**.

Ou copie direto:

```sql
CREATE TABLE IF NOT EXISTS triages (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_customer BOOLEAN DEFAULT FALSE,
  vehicle VARCHAR(100),
  service VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triages_status ON triages(status);
CREATE INDEX IF NOT EXISTS idx_triages_phone ON triages(phone);
CREATE INDEX IF NOT EXISTS idx_triages_created_at ON triages(created_at DESC);

ALTER TABLE triages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read" ON triages FOR SELECT USING (true);
CREATE POLICY "Allow insert" ON triages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update" ON triages FOR UPDATE USING (true);
```

### Passo 3: Colar e Executar
1. Cola o SQL no editor
2. Clica **RUN** (ou Ctrl+Enter)
3. Aguarda ✅

**Status:** ✅ DONE quando ver "queries successful"

---

## 2️⃣ EASYPANEL - Deploy da Aplicação (5 min)

### Passo 1: Novo App no EasyPanel

1. Abra seu EasyPanel (seu domínio)
2. **"Add Application"** → **"Node.js"**

### Passo 2: Conectar Repositório

- **Git Repository:** `https://github.com/sxsevenxperts/CHATBOT-M-A.git`
- **Branch:** `main`
- **GitHub Token:** (se necessário)

### Passo 3: Configurar Build & Start

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Port:** `3000` (adicione também `3001` se possível)

### Passo 4: Variáveis de Ambiente (.env)

Adicione no EasyPanel:

```env
SUPABASE_URL=https://ivpmlwucyguqzrzcyvyc.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2cG1sd3VjeWd1cXpyemN5dnljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMTU1MjksImV4cCI6MjEwMTY5MTUyOX0.zsv-0EvcQR3Ur499oJkXfmDkF1_m5NM_tzGUJnGaKIs

EVOLUTION_API_URL=https://automacao-evolution-api.qfotry.easypanel.host/manager
EVOLUTION_API_KEY=630E8916D6EA-4E90-B4F2-DCF17500612F
EVOLUTION_INSTANCE=3041

WHATSAPP_PHONE=5588994312939

PORT=3000
DASHBOARD_PORT=3001
DASHBOARD_PASSWORD=Jacyara.10davimaria
NODE_ENV=production
```

### Passo 5: Deploy

1. Clica **Deploy**
2. Aguarda build completar (2-3 min)
3. ✅ Pronto!

**Status:** ✅ DONE quando verde com "running"

---

## 3️⃣ EVOLUTION API - Configurar Webhook (2 min)

Agora que o app tá no ar, configure o webhook:

### Passo 1: Acessar Evolution Manager

- URL: https://automacao-evolution-api.qfotry.easypanel.host/manager
- Instância: **3041**

### Passo 2: Ir em Webhooks

1. Menu → **Webhooks**
2. Tipo: **Message**
3. Eventos: **text_message**

### Passo 3: Adicionar Webhook

- **URL:** `https://seu-dominio-easypanel.com:3000/webhook/messages`
  - ⚠️ Substitua `seu-dominio-easypanel.com` pelo seu domínio real

- **Método:** POST
- **Headers:** (deixe vazio)

### Passo 4: Salvar e Testar

1. Clica **Save**
2. Envia uma mensagem de teste do WhatsApp pra +55 88 99431-2939
3. ✅ Verifica se o bot responde

---

## 4️⃣ TESTAR TUDO (1 min)

### ✅ Checklist

- [ ] Abrir dashboard: `https://seu-dominio-easypanel.com:3001`
- [ ] Login: `Jacyara.10davimaria`
- [ ] Enviar mensagem WhatsApp pra `+55 88 99431-2939`
- [ ] Ver triagem no dashboard em tempo real
- [ ] Responder via WhatsApp como atendente

### 📱 Fluxo de teste:

```
Você: "Oi"
Bot: "Olá! Bem-vindo ao M & A Lava a Jato! Qual é o seu nome?"
Você: "João"
Bot: "Você já é nosso cliente?"
... (continua até serviço)
Bot: "Perfeito, João! Seu pedido foi registrado..."
Dashboard: ✅ Triagem aparece lá
```

---

## 🔧 Troubleshooting

### Bot não responde
- [ ] Webhook configurado?
- [ ] URL do webhook tá correta?
- [ ] Verificar logs no EasyPanel

### Dashboard não abre
- [ ] Porta 3001 exposta no EasyPanel?
- [ ] Senha correta? (`Jacyara.10davimaria`)

### Erro ao salvar triagem
- [ ] SQL executado no Supabase?
- [ ] Variáveis SUPABASE_URL e SUPABASE_KEY corretas?

---

## 📞 URLs Finais

- **Dashboard:** https://seu-dominio-easypanel.com:3001
- **Webhook:** https://seu-dominio-easypanel.com:3000/webhook/messages
- **WhatsApp:** +55 88 99431-2939
- **Evolution API:** https://automacao-evolution-api.qfotry.easypanel.host/manager (instância 3041)

---

**✅ Pronto! Sistema em produção!** 🎉

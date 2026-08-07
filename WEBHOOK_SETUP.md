# 🔗 Configurar Webhook - Evolution API

**Se o Manager estiver com erro de login, siga este guia.**

---

## 📋 Dados do Webhook

Copie exatamente:

```
URL: https://seu-dominio-easypanel.com:3000/webhook/messages
Método: POST
Tipo: Text Messages
```

**⚠️ Substitua `seu-dominio-easypanel.com` pelo domínio real do seu EasyPanel**

Exemplo:
```
https://m-a-bot.seu-empresa.com:3000/webhook/messages
```

---

## 🔧 Como configurar (2 opções)

### **Opção 1: Via Manager (Recomendado)**

Se conseguir fazer login em: https://automacao-evolution-api.qfotry.easypanel.host/manager

**Passo a passo:**
1. Login com:
   - Server URL: `https://automacao-evolution-api.qfotry.easypanel.host`
   - API Key: `630E8916D6EA-4E90-B4F2-DCF17500612F`

2. Clique em **Webhooks** (menu lateral)

3. Clique em **Adicionar Webhook** ou **New Webhook**

4. Preencha:
   - **Evento/Tipo:** Message ou Text Message
   - **URL:** `https://seu-dominio-easypanel.com:3000/webhook/messages`
   - **Método:** POST
   - **Ativo:** SIM

5. Clique **Salvar** ou **Save**

6. **Teste:** Envie uma mensagem WhatsApp pra +55 88 99431-2939

---

### **Opção 2: Via API (Se Manager não funcionar)**

Substitua `seu-dominio-easypanel.com` e rode:

```bash
curl -X POST "https://automacao-evolution-api.qfotry.easypanel.host/webhook/3041" \
  -H "apikey: 630E8916D6EA-4E90-B4F2-DCF17500612F" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://seu-dominio-easypanel.com:3000/webhook/messages",
    "events": ["messages.upsert"],
    "active": true
  }'
```

---

## ✅ Verificar se funciona

**Teste 1: Enviar mensagem**
1. Abra WhatsApp do seu celular
2. Envie mensagem para: **+55 88 99431-2939**
3. Exemplo: "Oi"

**Teste 2: Bot responde?**
- Bot deve responder: "Olá! Bem-vindo ao M & A Lava a Jato! Qual é o seu nome?"

**Teste 3: Dashboard atualiza?**
- Abra: `https://seu-dominio-easypanel.com:3001`
- Senha: `Jacyara.10davimaria`
- Deve aparecer uma triagem com sua mensagem

---

## 🆘 Troubleshooting

### "Manager retorna erro 404"
- Tente recarregar a página
- Verifique se a API Key está correta
- Tente via API (Opção 2)

### "Bot não responde"
- [ ] Webhook foi configurado?
- [ ] URL está correta?
- [ ] EasyPanel está rodando?
- [ ] Verificar logs: `npm start`

### "Mensagem não aparece no dashboard"
- [ ] Supabase SQL foi executado?
- [ ] SUPABASE_KEY configurada no EasyPanel?
- [ ] Verificar console do browser

---

## 📞 Precisa de ajuda?

- **Evolution API Docs:** https://doc.evolution-api.com
- **GitHub:** https://github.com/EvolutionAPI/evolution-api
- **Discord:** https://evolution-api.com/discord

---

**Após configurar o webhook, o bot funciona automaticamente!** 🎉

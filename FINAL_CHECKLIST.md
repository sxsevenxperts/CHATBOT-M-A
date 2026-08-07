# ✅ Checklist Final - M & A WhatsApp Bot

**Status de Deploy: ⏳ Em progresso...**

---

## 📋 O que falta fazer

### **1️⃣ Aguardar Deploy Terminar**
- [ ] Acessar: https://startups-lavaajatoma.qfotry.easypanel.host:3001
- [ ] Deve carregar a tela de login
- [ ] Se erro → deploy ainda em progresso (aguarde 5-10 min)

### **2️⃣ Fazer Login no Dashboard**
- [ ] URL: https://startups-lavaajatoma.qfotry.easypanel.host:3001
- [ ] Senha: `Jacyara.10davimaria`
- [ ] Clique **Entrar**
- [ ] Deve mostrar lista vazia de triagens

### **3️⃣ Configurar Webhook no Evolution API**
- [ ] Abra: https://automacao-evolution-api.qfotry.easypanel.host/manager
- [ ] Login:
  - Server URL: `https://automacao-evolution-api.qfotry.easypanel.host`
  - API Key: `630E8916D6EA-4E90-B4F2-DCF17500612F`
- [ ] Vá em: **Events** → **Webhook**
- [ ] Edite o campo URL para:
  ```
  https://startups-lavaajatoma.qfotry.easypanel.host:3000/webhook/messages
  ```
- [ ] Clique **Save**

### **4️⃣ Testar Completo**
1. [ ] Abra WhatsApp no celular
2. [ ] Envie mensagem para: `+55 88 99431-2939`
3. [ ] Digite: `"Oi"` ou qualquer coisa
4. [ ] Bot deve responder em segundos
5. [ ] Verifique dashboard - deve aparecer a triagem

### **5️⃣ Fluxo Completo**
Bot deve perguntar:
- [ ] "Qual é o seu nome?" → Você responde
- [ ] "Você já é nosso cliente?" → Sim/Não
- [ ] "Qual é o tipo do seu veículo?" → Ex: Carro
- [ ] "Qual serviço deseja?" → Ex: Lavagem Básica
- [ ] **Fim:** Mensagem de confirmação

### **6️⃣ Dashboard**
- [ ] Deve aparecer sua triagem com todos os dados
- [ ] Status deve estar: **Pendente**
- [ ] Você pode mudar para: **Contatado**, **Concluído**, **Rejeitado**

---

## 🔧 Se algo não funcionar

**Bot não responde?**
- [ ] Webhook foi configurado corretamente?
- [ ] URL tem a porta `:3000`?
- [ ] Verificar Evolution API logs

**Dashboard não abre?**
- [ ] Deploy terminou?
- [ ] Tente recarregar página (F5)
- [ ] Tente limpar cache (Ctrl+Shift+Delete)

**Triagem não aparece?**
- [ ] SQL do Supabase foi executado?
- [ ] Supabase key está correta no .env?

---

## 📞 Status de Cada Componente

| Componente | Status | Próximo Passo |
|-----------|--------|---------------|
| Código | ✅ GitHub pronto | Aguardar deploy |
| Supabase | ✅ SQL executado | Pronto |
| EasyPanel | ⏳ Deploy em progresso | Aguardar 5-10 min |
| Dashboard | ⏳ Pendente porta 3001 | Após deploy |
| Webhook | ⏳ Pendente | Configurar após deploy |
| Bot | ⏳ Pendente | Testar após webhook |

---

## 🎉 Sucesso!

Quando todo o checklist estiver marcado ✅, seu **M & A WhatsApp Bot está 100% funcionando!**

**Parabéns!** 🚀

---

**Aviso:** Lembre-se de trocar as senhas padrão depois que terminar:
- [ ] Dashboard: mudar `Jacyara.10davimaria`
- [ ] Supabase: mudar senha
- [ ] EasyPanel: mudar senha


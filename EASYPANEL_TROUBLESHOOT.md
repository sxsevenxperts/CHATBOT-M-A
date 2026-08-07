# 🔧 Verificar Dashboard - EasyPanel

**Seu dashboard pode não estar acessível porque a porta 3001 não está exposta.**

---

## 📋 Checklist - Siga isso no EasyPanel

### **1. Abra o EasyPanel**
- https://164.68.116.21/
- Vá até seu app `lavaajatoma`

### **2. Verifique o Status**
- [ ] App está **RUNNING** (verde)?
- [ ] Se não, clique **START**

### **3. Verifique as Portas Expostas**
No EasyPanel, procure por **"Ports"** ou **"Exposed Ports"**:
- [ ] Porta `3000` está exposta?
- [ ] Porta `3001` está exposta? ⚠️ **Essa é a que falta!**

Se `3001` não estiver lá, **clique em "ADD PORT"** e adicione:
```
3001 (interno) → 3001 (externo)
```

### **4. Verifique os Logs**
No EasyPanel, procure por **"Logs"** ou **"Output"**:
- Rode: `npm start`
- Procure por erros (❌)
- Procure por: `Dashboard rodando na porta 3001` ✅

---

## ✅ Depois de expor a porta 3001

Tente acessar:
```
https://startups-lavaajatoma.qfotry.easypanel.host:3001
```

Você deve ver a tela de login com campo de **Senha**.

---

## 🧪 Se ainda não funcionar

**Verifique os logs do app:**

Procure por linhas como:
```
✅ Sistema iniciado com sucesso!
📌 Webhook API: http://localhost:3000
📌 Dashboard: http://localhost:3001
```

Se estiverem lá → Porta 3001 precisa ser exposta
Se não estiverem lá → App pode estar com erro

---

## 📱 Teste Rápido

Depois que a porta 3001 estiver exposta:

1. Abra: https://startups-lavaajatoma.qfotry.easypanel.host:3001
2. Digite a senha: `Jacyara.10davimaria`
3. Clique **Entrar**
4. Deve aparecer lista de triagens (vazia por enquanto)

---

**Faz esse checklist aí e me avisa! ⚡**

# M & A Lava a Jato · Atendimento WhatsApp

Triagem automática no WhatsApp que faz **duas perguntas** e passa o cliente para
um atendente humano, notificando a equipe no dashboard.

**Evolution API v2** · **Supabase** · **Node 20** · **Docker**

---

## Como o atendimento funciona

```
Cliente manda mensagem
        │
        ▼
1 · Boas-vindas + "Sobre o que deseja falar?"      (Agendar / Valores / Outro)
        │
        ▼
2 · "Qual é o seu veículo?"
        │
        ▼
3 · Grava a solicitação  ──►  🔔 notificação no dashboard (som + badge)
    Pede que aguarde      ──►  bot silencia; quem responde é o atendente
        │
        ▼
Bot volta a atender esse número 24h depois do último contato
```

Detalhes que importam:

- **O nome não é perguntado** — vem do perfil do WhatsApp (`pushName`).
- **Fora do horário** o cliente é avisado quando a equipe retorna, e a
  solicitação é registrada de qualquer forma.
- **A janela de 24h conta do último contato.** Enquanto o cliente escreve, ela é
  empurrada para frente — o bot nunca interrompe uma conversa com o atendente.
- **Grupos, status e as próprias mensagens do bot são ignorados.**
- **Reentrega do mesmo evento é descartada** — o cliente não recebe a pergunta
  duas vezes.

Horário: Seg–Sex 7h–18h · Sáb 7h–14h · Dom fechado (fuso `America/Fortaleza`).

---

## Dashboard

`https://SEU-DOMINIO/admin` — protegido por senha (`ADMIN_PASSWORD`).

| Recurso | O que faz |
|---|---|
| Notificação | Som, notificação do navegador, badge e destaque na linha a cada nova solicitação |
| Solicitações | Cliente, assunto, veículo, quando chegou, situação |
| Situação | Aguardando → Em atendimento → Concluída / Descartada |
| Abrir chat | Vai direto para a conversa no WhatsApp |
| Reativar bot | Devolve um número à triagem automática antes das 24h |
| Fluxo de mensagens | Últimas mensagens trocadas, entrada e saída |
| Conexão | Status do WhatsApp, QR Code se cair, e **Sincronizar webhook** |

---

## Instalação

### 1. Banco

Rode [`setup.sql`](setup.sql) no SQL Editor do Supabase. É idempotente — rodar de
novo não quebra nada. Cria `triages`, `bot_sessions` e `messages`.

### 2. Variáveis

Copie `.env.example` para `.env` e preencha. Os dois erros que custam mais tempo:

```bash
# ✗ ERRADO — /manager é o frontend web, não a API
EVOLUTION_API_URL=https://sua-evolution.host/manager
# ✓ CERTO
EVOLUTION_API_URL=https://sua-evolution.host

# ✗ ERRADO — o HTTPS público atende na 443, não na 3000
PUBLIC_URL=https://seu-app.host:3000
# ✓ CERTO
PUBLIC_URL=https://seu-app.host
```

`EVOLUTION_INSTANCE` é o **nome** da instância, não o UUID. Descubra com:

```bash
curl -s https://sua-evolution.host/instance/fetchInstances -H "apikey: SUA_KEY"
```

### 3. Rodar

```bash
npm install && npm start
```

### 4. Deploy no EasyPanel

- Build: **Dockerfile** (não Nixpacks)
- Variáveis: as mesmas do `.env`
- Domínio → **porta 3000** (o app também escuta na 3001, então qualquer uma das
  duas funciona)

O webhook da Evolution é apontado **automaticamente no boot** a partir da
`PUBLIC_URL`. Não precisa mexer no Evolution Manager.

---

## Diagnóstico

Antes de abrir o Evolution Manager para investigar qualquer coisa, rode:

```bash
npm run doctor
```

Confere variáveis, tabelas e colunas do Supabase, conexão da instância, URL do
webhook e — importante — se o evento `SEND_MESSAGE` está habilitado, que faz o
bot responder a si mesmo em **loop infinito**. Cada falha vem com o conserto.

## Testes

```bash
npm test
```

36 verificações end-to-end: fluxo completo, anti-loop, grupos, idempotência,
handoff, regra das 24h, autenticação do dashboard. Sobe uma Evolution **falsa** —
nenhuma mensagem real é enviada — usa o Supabase de verdade e limpa os dados no
final.

---

## Estrutura

```
src/
  index.js      orquestração, portas, auto-sync do webhook no boot
  evolution.js  cliente da Evolution API v2 (normaliza a base URL, sendText)
  webhook.js    parsing do MESSAGES_UPSERT + filtros (fromMe, grupo, duplicado)
  flow.js       máquina de estados da triagem e regra das 24h
  database.js   Supabase: triagens, sessões, mensagens
  admin.js      rotas do dashboard (/admin)
public/
  admin.html    dashboard (autocontido, sem CDN)
scripts/
  doctor.js     diagnóstico
  e2e.js        testes
setup.sql       schema
```

---

## Referência da API

Rotas do dashboard exigem `Authorization: Bearer <ADMIN_PASSWORD>`.

| Método | Rota | Função |
|---|---|---|
| `POST` | `/webhook/messages` | Recebe da Evolution (`MESSAGES_UPSERT`) |
| `GET` | `/health` | Sonda de saúde |
| `POST` | `/admin/api/login` | Devolve o token |
| `GET` | `/admin/api/status` | WhatsApp + webhook |
| `POST` | `/admin/api/webhook/sync` | Corrige o webhook na Evolution |
| `GET` | `/admin/api/triages` | Lista solicitações |
| `PUT` | `/admin/api/triages/:id` | Muda a situação |
| `POST` | `/admin/api/triages/seen` | Marca notificações como vistas |
| `POST` | `/admin/api/sessions/:phone/reactivate` | Devolve o número ao bot |
| `GET` | `/admin/api/messages` | Fluxo de mensagens |
| `GET` | `/admin/api/qr` | QR Code para reconectar |

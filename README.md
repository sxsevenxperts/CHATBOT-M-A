# M & A Lava a Jato · Atendimento WhatsApp

Triagem automática no WhatsApp que faz **duas perguntas** e passa o cliente para
um atendente humano, notificando a equipe no dashboard.

**Evolution API v2** · **Supabase** · **Node 20** · **Docker**

---

## Como o atendimento funciona

Seis etapas, com **árvore de decisão dinâmica**: o bot pergunta apenas o que
ainda não sabe.

```
1 · Boas-vindas + nome
2 · Veículo — categoria e modelo
3 · Necessidade — serviço, ou "ainda não sei" → o bot recomenda
4 · Nível — Essencial / Completa / Premium, ou o bot indica
5 · Agendamento — período e data
6 · Transferência para a atendente, com o contexto pronto
```

### A regra central

**Nunca perguntar de novo o que o cliente já disse.** Cada mensagem passa por um
extrator de contexto; o que ele reconhece preenche o registro e a pergunta
correspondente simplesmente não acontece.

Quem escreve, de primeira:

> Meu nome é Sérgio, tenho uma Hilux e quero lavagem completa sábado

recebe **uma única pergunta** — o período. O bot já extraiu nome, categoria
(`Hilux → Picape`), veículo, serviço (`Lavagem`), nível (`Completa`) e data
(`Sábado`). São 9 perguntas viram 1.

O extrator reconhece: nome em frases de apresentação, ~90 modelos populares e a
categoria que cada um implica, serviços, níveis, períodos e datas
(`hoje`, `amanhã`, dias da semana, `dia 14`, `12/09`).

### Outros comportamentos

- **O nome é perguntado**, não deduzido do perfil — `pushName` vai para a
  atendente como pista, mas não é usado para tratar o cliente.
- **Nunca informa preço.** Quem pergunta valores é registrado e encaminhado.
- **Dúvida solta** não passa por veículo nem agenda: vai direto ao humano.
- **Fora do horário** avisa quando a equipe retorna e registra de todo jeito.
- **Delay de 3–5s** antes de cada resposta, com `"digitando…"`.
- **Rearme 24h após o último contato.** Cada mensagem empurra a janela, então o
  bot nunca interrompe a conversa com a atendente.
- **Grupos, status e as próprias mensagens do bot são ignorados.**
- **Reentrega do mesmo evento é descartada** por id.
- **Sessões no Supabase:** o handoff sobrevive a redeploy.

Horário: Seg–Sex 7h–18h · Sáb 7h–14h · Dom fechado (fuso `America/Fortaleza`).

---

## Dashboard

`https://SEU-DOMINIO/admin` — protegido por senha (`ADMIN_PASSWORD`).

Identidade visual derivada da logomarca: vermelho `#C61C29` — extraído por
amostragem de pixels da própria arte, não escolhido a olho — grafite quente e
serifada nos títulos.

A marca entra como **badge circular**. A arte traz "LAVAGENS E ESTÉTICA" em
vermelho escuro, que desaparece sobre fundo escuro; o disco branco embutido
devolve o contraste sem redesenhar nada. Para regerar os assets:

```bash
python3 scripts/brand.py brand/logo-original.jpg
```

| Recurso | O que faz |
|---|---|
| Notificação | Som, notificação do navegador, badge e destaque na linha a cada nova solicitação |
| Solicitações | Cliente, veículo, serviço, nível, preferência, quando chegou, situação |
| Cartão de contexto | Clique na linha: o bloco completo que a atendente precisa, com **Copiar contexto** e a próxima ação sugerida |
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

93 verificações end-to-end: as 6 etapas, a extração de contexto, recomendação
de serviço e nível, dúvida solta, anti-loop, grupos, idempotência, handoff,
regra das 24h, delay, autenticação e assets do dashboard. Sobe uma Evolution
**falsa** — nenhuma mensagem real é enviada — usa o Supabase de verdade e limpa
os dados no final.

---

## Estrutura

```
src/
  index.js      orquestração, portas, auto-sync do webhook no boot
  evolution.js  cliente da Evolution API v2 (normaliza a base URL, sendText)
  webhook.js    parsing do MESSAGES_UPSERT + filtros (fromMe, grupo, duplicado)
  flow.js       as 6 etapas, árvore dinâmica e regra das 24h
  catalog.js    serviços, níveis, categorias e modelos por categoria
  extract.js    extração de contexto do texto livre (a regra central)
  database.js   Supabase: triagens, sessões, mensagens
  admin.js      rotas do dashboard (/admin)
public/
  admin.html    dashboard (autocontido, sem CDN)
  badge.png     badge circular da marca (hero e header)
  logo.png      lockup horizontal sem fundo · favicon.png, apple-touch-icon.png
brand/
  logo-original.jpg   arte de origem
scripts/
  brand.py      regenera todos os assets a partir da arte
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
| `GET` | `/admin/api/build` | Selo do build (detecta aba desatualizada) |

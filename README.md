# M & A Lavagens e Estética · Atendimento WhatsApp

Manual de bordo. O bot conversa, monta o contexto e entrega o cliente pronto
para a atendente humana — no mesmo chat.

**Evolution API v2** · **Supabase** · **Node 22** · **Docker** · **EasyPanel**

| | |
|---|---|
| Dashboard | https://startups-lavaajatoma.qfotry.easypanel.host/admin |
| WhatsApp | (88) 98155-3041 · instância `3041` |
| Saúde | `/health` · Ping anti-pause `/ping` |
| Repositório | `sxsevenxperts/CHATBOT-M-A` |

---

## 1 · Como o atendimento funciona

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
(`Sábado`). Nove perguntas viram uma.

O extrator reconhece:

- **nome** em frases de apresentação ("meu nome é", "me chamo", "sou o")
- **~90 modelos populares** e a categoria que cada um implica
- **sinônimos que o cliente realmente usa**: `preço` → Consultar valores,
  `só lavar` → Lavagem, `os bancos estão sujos` → Higienização interna,
  `fim de semana` → Sábado, `quero a top` → Premium, `caminhonete` → Picape
- **datas escritas**: `hoje`, `amanhã`, dias da semana, `dia 14`, `12/09`

Nos menus, o cliente pode responder com o número **ou escrever do seu jeito**.

### Comportamentos que importam

- **O nome é perguntado**, não deduzido do perfil. O `pushName` do WhatsApp vai
  para a atendente como pista, mas não é usado para tratar o cliente.
- **Nunca informa preço.** Quem pergunta valores é registrado e encaminhado.
- **Dúvida solta** não passa por veículo nem agenda: vai direto ao humano.
- **Fora do horário** avisa quando a equipe retorna e registra de todo jeito.
- **Delay de 3–5 s** antes de cada resposta, com `"digitando…"`.
- **Grupos, status e as próprias mensagens do bot são ignorados.**
- **Reentrega do mesmo evento é descartada** por id.
- **Sessões no Supabase**: o handoff sobrevive a redeploy.

Horário: Seg–Sex 7h–18h · Sáb 7h–14h · Dom fechado (fuso `America/Fortaleza`).

### O rearme de 24 h

Depois do handoff o bot **silencia**. Ele só volta a fazer triagem **24 h após o
último contato** — e a janela conta do último contato, não do handoff.

Consequência prática: enquanto o cliente escreve, a janela é empurrada para
frente. **O bot nunca interrompe uma conversa em andamento com a atendente**, por
mais longa que seja.

Para devolver um número ao bot antes disso, use **Reativar bot** no dashboard.

O valor em vigor é verificável sem ler log:

```bash
curl -s https://startups-lavaajatoma.qfotry.easypanel.host/health | grep -o '"rearmeHoras":[0-9]*'
```

---

## 2 · Dashboard

`/admin` — protegido por senha (`ADMIN_PASSWORD`).

Identidade visual derivada da logomarca: vermelho `#C61C29`, extraído por
amostragem de pixels da própria arte. A marca entra como **badge circular** — a
arte traz "LAVAGENS E ESTÉTICA" em vermelho escuro, que desaparece sobre fundo
escuro; o disco branco embutido devolve o contraste sem redesenhar nada.

| Recurso | O que faz |
|---|---|
| Notificação | Som, notificação do navegador, badge e destaque na linha a cada nova solicitação |
| Solicitações | Cliente, veículo, serviço, nível, preferência, quando chegou, situação |
| **Filtro de período** | Hoje · Ontem · 7 dias · 30 dias · Tudo, ou **datas personalizadas** (de / até) |
| Cartão de contexto | Clique na linha: o bloco completo que a atendente precisa, com **Copiar contexto** e a próxima ação sugerida |
| Situação | Aguardando → Em atendimento → Concluída / Descartada |
| Reativar bot | Devolve um número à triagem automática antes das 24 h |
| Fluxo de mensagens | Últimas mensagens trocadas, entrada e saída |
| Conexão | Status do WhatsApp, QR Code se cair, e **Sincronizar webhook** |
| Caixa preta | Últimos eventos do sistema, com filtro por nível |

Para regerar os assets da marca a partir da arte:

```bash
python3 scripts/brand.py brand/logo-original.jpg
```

---

## 3 · Em produção, só conversa real

A lista de Solicitações é da atendente. Ela não pode ter cliente inventado.

Uma conversa é marcada como **teste**, na gravação, quando o número:

1. é o **próprio número da instância** — conversar consigo mesmo é sempre teste;
2. está em `TEST_PHONES` (lista separada por vírgula no `.env`).

O que acontece com elas:

- **Ficam ocultas por padrão** em Solicitações, no fluxo de mensagens e nos
  números do topo. Um aviso diz quantas existem, com o botão **Mostrar**.
- **São apagadas automaticamente no boot**, sempre que o app sobe fora de
  ambiente de teste. O banco de produção não guarda dado de teste.
- **Podem ser apagadas na hora** pelo botão **Apagar testes**.

A limpeza só toca linhas com `is_test = true`. Atendimento real nunca é afetado —
e isso é verificado por teste.

---

## 4 · Caixa preta

Registro em memória dos últimos **400 eventos**, visível no dashboard e em
`/admin/api/log`. Antes disso, tudo o que o sistema fazia existia apenas no
console do container — invisível para quem opera.

| Evento | Quando |
|---|---|
| `webhook.recebido` | Mensagem chegou (de quem, perfil, texto) |
| `webhook.ignorado` | Descarte, **com o motivo**: `fromMe (anti-loop)`, `grupo`, `reentrega`, `status/broadcast` |
| `flow.passo` | Fluxo avançou para uma etapa |
| `flow.naoEntendi` | Resposta não reconhecida (mostra o que o cliente escreveu) |
| `flow.handoff` | Triagem concluída — traz o número da triagem |
| `flow.silenciado` | Cliente escreveu enquanto está com a atendente |
| `flow.rearmado` | Passaram 24 h e o bot voltou a atender |
| `keepalive.ok` / `.falhou` | Anti-pause do Supabase |
| `ping.externo` | Cron externo tocou o banco |
| `boot.*` | Banco, Evolution, webhook, portas, limpeza de testes |
| `admin.*` | Sincronização de webhook, reativação, limpeza |

O anel **zera a cada deploy** e nunca cresce. O que precisa durar — triagens,
mensagens, sessões — está no Supabase.

```bash
curl -s -H "Authorization: Bearer SENHA" \
  'https://startups-lavaajatoma.qfotry.easypanel.host/admin/api/log?level=error'
```

---

## 5 · Instalação

### Banco

Rode [`setup.sql`](setup.sql) no SQL Editor do Supabase. É idempotente — rodar de
novo não quebra nada. Cria `triages`, `bot_sessions` e `messages`, e corrige
colunas de versões anteriores.

### Variáveis

Copie `.env.example` para `.env`. Os dois erros que custam mais tempo:

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

`EVOLUTION_INSTANCE` é o **nome** da instância, não o UUID:

```bash
curl -s https://sua-evolution.host/instance/fetchInstances -H "apikey: SUA_KEY"
```

### Rodar

```bash
npm install && npm start
```

---

## 6 · Deploy no EasyPanel

1. **Build:** `Dockerfile` — **não** Nixpacks.
2. **Variáveis:** as mesmas do `.env`, no nível do **serviço**.
3. **Domínio → porta 3000.** O app também escuta na 3001, então qualquer uma
   das duas funciona.
4. **Deploy.**

O webhook da Evolution é apontado **automaticamente no boot** a partir de
`PUBLIC_URL`. Não precisa mexer no Evolution Manager.

Depois do deploy, confirme:

```bash
curl -s https://startups-lavaajatoma.qfotry.easypanel.host/health
```

`ready: true` significa banco e WhatsApp de pé. Se algo faltar, o corpo da
resposta diz **o que** falta — e o dashboard mostra o mesmo em um banner.

> Se o dashboard mostrar um erro que já foi corrigido, a aba está com o
> JavaScript antigo. O selo de build no rodapé do login diz qual versão está
> carregada, e a página avisa sozinha quando o servidor está mais novo.
> **Cmd+Shift+R** resolve.

---

## 7 · Diagnóstico

Antes de abrir o Evolution Manager para investigar qualquer coisa:

```bash
npm run doctor
```

Confere variáveis, tabelas e colunas do Supabase, fuso dos timestamps, conexão
da instância, URL do webhook e — importante — se o evento `SEND_MESSAGE` está
habilitado, que faz o bot responder a si mesmo em **loop infinito**. Cada falha
vem com o conserto.

## 8 · Testes

```bash
npm test
```

**136 verificações end-to-end**: as 6 etapas, extração de contexto, recomendação
de serviço e nível, respostas em texto livre, dúvida solta, sessão de versão
antiga, anti-loop, grupos, idempotência, handoff, rearme de 24 h, delay,
caixa preta, ping, filtro de período, ocultação e limpeza de testes,
autenticação e assets da marca.

Sobe uma Evolution **falsa** — nenhuma mensagem real é enviada — usa o Supabase
de verdade, declara seus próprios números em `TEST_PHONES` e apaga tudo no final.

---

## 9 · O Supabase vai pausar?

Resposta honesta: **no plano free, não existe garantia.** O plano pausa projetos
após **7 dias sem atividade** e não oferece nenhuma opção para desligar isso.
Dois projetos desta organização já pausaram assim.

O que existe são **duas camadas independentes** que atacam o gatilho:

| Camada | Como | Ponto fraco |
|---|---|---|
| Keepalive interno | O app consulta o banco a cada 6 h (`KEEPALIVE_HOURS`) | Morre com o container: se o app ficar dias fora do ar, para de tocar o banco |
| GitHub Actions | `.github/workflows/keepalive.yml` chama `/ping` a cada 6 h | Roda fora do seu servidor. O GitHub desativa agendamentos em repositórios sem commits por 60 dias — reative na aba **Actions** |

`/ping` é público de propósito: toca o banco, não expõe dado algum e não precisa
de credencial. Qualquer cron externo serve (cron-job.org, UptimeRobot).

Com as duas camadas são ~56 toques em cada janela de 7 dias, e as duas teriam de
falhar juntas para o projeto pausar. **Mas a única garantia contratual é o plano
Pro** (US$ 25/mês por organização), que remove o auto-pause e libera mais
projetos ativos.

Um detalhe: o free permite **2 projetos ativos** por organização, e esta está
exatamente nos 2. Despausar outro pode afetar um dos ativos.

---

## 10 · Estrutura

```
src/
  index.js      orquestração, portas, /health, /ping, auto-sync do webhook,
                limpeza de testes no boot
  evolution.js  cliente da Evolution API v2 (normaliza base URL, sendText, presença)
  webhook.js    parsing do MESSAGES_UPSERT + filtros + dedupe + contador em voo
  flow.js       as 6 etapas, árvore dinâmica, rearme de 24 h, handoff
  catalog.js    serviços, níveis, categorias, modelos e sinônimos
  extract.js    extração de contexto do texto livre (a regra central)
  database.js   Supabase: triagens, sessões, mensagens, filtros, keepalive, purge
  admin.js      rotas do dashboard
  recorder.js   caixa preta
  testflag.js   decide o que é conversa de teste
  env.js        carrega o .env antes dos outros módulos
public/
  admin.html    dashboard (autocontido, sem CDN)
  badge.png     badge circular da marca · logo.png, favicon.png, apple-touch-icon.png
brand/
  logo-original.jpg
scripts/
  doctor.js     diagnóstico
  e2e.js        testes
  brand.py      regenera os assets da marca
.github/workflows/
  keepalive.yml segunda camada anti-pause
setup.sql       schema
```

---

## 11 · API

Rotas de `/admin/api` exigem `Authorization: Bearer <ADMIN_PASSWORD>`.

| Método | Rota | Função |
|---|---|---|
| `POST` | `/webhook/messages` | Recebe da Evolution (`MESSAGES_UPSERT`) |
| `GET` | `/health` | Saúde, config em vigor e resumo da caixa preta |
| `GET` | `/ping` | Toca o banco (público, sem dados) |
| `POST` | `/admin/api/login` | Devolve o token |
| `GET` | `/admin/api/status` | WhatsApp, webhook e diagnóstico do boot |
| `POST` | `/admin/api/webhook/sync` | Corrige o webhook na Evolution |
| `GET` | `/admin/api/triages` | Lista solicitações — `?de=&ate=&testes=1` |
| `PUT` | `/admin/api/triages/:id` | Muda a situação |
| `POST` | `/admin/api/triages/seen` | Marca notificações como vistas |
| `DELETE` | `/admin/api/testes` | Apaga as conversas de teste |
| `POST` | `/admin/api/sessions/:phone/reactivate` | Devolve o número ao bot |
| `GET` | `/admin/api/messages` | Fluxo de mensagens — mesmos filtros |
| `GET` | `/admin/api/stats` | Números do topo — mesmos filtros |
| `GET` | `/admin/api/log` | Caixa preta (`?level=error`) |
| `GET` | `/admin/api/qr` | QR Code para reconectar |
| `GET` | `/admin/api/build` | Selo do build |

`de` e `ate` são datas `YYYY-MM-DD`; `ate` inclui o dia inteiro. Data inválida é
ignorada em vez de quebrar a rota.

---

## 12 · Armadilhas já pagas

Memória institucional. Cada uma custou tempo e está coberta por teste ou
verificação — não reintroduza.

| Armadilha | Sintoma | Causa |
|---|---|---|
| `/manager` na base URL | Chamadas "funcionam" sem fazer nada | `/manager` é o frontend: responde 200 com HTML |
| Payload v1 no `sendText` | 400 na Evolution | A v2 exige `{number, text}` achatado |
| Ler `body.remoteJid` | Nenhuma mensagem entra | A v2 manda tudo sob `data.key.remoteJid` |
| Evento `SEND_MESSAGE` ligado | **Loop infinito** | O bot recebe webhook das próprias respostas |
| `:3000` na URL do webhook | Evolution não alcança | O HTTPS público atende na 443 |
| `dotenv.config()` no corpo do `index.js` | `ADMIN_PASSWORD` ignorada, senha vira `admin` | Imports ESM são avaliados antes dos statements |
| `node:20-alpine` | "native WebSocket not found" | `supabase-js` exige `WebSocket` global (Node 22+) |
| `TIMESTAMP` sem fuso | "3 horas" aparece como "4 minutos" | O navegador lê o valor UTC como hora local |
| `norm()` para exibir | "Sábado pela **manha**" | `norm()` remove acentos — serve para comparar, não para mostrar |
| Responder 200 só após processar | Evolution reentrega o evento | O atendimento leva 3–5 s de propósito |
| Env de nível de projeto no EasyPanel | Aponta para outro Supabase sem ninguém configurar | Serviços herdam o env do projeto; defina no **serviço** |
| Palavra compartilhada nos menus | "quero lavagem" não era entendido | "quero" empatava as opções — hoje há lista de ruído e sinônimos |
| `is_test` só na triagem | Sessão de teste sobrevivia à limpeza | Precisa marcar também em `bot_sessions` e `messages` |
| Aspas duplas em `--body` do `gh` | Comando some no shell | Crases viram substituição de comando; use heredoc |

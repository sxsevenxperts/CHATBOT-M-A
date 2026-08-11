# Chatbot M & A — atendimento WhatsApp

Bot de triagem da M & A Lavagens e Estética. Ele coleta contexto sem repetir
perguntas, grava a solicitação no Supabase e encaminha a conversa para a
atendente humana.

**Stack:** Node 22 · Evolution API v2.3.7 · Supabase · Docker · EasyPanel

| Recurso | Endereço |
|---|---|
| Dashboard | https://startups-lavaajatoma.qfotry.easypanel.host/admin |
| Saúde | https://startups-lavaajatoma.qfotry.easypanel.host/health |
| Ping | https://startups-lavaajatoma.qfotry.easypanel.host/ping |
| Webhook | https://startups-lavaajatoma.qfotry.easypanel.host/webhook/messages |
| Instância | `3041` |

## Fluxo

```text
Evolution → webhook autenticado → inbox persistente → fila por telefone
→ triagem → sendText → ACK → freio/estado canônico
```

O bot cobre boas-vindas, nome, veículo, necessidade, nível, período/data e
handoff com contexto. Depois do handoff ele silencia até o rearme configurado.

## Operação importante

`ready` significa que banco, WhatsApp, canal e webhook estão prontos.
`operational` também exige freio de envio liberado. `PENDING` e `SERVER_ACK` não
provam entrega; `DELIVERY_ACK`, `READ` e `PLAYED` são as confirmações úteis.

O freio global só engata após recusas consecutivas em múltiplos destinatários;
um contato reincidente recebe `BLOQUEADO_DESTINO` sem silenciar os demais. Toda
recusa `ERROR` deve ser tratada como evidência operacional, não como prova
automática de banimento.

## Instalação e gates

1. Execute [`setup.sql`](setup.sql) no Supabase e confirme `chatbot_schema_version() = 2026080801`.
2. Configure as variáveis de [`.env.example`](.env.example), usando somente `SUPABASE_SERVICE_KEY` no backend.
3. Faça `npm ci`.
4. Rode `npm run check`.
5. Rode o E2E com Evolution falsa; staging Supabase é o caminho recomendado:

   ```bash
   npm test
   ```

   Em banco compartilhado, o opt-in explícito é obrigatório:

   ```bash
   E2E_ALLOW_SHARED_SUPABASE=I_UNDERSTAND npm test
   ```

6. Faça deploy EasyPanel com uma réplica e `stop-first`.
7. Confirme o JSON de `/health`, o read-back do webhook e só depois considere uma sonda real autorizada.

## Documentação operacional

- [`MANUAL_DE_USO.md`](MANUAL_DE_USO.md): operação diária, painel, freio, webhook, Supabase, EasyPanel e limitações.
- [`ROADMAP.md`](ROADMAP.md): estado local/validado/commitado/publicado/produção e próximos gates.

## Limitações conhecidas

- O banco atual é de uma única instância: `bot_sessions` e `triages` ainda não possuem `instance`.
- Até existir outbox/idempotência de transporte, use uma réplica e aceite a janela residual entre `sendText` e gravação da sessão.
- A caixa preta mantém 400 eventos em memória e é zerada em deploy.
- Chaves, telefones e mensagens são dados sensíveis; nunca os comite.

## Incidente que motivou o hotfix

Em 08/08/2026 a Evolution aceitou os pedidos HTTP, mas os ACKs do WhatsApp
retornaram `ERROR`. O freio antigo transformava uma recusa pontual em silêncio
global. O hotfix separa destino/canal, persiste ACKs e mostra o motivo no painel.
Isso não comprova banimento; a entrega real continua dependendo do relay e da
conta WhatsApp.

## Estado da entrega

O build local foi validado com `npm run check` e **272/272 verificações E2E**.
Commit, push, deploy e confirmação do runtime público permanecem registrados no
[`ROADMAP.md`](ROADMAP.md) até serem executados.

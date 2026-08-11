# Manual de uso e operação — M & A Lavagens e Estética

Atualizado em 11/08/2026. Este manual descreve o build local preparado para publicação. O código só será considerado em produção depois de commit, deploy e conferência do `/health`.

## 1. Arquitetura

```text
Evolution API v2.3.7 → webhook autenticado → inbox no Supabase
→ fila por telefone → fluxo de triagem → sendText → ACK
→ veredito canônico do canal
```

O app é Node 22, roda em Docker/EasyPanel e acessa o Supabase pelo backend usando `SUPABASE_SERVICE_KEY`. A instância alvo é `3041`; a URL pública é `https://startups-lavaajatoma.qfotry.easypanel.host`.

O banco é de uma única instância. `messages` possui `instance`, mas `bot_sessions` e `triages` ainda usam apenas `phone`; não compartilhe este Supabase com outra instância antes da migração dessas tabelas.

## 2. Uso diário da atendente

Abra `/admin` e entre com `ADMIN_PASSWORD`. A sessão dura oito horas, usa cookie HttpOnly e é invalidada por **Sair**. O painel permite consultar solicitações reais, filtrar período, abrir o WhatsApp, copiar contexto, mudar situação, acompanhar conexão, estabilidade, ACKs e eventos.

Linhas `is_test=true` ficam ocultas. Nunca marque cliente real como teste: o boot de produção e a limpeza removem essas linhas.

## 3. Indicadores

- `ok`: banco acessível.
- `ready`: banco, WhatsApp, estado do canal e webhook prontos.
- `operational`: `ready=true` e freio global liberado.
- `PENDING`/`SERVER_ACK`: pedido aceito pela Evolution; não provam entrega.
- `DELIVERY_ACK`, `READ` e `PLAYED`: evidência de entrega/leitura.
- `ERROR`: recusa do WhatsApp; pode ser pontual e não prova banimento.

Leia sempre **Bot** junto com **Entrega**. Uma entrega de outro contato não libera um contato isolado; uma recusa isolada não deve parar o canal inteiro.

## 4. Freio de envio

O freio global exige `FREIO_REJEICOES` recusas consecutivas em pelo menos `FREIO_DESTINOS_MIN` destinatários distintos. Um contato reincidente é isolado por `FREIO_DESTINO_REJEICOES` recusas e aparece como `BLOQUEADO_DESTINO`.

Quando o freio está ativo, o bot grava `BLOQUEADO`, não chama `sendText` e sinaliza atendimento manual. O estado persiste no Supabase e não é apagado por restart. Uma sonda entregue pode liberar o canal; **Testar envio** envia mensagem real e exige número autorizado.

**Liberar envio** é override administrativo auditável. Use somente com evidência de que a conta voltou a enviar; ele não substitui sonda real.

## 5. Webhook e Evolution

- URL: `https://startups-lavaajatoma.qfotry.easypanel.host/webhook/messages`
- Eventos: `MESSAGES_UPSERT` e `MESSAGES_UPDATE`.
- `SEND_MESSAGE`: não habilitar, para evitar loop.
- Header: `x-evolution-webhook-secret`.
- Instância: `3041` (nome, não UUID do painel).

O boot faz `setWebhook`, lê a configuração de volta e mantém o sistema indisponível se URL, eventos ou autenticação divergirem. Durante falha de dependência, o POST retorna `503`; o `2xx` só sai depois da persistência durável.

## 6. Recuperação segura

Faça uma ação por vez: observe o painel, confirme conexão, gere QR se necessário, reinicie a instância e só então considere novo pareamento. Não faça logout, restart e pareamento em série.

Depois de queda, a retomada repete a pergunta pendente e só marca a sessão recuperada depois de envio aceito. Handoff usa `handoff_pending` e só silencia o bot quando a mensagem final foi aceita.

Limitação conhecida: a Evolution `sendText` não oferece chave idempotente para o efeito externo. Se o processo morrer depois do aceite e antes de gravar a sessão, uma retomada futura pode duplicar a mensagem. Use uma réplica e deploy `stop-first` até existir outbox/idempotência.

## 7. Supabase e migração

1. Faça backup antes de alterar o banco.
2. Execute `setup.sql` no SQL Editor.
3. Confirme `chatbot_schema_version() = 2026080801`.
4. Confirme colunas `messages.instance`, `wa_id`, `status`, `status_at`, tabela `connection_events`, índices de ACK/inbox e funções RPC.
5. Confirme acesso apenas pelo `service_role` do backend.
6. Depois do deploy novo, faça backfill de `messages.instance` nulo somente se todas as linhas pertencerem comprovadamente à instância correta.
7. Quando a contagem nula for zero, avalie `NOT NULL` em migração posterior.

Não copie `3041` para outro projeto sem validar a instância. Nunca coloque chaves ou senha no navegador, README ou Git.

## 8. EasyPanel e validação

Use uma réplica, `stop-first`/`zeroDowntime=false` e shutdown acima de 20 segundos. Ordem:

```bash
npm ci
npm run check
E2E_ALLOW_SHARED_SUPABASE=I_UNDERSTAND npm test
npm run doctor
curl -s https://startups-lavaajatoma.qfotry.easypanel.host/health
```

O proxy pode responder HTTP 200 de liveness com `ready=false`; valide o JSON. Antes de sonda real, confirme número autorizado e aprovação da equipe.

## 9. Segurança e limites

Telefones, mensagens e triagens são dados pessoais. Como uma chave da Evolution foi exposta na conversa operacional, faça sua rotação no provedor e atualize o EasyPanel depois da publicação.

Limites atuais: uma instância por Supabase; uma réplica; caixa preta com 400 eventos em memória; entrega real só é afirmada com `DELIVERY_ACK`, `READ` ou `PLAYED`.

# Roadmap de entrega — Chatbot M & A

Atualizado em 11/08/2026. Estados separados: **local**, **validado**, **commitado**, **publicado** e **produção**.

## Estado atual

| Frente | Local | Validado | Commitado | Publicado | Produção |
|---|---:|---:|---:|---:|---:|
| Freio global/per-contacto e ACK monotônico | sim | sim | não | não | pendente |
| Inbox durável, claim/CAS e drain | sim | sim | não | não | pendente |
| Webhook autenticado e read-back | sim | sim | não | não | pendente |
| Dashboard por camadas e segurança | sim | sim | não | não | pendente |
| `setup.sql`/RPC/schema `2026080801` | sim | sim no projeto alvo | não | não | migração aplicada; runtime pendente |
| E2E Evolution falsa | sim | **272/272** | não | não | não aplicável |
| `npm run check` | sim | **passou** | não | não | não aplicável |
| Manual e roadmap | sim | revisão documental | não | não | não aplicável |

## P0 — liberar a publicação

- [x] Corrigir o silêncio causado por uma única recusa global.
- [x] Separar `BLOQUEADO` de `BLOQUEADO_DESTINO`.
- [x] Deduplicar ACK, rejeitar instância incorreta e guardar ACK anterior ao insert.
- [x] Persistir o estado canônico do canal e não liberar por tempo.
- [x] Persistir inbox antes do `2xx`, claim com `claimAt` e drain no SIGTERM.
- [x] Fechar painel em `/status`, `ready`, `operational`, webhook e destinos isolados.
- [x] Remover fallback de senha `admin`, proteger cookie/logout e limitar login.
- [x] Tornar E2E/carga seguros para fixtures inválidas e limpeza escopada.
- [x] Aplicar `setup.sql` no Supabase alvo e verificar a função de versão.
- [x] Rodar `npm run check` e E2E completo: 272 verificações aprovadas.
- [ ] Criar commit limpo após revisão do diff.
- [ ] Fazer push e confirmar paridade remota.

## P1 — deploy controlado

- [ ] Publicar em uma réplica, stop-first, com shutdown acima de 20 s.
- [ ] Confirmar `/health`: `ready=true`, `operational=true`, instância `3041` e webhook protegido.
- [ ] Confirmar read-back do webhook com URL e os dois eventos obrigatórios.
- [ ] Executar `npm run doctor` contra o host publicado.
- [ ] Fazer uma única sonda real somente após autorização explícita.
- [ ] Rotacionar a chave da Evolution exposta na conversa e atualizar variáveis.
- [ ] Fazer backfill controlado de `messages.instance` e só depois avaliar `NOT NULL`.

## P1 — robustez estrutural

- [ ] Outbox/idempotência de transporte para fechar a janela `sendText` → sessão.
- [ ] Claim durável para retomadas interrompidas, não apenas fila em memória.
- [ ] Lock/RPC por telefone para FIFO estrito entre réplicas e inserts concorrentes.
- [ ] Adicionar `instance` a `bot_sessions` e `triages` antes de multi-instância.
- [ ] Sessões administrativas persistentes e lock distribuído.
- [ ] Migrar `setup.sql` monolítico para migrações versionadas.
- [ ] Expor versão de schema e build no `/health`.

## P2 — operação contínua

- [ ] Staging Supabase obrigatório para `npm test` e `npm run carga`.
- [ ] CI para check, E2E seguro, lint HTML e acessibilidade.
- [ ] Alertas externos para `ready=false`, `operational=false`, inbox atrasado e ACK sem confirmação.
- [ ] Retenção/anonimização de mensagens e telefones, backup e restore testado.
- [ ] Testes visuais/a11y do painel e revisão de UX de bloqueios.
- [ ] Avaliar Meta Cloud API/coexistência e regras atuais da Evolution somente com documentação oficial e decisão de negócio.

## Critério de conclusão

Só marcar concluído quando o commit estiver no remoto, o EasyPanel estiver rodando esse commit, o `/health` público confirmar o estado canônico e uma mensagem real autorizada tiver ACK de entrega. Um E2E fake verde prova o software, mas não prova a capacidade atual do relay WhatsApp.

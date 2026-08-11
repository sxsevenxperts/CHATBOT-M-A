-- ============================================================
-- M & A Lavagens e Estética - Setup do banco (rodar UMA vez no Supabase)
-- SQL Editor: https://app.supabase.com/project/_/sql/new
-- Idempotente: pode rodar de novo sem quebrar nada.
-- ============================================================

-- ---------- 1. Triagens concluídas ----------
CREATE TABLE IF NOT EXISTS triages (
  id          BIGSERIAL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  subject     VARCHAR(200),           -- sobre o que o cliente quer falar
  vehicle     VARCHAR(120),
  is_customer BOOLEAN      DEFAULT FALSE,
  service     VARCHAR(120),
  note        TEXT,
  seen        BOOLEAN      DEFAULT FALSE,  -- notificação já vista no dashboard
  status      VARCHAR(20)  DEFAULT 'pending',
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triages_status     ON triages(status);
CREATE INDEX IF NOT EXISTS idx_triages_phone      ON triages(phone);
CREATE INDEX IF NOT EXISTS idx_triages_created_at ON triages(created_at DESC);

-- ---------- 2. Sessões do bot (sobrevive a restart/redeploy) ----------
-- Sem isto o bot esquece a conversa a cada deploy e volta a incomodar
-- quem já foi passado para o atendimento humano.
CREATE TABLE IF NOT EXISTS bot_sessions (
  phone      VARCHAR(20) PRIMARY KEY,
  step       VARCHAR(30) NOT NULL DEFAULT 'ask_name',
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  handed_off BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated ON bot_sessions(updated_at DESC);

-- ---------- 3. Log de mensagens (fluxo visível no dashboard) ----------
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  direction  VARCHAR(10) NOT NULL,          -- 'in' | 'out' | 'ack' | 'inbox' | 'system'
  body       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone   ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- ---------- 4. Colunas que podem faltar (se rodou versão antiga) ----------
-- Versões antigas criaram created_at/updated_at como TIMESTAMP sem fuso.
-- O navegador então interpretava o valor UTC como hora local e o "recebido
-- há X" saía errado (3 horas apareciam como 4 minutos).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='triages' AND column_name='created_at'
      AND data_type='timestamp without time zone'
  ) THEN
    ALTER TABLE triages
      ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
    ALTER TABLE triages ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE triages ALTER COLUMN updated_at SET DEFAULT NOW();
  END IF;
END $$;

-- Separa conversa real de teste: o painel de Solicitações mostra só o que é
-- atendimento de verdade, e o boot apaga o resto.
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages     ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;

-- Rastreio de entrega da Evolution: PENDING não é prova de que chegou.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_id     TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS instance  TEXT;

-- Migração controlada do legado (NÃO executar sem conferir):
-- este projeto usa a instância 3041 e o runtime lê `3041 OR NULL` durante a
-- transição. Depois de confirmar que todas as linhas NULL pertencem a ela:
--   UPDATE messages SET instance = '3041' WHERE instance IS NULL;
-- Quando `SELECT count(*) FROM messages WHERE instance IS NULL` devolver zero:
--   ALTER TABLE messages ALTER COLUMN instance SET NOT NULL;
-- Não fazemos esse backfill automaticamente: em banco compartilhado ele
-- poderia atribuir o histórico de outra instância ao chatbot atual.
CREATE INDEX IF NOT EXISTS idx_triages_is_test      ON triages(is_test, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_is_test     ON messages(is_test, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_is_test ON bot_sessions(is_test);
CREATE INDEX IF NOT EXISTS idx_messages_wa_id       ON messages(wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_instance_created
  ON messages(instance, created_at DESC) WHERE instance IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_instance_wa_id_unique
  ON messages(instance, wa_id)
  WHERE instance IS NOT NULL AND wa_id IS NOT NULL AND direction = 'out';

-- Consolida eventual duplicidade criada por duas réplicas antes do índice.
-- A ordenação preserva o ACK mais forte (READ > DELIVERY > ERROR > PENDING).
WITH repetidos AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(instance, '__legacy__'), wa_id
           ORDER BY CASE status
             WHEN 'PLAYED' THEN 6 WHEN 'READ' THEN 5 WHEN 'DELIVERY_ACK' THEN 4
             WHEN 'ERROR' THEN 3 WHEN 'SERVER_ACK' THEN 2 WHEN 'PENDING' THEN 1
             ELSE 0 END DESC,
             created_at DESC, id DESC
         ) AS ordem
  FROM messages
  WHERE wa_id IS NOT NULL AND direction = 'ack'
)
DELETE FROM messages m USING repetidos r
WHERE m.id = r.id AND r.ordem > 1;

DROP INDEX IF EXISTS idx_messages_instance_ack_unique;
CREATE UNIQUE INDEX idx_messages_instance_ack_unique
  ON messages((COALESCE(instance, '__legacy__')), wa_id)
  WHERE wa_id IS NOT NULL AND direction = 'ack';

-- Inbox do MESSAGES_UPSERT: o HTTP 2xx só sai depois deste registro. Preserva
-- PROCESSED se uma versão anterior chegou a criar duplicata sem o índice.
WITH repetidos_inbox AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(instance, '__legacy__'), wa_id
           ORDER BY CASE status
             WHEN 'PROCESSED' THEN 4 WHEN 'PROCESSING' THEN 3
             WHEN 'RECEIVED' THEN 2 WHEN 'ERROR' THEN 1 ELSE 0 END DESC,
             created_at DESC, id DESC
         ) AS ordem
  FROM messages
  WHERE wa_id IS NOT NULL AND direction = 'inbox'
)
DELETE FROM messages m USING repetidos_inbox r
WHERE m.id = r.id AND r.ordem > 1;

DROP INDEX IF EXISTS idx_messages_instance_inbox_unique;
CREATE UNIQUE INDEX idx_messages_instance_inbox_unique
  ON messages((COALESCE(instance, '__legacy__')), wa_id)
  WHERE wa_id IS NOT NULL AND direction = 'inbox';

-- Somente uma mensagem por telefone pode executar o fluxo de sessão por vez,
-- inclusive no breve overlap de um rolling deploy. A fila JS cobre uma
-- réplica; este índice é a trava distribuída entre réplicas.
WITH processamentos_concorrentes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(instance, '__legacy__'), phone
           ORDER BY status_at ASC NULLS FIRST, created_at ASC, id ASC
         ) AS ordem
  FROM messages
  WHERE direction = 'inbox' AND status = 'PROCESSING'
)
UPDATE messages m
SET status = 'ERROR', status_at = NOW()
FROM processamentos_concorrentes p
WHERE m.id = p.id AND p.ordem > 1;

DROP INDEX IF EXISTS idx_messages_instance_inbox_processing_unique;
CREATE UNIQUE INDEX idx_messages_instance_inbox_processing_unique
  ON messages((COALESCE(instance, '__legacy__')), phone)
  WHERE direction = 'inbox' AND status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS idx_messages_delivery    ON messages(direction, is_test, created_at DESC);

-- CAS transacional do freio. Bloqueia a linha-fonte durante a comparação:
-- se um DELIVERY_ACK venceu antes, não grava AUTO_BLOCK; se chegou depois,
-- o marcador já é válido e o ACK tardio não religa o canal.
CREATE OR REPLACE FUNCTION public.registrar_auto_block_if_current(
  p_instance TEXT,
  p_scope TEXT,
  p_source_id BIGINT,
  p_source_status TEXT,
  p_source_at TIMESTAMPTZ,
  p_detail TEXT,
  p_is_test BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_source_at TIMESTAMPTZ;
BEGIN
  IF p_source_id IS NULL THEN RETURN FALSE; END IF;

  SELECT status, COALESCE(status_at, created_at)
    INTO v_status, v_source_at
  FROM messages
  WHERE id = p_source_id
    AND direction IN ('out', 'system')
    AND (instance = p_instance OR instance IS NULL)
  FOR UPDATE;

  IF NOT FOUND
     OR v_status IS DISTINCT FROM p_source_status
     OR v_source_at IS DISTINCT FROM p_source_at THEN
    RETURN FALSE;
  END IF;

  INSERT INTO messages (
    phone, direction, body, is_test, wa_id, status, status_at, instance
  ) VALUES (
    p_scope,
    'system',
    'source_id=' || p_source_id || ';source_status=' || COALESCE(p_source_status, '') ||
      ';source_at=' || COALESCE(p_source_at::TEXT, '') || ';' || LEFT(COALESCE(p_detail, ''), 250),
    COALESCE(p_is_test, FALSE),
    NULL,
    'AUTO_BLOCK',
    NOW(),
    p_instance
  );
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_auto_block_if_current(TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_auto_block_if_current(TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,BOOLEAN)
  TO service_role;

CREATE OR REPLACE FUNCTION public.chatbot_schema_version()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT 2026080801; $$;
REVOKE ALL ON FUNCTION public.chatbot_schema_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chatbot_schema_version() TO service_role;

-- Contexto rico do fluxo de 6 etapas.
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS intent      VARCHAR(60);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS category    VARCHAR(40);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS level       VARCHAR(40);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS need        VARCHAR(120);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS period      VARCHAR(40);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS date_pref   VARCHAR(60);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS origin      VARCHAR(30) DEFAULT 'chatbot';
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS recommended BOOLEAN DEFAULT FALSE;

ALTER TABLE triages      ADD COLUMN IF NOT EXISTS subject    VARCHAR(200);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS note       TEXT;
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS seen       BOOLEAN DEFAULT FALSE;
ALTER TABLE triages      ALTER COLUMN service DROP NOT NULL;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS handed_off BOOLEAN NOT NULL DEFAULT FALSE;

-- Histórico de queda/volta precisa sobreviver ao anel de logs e ao deploy.
CREATE TABLE IF NOT EXISTS connection_events (
  id         BIGSERIAL PRIMARY KEY,
  instance   TEXT,
  event      TEXT NOT NULL,
  status     TEXT,
  fora_min   NUMERIC,
  tentativas INTEGER NOT NULL DEFAULT 0,
  detalhe    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_connection_events_created
  ON connection_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connection_events_instance_created
  ON connection_events(instance, created_at DESC);

-- ---------- 5. Acesso backend-only ----------
-- Telefone, conversa e triagem são dados privados. O backend usa service_role;
-- anon/authenticated não recebem acesso direto pelo Data API.
ALTER TABLE triages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS triages_all          ON triages;
DROP POLICY IF EXISTS bot_sessions_all     ON bot_sessions;
DROP POLICY IF EXISTS messages_all         ON messages;
DROP POLICY IF EXISTS connection_events_all ON connection_events;

REVOKE ALL PRIVILEGES ON TABLE triages, bot_sessions, messages, connection_events
  FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE triages, bot_sessions, messages, connection_events
  TO service_role;
GRANT USAGE, SELECT
  ON SEQUENCE triages_id_seq, messages_id_seq, connection_events_id_seq
  TO service_role;

-- ---------- Pronto ----------
SELECT 'setup ok' AS status;

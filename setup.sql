-- ============================================================
-- M & A Lava a Jato - Setup do banco (rodar UMA vez no Supabase)
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
  direction  VARCHAR(10) NOT NULL,          -- 'in' | 'out'
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

ALTER TABLE triages      ADD COLUMN IF NOT EXISTS subject    VARCHAR(200);
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS note       TEXT;
ALTER TABLE triages      ADD COLUMN IF NOT EXISTS seen       BOOLEAN DEFAULT FALSE;
ALTER TABLE triages      ALTER COLUMN service DROP NOT NULL;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS handed_off BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- 5. RLS ----------
-- O backend usa a service_role key, que ignora RLS. As policies abaixo
-- existem só para não travar leitura via anon key durante testes.
ALTER TABLE triages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages     ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='triages' AND policyname='triages_all') THEN
    CREATE POLICY triages_all ON triages FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='bot_sessions' AND policyname='bot_sessions_all') THEN
    CREATE POLICY bot_sessions_all ON bot_sessions FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='messages' AND policyname='messages_all') THEN
    CREATE POLICY messages_all ON messages FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ---------- Pronto ----------
SELECT 'setup ok' AS status;

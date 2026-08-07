-- Criar tabela de triagens
CREATE TABLE IF NOT EXISTS triages (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_customer BOOLEAN DEFAULT FALSE,
  vehicle VARCHAR(100),
  service VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Criar índice pra melhorar performance
CREATE INDEX IF NOT EXISTS idx_triages_status ON triages(status);
CREATE INDEX IF NOT EXISTS idx_triages_phone ON triages(phone);
CREATE INDEX IF NOT EXISTS idx_triages_created_at ON triages(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE triages ENABLE ROW LEVEL SECURITY;

-- Criar policy pra permitir leitura pública (remover se quiser mais segurança)
CREATE POLICY "Allow all read" ON triages
  FOR SELECT USING (true);

CREATE POLICY "Allow insert" ON triages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update" ON triages
  FOR UPDATE USING (true);

# 🗄️ Setup Supabase - M & A Bot

## 📋 Passo a passo para criar as tabelas

### 1. Acessar o Supabase

1. Ir em: https://app.supabase.com
2. Fazer login com sua conta
3. Selecionar o projeto: `ivpmlwucyguqzrzcyvyc`

### 2. Abrir SQL Editor

1. No menu lateral, clicar em **SQL Editor**
2. Clicar em **New Query**

### 3. Copiar e colar o SQL

Copie **todo o código abaixo**:

```sql
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

-- Criar policy pra permitir leitura pública
CREATE POLICY "Allow all read" ON triages
  FOR SELECT USING (true);

CREATE POLICY "Allow insert" ON triages
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update" ON triages
  FOR UPDATE USING (true);
```

### 4. Executar

1. Colar o código no editor SQL
2. Clicar em **Run** (ou `Ctrl+Enter`)
3. Aguardar ✅

### 5. Verificar

Após executar, você deve ver:

```
✓ NOTICE: table "triages" already exists, skipping
✓ 3 indexes created
✓ Roles enabled
✓ 3 policies created
```

Se aparecer qualquer ✅, deu certo!

---

## ✅ Pronto!

Agora o banco está configurado e o bot pode começar a salvar triagens.

**Próximo passo:** Deploy no EasyPanel

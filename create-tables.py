#!/usr/bin/env python3
import os
import sys
from dotenv import load_dotenv

# Load .env
load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SERVICE_ROLE_KEY = os.getenv('SUPABASE_SECRET_KEY')  # From .env

if not SUPABASE_URL:
    print("❌ SUPABASE_URL não configurado")
    sys.exit(1)

try:
    import psycopg2
    from psycopg2 import sql
except ImportError:
    print("📦 Instalando psycopg2...")
    os.system("pip install psycopg2-binary python-dotenv")
    import psycopg2
    from psycopg2 import sql

# Extrai informações de conexão da URL
# Format: https://xxxx.supabase.co
# Connection: postgres://postgres:password@host:5432/postgres

try:
    # Conecta ao Supabase Postgres
    conn = psycopg2.connect(
        host="ivpmlwucyguqzrzcyvyc.db.supabase.co",
        database="postgres",
        user="postgres",
        password="Jacyara.10davimaria",  # Padrão do Supabase
        port=5432
    )

    cur = conn.cursor()

    sql_commands = [
        """
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
        """,
        "CREATE INDEX IF NOT EXISTS idx_triages_status ON triages(status);",
        "CREATE INDEX IF NOT EXISTS idx_triages_phone ON triages(phone);",
        "CREATE INDEX IF NOT EXISTS idx_triages_created_at ON triages(created_at DESC);",
        "ALTER TABLE triages ENABLE ROW LEVEL SECURITY;",
        'CREATE POLICY "Allow all read" ON triages FOR SELECT USING (true);',
        'CREATE POLICY "Allow insert" ON triages FOR INSERT WITH CHECK (true);',
        'CREATE POLICY "Allow update" ON triages FOR UPDATE USING (true);'
    ]

    for cmd in sql_commands:
        if cmd.strip():
            print(f"Executando: {cmd[:50]}...")
            cur.execute(cmd)

    conn.commit()
    print("\n✅ Tabelas criadas com sucesso!")

except Exception as e:
    print(f"⚠️  Erro de conexão: {e}")
    print("\n❌ Não consegui conectar ao banco.")
    print("Execute manualmente no SQL Editor do Supabase:")
    print("https://app.supabase.com/project/ivpmlwucyguqzrzcyvyc/sql/new")
    sys.exit(1)
finally:
    if 'conn' in locals():
        cur.close()
        conn.close()

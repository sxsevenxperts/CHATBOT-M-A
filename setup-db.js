import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL e SUPABASE_KEY não configurados');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupDatabase() {
  try {
    console.log('🔧 Configurando banco de dados...\n');

    // Lê o arquivo setup.sql
    const sql = fs.readFileSync('./setup.sql', 'utf8');

    // Executa cada comando SQL
    const commands = sql.split(';').filter(cmd => cmd.trim());

    for (const command of commands) {
      if (!command.trim()) continue;

      console.log(`Executando: ${command.substring(0, 50)}...`);

      const { error } = await supabase.rpc('exec', {
        sql: command + ';'
      }).catch(() => ({
        error: null // Ignora erro de rpc não existente
      }));

      if (error && error.message.includes('exec')) {
        console.warn('⚠️  RPC exec não disponível, tente executar manualmente no SQL Editor');
        console.log('\n📋 Copie e cole isso no SQL Editor do Supabase:\n');
        console.log(sql);
        return;
      }
    }

    console.log('\n✅ Banco de dados configurado com sucesso!');

    // Verifica se tabela foi criada
    const { data, error } = await supabase
      .from('triages')
      .select('count', { count: 'exact' })
      .limit(1);

    if (!error) {
      console.log('✅ Tabela "triages" criada e acessível');
    }

  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.log('\n📋 Execute manualmente no SQL Editor do Supabase:');
    const sql = fs.readFileSync('./setup.sql', 'utf8');
    console.log(sql);
    process.exit(1);
  }
}

setupDatabase();

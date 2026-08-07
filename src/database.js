import { createClient } from '@supabase/supabase-js';

let supabaseClient;

export async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL e SUPABASE_KEY são obrigatórios');
  }

  supabaseClient = createClient(url, key);

  // Verifica conexão
  const { data, error } = await supabaseClient.from('triages').select('count', { count: 'exact' }).limit(1);

  if (error) {
    console.warn('⚠️  Tabela "triages" não encontrada. Execute o SQL setup no Supabase.');
  } else {
    console.log('✅ Supabase conectado');
  }

  return supabaseClient;
}

export function getSupabase() {
  if (!supabaseClient) {
    throw new Error('Supabase não foi inicializado');
  }
  return supabaseClient;
}

export async function saveTriage(data) {
  const { data: result, error } = await getSupabase()
    .from('triages')
    .insert([{
      phone: data.phone,
      name: data.name,
      is_customer: data.is_customer,
      vehicle: data.vehicle,
      service: data.service,
      status: 'pending',
      created_at: new Date().toISOString()
    }])
    .select();

  if (error) {
    console.error('Erro ao salvar triagem:', error);
    throw error;
  }

  return result[0];
}

export async function getTriages(limit = 50) {
  const { data, error } = await getSupabase()
    .from('triages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Erro ao buscar triagens:', error);
    throw error;
  }

  return data;
}

export async function updateTriageStatus(id, status) {
  const { data, error } = await getSupabase()
    .from('triages')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select();

  if (error) {
    console.error('Erro ao atualizar triagem:', error);
    throw error;
  }

  return data[0];
}

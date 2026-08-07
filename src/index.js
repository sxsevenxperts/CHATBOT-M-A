import './env.js';                 // carrega o .env antes de tudo
import { str, num } from './env.js';
import express from 'express';

import { initSupabase } from './database.js';
import { setupWebhook, WEBHOOK_PATH } from './webhook.js';
import { setupAdmin } from './admin.js';
import { checkConnection, getWebhook, setWebhook, getConfig } from './evolution.js';

const PORT = num('PORT', 3000);
// O domínio do EasyPanel pode estar apontado para 3000 ou 3001. Escutar nos
// dois elimina uma ida ao painel e uma classe inteira de "não abre".
const ALT_PORT = num('ALT_PORT', 3001);

const PUBLIC_URL = str('PUBLIC_URL').replace(/\/+$/, '');

/**
 * Aponta o webhook da Evolution para esta aplicação, se ainda não estiver.
 * É isto que evita o passo manual no Evolution Manager — e conserta sozinho
 * a URL errada com `:3000` que o domínio HTTPS não atende.
 */
async function ensureWebhook() {
  if (!PUBLIC_URL) {
    console.warn('[boot] PUBLIC_URL não definida — webhook não será sincronizado automaticamente.');
    return;
  }

  const expected = `${PUBLIC_URL}${WEBHOOK_PATH}`;

  try {
    const current = await getWebhook();
    if (current?.enabled && current?.url === expected) {
      console.log(`[boot] webhook já correto: ${expected}`);
      return;
    }
    console.log(`[boot] webhook atual: ${current?.url || '(nenhum)'} → corrigindo`);
    await setWebhook(expected);
    console.log(`[boot] webhook apontado para ${expected} (evento: MESSAGES_UPSERT)`);
  } catch (e) {
    console.error('[boot] falha ao sincronizar webhook:', e?.response?.data || e.message);
  }
}

async function main() {
  console.log('\n── M & A Lava a Jato · Atendimento WhatsApp ──\n');

  // 1. Banco: falha ruidosamente, porque sem ele nada funciona.
  console.log('[boot] conectando ao Supabase…');
  await initSupabase();
  console.log('[boot] Supabase ok (triages, bot_sessions, messages)');

  // 2. Evolution: aviso, não erro — o app sobe e o dashboard mostra o QR.
  const { baseUrl, instance } = getConfig();
  console.log(`[boot] Evolution: ${baseUrl} · instância "${instance}"`);
  try {
    const wa = await checkConnection();
    console.log(
      wa.connected
        ? `[boot] WhatsApp conectado: ${wa.ownerJid} (${wa.profileName || 'sem nome'})`
        : `[boot] WhatsApp NÃO conectado (status: ${wa.status}) — escaneie o QR em /admin`
    );
  } catch (e) {
    console.error('[boot] Evolution inacessível:', e.message);
  }

  // 3. HTTP
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/', (_req, res) => res.redirect('/admin'));

  setupWebhook(app);
  setupAdmin(app, { publicUrl: PUBLIC_URL || `http://localhost:${PORT}` });

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  const listen = port => new Promise(resolve => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[boot] escutando na porta ${port}`);
      resolve(server);
    });
    server.on('error', err => {
      console.warn(`[boot] porta ${port} indisponível (${err.code}) — seguindo`);
      resolve(null);
    });
  });

  await listen(PORT);
  if (ALT_PORT && ALT_PORT !== PORT) await listen(ALT_PORT);

  // 4. Webhook depois do listen: a Evolution pode validar a URL na hora.
  await ensureWebhook();

  const dMin = num('REPLY_DELAY_MIN_MS', 3000);
  const dMax = num('REPLY_DELAY_MAX_MS', 5000);
  const rearm = num('REARM_HOURS', 24);

  console.log('\n✔ Pronto.');
  console.log(`  Dashboard  ${PUBLIC_URL || `http://localhost:${PORT}`}/admin`);
  console.log(`  Webhook    ${PUBLIC_URL || `http://localhost:${PORT}`}${WEBHOOK_PATH}`);
  console.log('  Fluxo      boas-vindas → assunto → veículo → atendimento humano');
  console.log(`  Delay      ${dMin}–${dMax} ms antes de cada resposta`);
  console.log(`  Rearme     ${rearm}h após o último contato\n`);
}

main().catch(err => {
  console.error('\n✖ Falha ao iniciar:', err.message, '\n');
  process.exit(1);
});

process.on('unhandledRejection', r => console.error('[unhandledRejection]', r));
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); process.exit(0); });

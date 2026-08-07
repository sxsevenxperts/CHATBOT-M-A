import './env.js';                 // carrega o .env antes de tudo
import { str, num } from './env.js';
import express from 'express';

import { initSupabase, keepalive } from './database.js';
import { setupWebhook, WEBHOOK_PATH, getInflight } from './webhook.js';
import { setupAdmin } from './admin.js';
import { checkConnection, getWebhook, setWebhook, getConfig } from './evolution.js';

const PORT = num('PORT', 3000);
// O domínio do EasyPanel pode estar apontado para 3000 ou 3001. Escutar nos
// dois elimina uma ida ao painel e uma classe inteira de "não abre".
const ALT_PORT = num('ALT_PORT', 3001);

const PUBLIC_URL = str('PUBLIC_URL').replace(/\/+$/, '');

/**
 * Estado de inicialização, exposto em /health e no dashboard.
 *
 * O servidor HTTP sobe ANTES de checar dependências. Se o app morresse por
 * falta de env var, o proxy devolveria 502 e ninguém saberia o motivo — foi
 * exatamente o que aconteceu no primeiro deploy. Agora ele sobe sempre e diz
 * o que está faltando.
 */
const state = {
  startedAt: new Date().toISOString(),
  db: { ok: false, error: null },
  keepalive: { enabled: false, everyHours: null, lastOk: null, lastError: null, runs: 0 },
  whatsapp: { ok: false, error: null, info: null },
  webhook: { ok: false, error: null, url: null },
  env: {}
};

function checkEnv() {
  const req = ['SUPABASE_URL', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'];
  const missing = req.filter(k => !str(k));
  if (!str('SUPABASE_SERVICE_KEY') && !str('SUPABASE_KEY')) missing.push('SUPABASE_SERVICE_KEY');

  state.env = {
    missing,
    publicUrl: PUBLIC_URL || '(derivada do request)',
    hasAdminPassword: !!(str('ADMIN_PASSWORD') || str('DASHBOARD_PASSWORD'))
  };

  if (missing.length) {
    console.error(`\n[boot] ✖ VARIÁVEIS FALTANDO: ${missing.join(', ')}`);
    console.error('[boot]   Adicione nas variáveis de ambiente do EasyPanel e faça redeploy.\n');
  }
  return missing;
}

async function initDependencies() {
  // Banco
  try {
    await initSupabase();
    state.db.ok = true;
    console.log('[boot] Supabase ok (triages, bot_sessions, messages)');
  } catch (e) {
    state.db.error = e.message;
    console.error('[boot] ✖ Supabase:', e.message);
  }

  // Evolution
  try {
    const { baseUrl, instance } = getConfig();
    console.log(`[boot] Evolution: ${baseUrl} · instância "${instance}"`);
    const wa = await checkConnection();
    state.whatsapp = { ok: wa.connected, error: null, info: wa };
    console.log(
      wa.connected
        ? `[boot] WhatsApp conectado: ${wa.ownerJid} (${wa.profileName || 'sem nome'})`
        : `[boot] WhatsApp NÃO conectado (status: ${wa.status}) — escaneie o QR em /admin`
    );
  } catch (e) {
    state.whatsapp.error = e.message;
    console.error('[boot] ✖ Evolution:', e.message);
  }

  // Webhook: aponta para cá sozinho, se soubermos a URL pública.
  if (!PUBLIC_URL) {
    state.webhook.error = 'PUBLIC_URL não definida — sincronize pelo dashboard';
    console.warn('[boot] PUBLIC_URL não definida — webhook não sincronizado no boot');
    return;
  }

  const expected = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  try {
    const current = await getWebhook();
    if (current?.enabled && current?.url === expected) {
      state.webhook = { ok: true, error: null, url: expected };
      console.log(`[boot] webhook já correto: ${expected}`);
      return;
    }
    console.log(`[boot] webhook atual: ${current?.url || '(nenhum)'} → corrigindo`);
    await setWebhook(expected);
    state.webhook = { ok: true, error: null, url: expected };
    console.log(`[boot] webhook apontado para ${expected} (evento: MESSAGES_UPSERT)`);
  } catch (e) {
    state.webhook.error = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('[boot] ✖ webhook:', state.webhook.error);
  }
}

/**
 * Mantém o projeto Supabase acordado.
 *
 * O plano free pausa após 7 dias de inatividade e não há como desativar isso
 * no painel — dois projetos do usuário já pausaram assim. Este intervalo gera
 * atividade real no banco. Depende do container continuar rodando; se o app
 * for parado por muitos dias, só o plano Pro garante que nada pause.
 */
function startKeepalive() {
  const hours = num('KEEPALIVE_HOURS', 6);
  if (hours <= 0) {
    console.log('[keepalive] desativado (KEEPALIVE_HOURS=0)');
    return;
  }

  state.keepalive.enabled = true;
  state.keepalive.everyHours = hours;

  const tick = async () => {
    try {
      await keepalive();
      state.keepalive.lastOk = new Date().toISOString();
      state.keepalive.lastError = null;
      state.keepalive.runs++;
      console.log(`[keepalive] ok (${state.keepalive.runs}) — projeto Supabase ativo`);
    } catch (e) {
      state.keepalive.lastError = e.message;
      console.error('[keepalive] falhou:', e.message);
    }
  };

  const timer = setInterval(tick, hours * 3600_000);
  timer.unref?.();
  tick();   // uma vez já no boot
  console.log(`[keepalive] ativo — consulta a cada ${hours}h`);
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Sempre 200: o proxy precisa de uma resposta para não devolver 502.
  // O corpo diz se algo está degradado.
  app.get('/health', (_req, res) => res.json({
    ok: state.db.ok,
    ready: state.db.ok && state.whatsapp.ok,
    uptime: Math.round(process.uptime()),
    inflight: getInflight(),
    ...state
  }));

  app.get('/', (_req, res) => res.redirect('/admin'));

  setupWebhook(app);
  setupAdmin(app, { publicUrl: PUBLIC_URL, state });

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
  return app;
}

function listen(app, port) {
  return new Promise(resolve => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[boot] escutando na porta ${port}`);
      resolve(server);
    });
    server.on('error', err => {
      console.warn(`[boot] porta ${port} indisponível (${err.code}) — seguindo`);
      resolve(null);
    });
  });
}

async function main() {
  console.log('\n── M & A Lava a Jato · Atendimento WhatsApp ──\n');

  const missing = checkEnv();
  const app = buildApp();

  // HTTP primeiro: garante que o painel abra e mostre o diagnóstico.
  const primary = await listen(app, PORT);
  if (ALT_PORT && ALT_PORT !== PORT) await listen(app, ALT_PORT);

  if (!primary) {
    console.error('[boot] ✖ nenhuma porta disponível — encerrando');
    process.exit(1);
  }

  await initDependencies();
  if (state.db.ok) startKeepalive();

  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('\n' + (state.db.ok ? '✔ Pronto.' : '⚠ No ar, mas DEGRADADO.'));
  console.log(`  Dashboard  ${base}/admin`);
  console.log(`  Webhook    ${base}${WEBHOOK_PATH}`);
  console.log(`  Saúde      ${base}/health`);
  console.log(`  Delay      ${num('REPLY_DELAY_MIN_MS', 3000)}–${num('REPLY_DELAY_MAX_MS', 5000)} ms`);
  console.log(`  Rearme     ${num('REARM_HOURS', 24)}h após o último contato`);
  console.log(`  Keepalive  ${state.keepalive.enabled ? `a cada ${state.keepalive.everyHours}h (anti-pause do Supabase free)` : 'desativado'}`);

  if (missing.length) console.log(`\n  ✖ faltam variáveis: ${missing.join(', ')}`);
  if (!state.db.ok) console.log(`  ✖ banco: ${state.db.error}`);
  console.log('');
}

main().catch(err => {
  // Último recurso: nem assim derruba o processo sem explicar.
  console.error('\n✖ Falha inesperada no boot:', err?.stack || err.message, '\n');
  process.exit(1);
});

process.on('unhandledRejection', r => console.error('[unhandledRejection]', r));
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); process.exit(0); });

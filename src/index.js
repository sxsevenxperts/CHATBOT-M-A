import './env.js';                 // carrega o .env antes de tudo
import { str, num } from './env.js';
import express from 'express';

import {
  initSupabase, keepalive, purgeTestes, registrarEventoConexao, resumoEntrega
} from './database.js';
import { setupWebhook, WEBHOOK_PATH, getInflight, filasAbertas } from './webhook.js';
import { retomarConversas } from './flow.js';
import { setupAdmin } from './admin.js';
import { checkConnection, getWebhook, setWebhook, getConfig, reconnect } from './evolution.js';
import { info, warn, falha, resumo as resumoCaixaPreta } from './recorder.js';
import { setProprioNumero } from './testflag.js';

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
  whatsapp: { ok: false, error: null, info: null, caiuEm: null, tentativas: 0, precisaQr: false },
  entrega: { saudavel: null, enviadas: 0, entregues: 0, semConfirmacao: 0, checadoEm: null },
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
    falha('boot.envFaltando', new Error(missing.join(', ')), { onde: 'EasyPanel → variáveis' });
  }
  return missing;
}

async function initDependencies() {
  // Banco
  try {
    await initSupabase();
    state.db.ok = true;
    info('boot.supabase', { tabelas: 'triages, bot_sessions, messages' });
  } catch (e) {
    state.db.error = e.message;
    falha('boot.supabaseFalhou', e);
  }

  // Evolution
  try {
    const { baseUrl, instance } = getConfig();
    info('boot.evolution', { baseUrl, instancia: instance });
    const wa = await checkConnection();
    state.whatsapp = { ok: wa.connected, error: null, info: wa };
    // Conversa com o próprio número é teste: marca as triagens como tal.
    if (wa.ownerJid) setProprioNumero(wa.ownerJid);
    if (wa.connected) info('boot.whatsapp', { numero: wa.ownerJid, perfil: wa.profileName || '—' });
    else warn('boot.whatsappOffline', { status: wa.status, acao: 'escaneie o QR em /admin' });
  } catch (e) {
    state.whatsapp.error = e.message;
    falha('boot.evolutionFalhou', e);
  }

  // Webhook: aponta para cá sozinho, se soubermos a URL pública.
  if (!PUBLIC_URL) {
    state.webhook.error = 'PUBLIC_URL não definida — sincronize pelo dashboard';
    warn('boot.publicUrlAusente', { efeito: 'webhook não sincroniza sozinho' });
    return;
  }

  const expected = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  try {
    const current = await getWebhook();
    if (current?.enabled && current?.url === expected) {
      state.webhook = { ok: true, error: null, url: expected };
      info('boot.webhookOk', { url: expected });
      return;
    }
    warn('boot.webhookDivergente', { atual: current?.url || '(nenhum)', esperado: expected });
    await setWebhook(expected);
    state.webhook = { ok: true, error: null, url: expected };
    info('boot.webhookCorrigido', { url: expected, eventos: 'MESSAGES_UPSERT' });
  } catch (e) {
    state.webhook.error = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    falha('boot.webhookFalhou', e);
  }
}

/**
 * Vigia a conexão do WhatsApp.
 *
 * Sem isto, state.whatsapp era medido UMA vez no boot e nunca mais. A sessão
 * caiu às 09:45 e o /health continuou dizendo `ready: true` — o painel mostrava
 * tudo verde com o atendimento parado há horas. Uma queda de conexão significa
 * negócio sem receber cliente: tem de ser ruidosa.
 */
function startConnectionMonitor() {
  const segundos = num('MONITOR_SECONDS', 60);
  if (segundos <= 0) return;

  let ultimaTentativa = 0;

  const tick = async () => {
    const antes = state.whatsapp.ok;
    const caiuEm = state.whatsapp.caiuEm;
    const tentativas = state.whatsapp.tentativas || 0;

    try {
      const wa = await checkConnection();
      state.whatsapp = {
        ok: wa.connected, error: null, info: wa,
        checkedAt: new Date().toISOString(),
        caiuEm: wa.connected ? null : (caiuEm || new Date().toISOString()),
        tentativas: wa.connected ? 0 : tentativas,
        precisaQr: wa.connected ? false : state.whatsapp.precisaQr
      };

      if (antes && !wa.connected) {
        // Marca o início; só vira "queda" registrada se persistir. Oscilação
        // de segundos não é pane e não deve inflar a estatística.
        warn('whatsapp.oscilou', { status: wa.status });
        registrarEventoConexao({
          instance: wa.name, event: 'caiu', status: wa.status,
          detalhe: 'detectado pelo monitor'
        }).catch(() => {});
      } else if (!antes && wa.connected) {
        const segundosFora = caiuEm ? Math.round((Date.now() - new Date(caiuEm).getTime()) / 1000) : 0;
        const min = Math.round(segundosFora / 60);
        // Piscada curta é ruído; queda de verdade é sinal.
        if (segundosFora < 90) {
          info('whatsapp.piscou', { segundosFora });
        } else {
          info('whatsapp.voltou', { numero: wa.ownerJid, foraDoArMin: min, tentativas });
        }
        registrarEventoConexao({
          instance: wa.name, event: 'voltou', status: wa.status,
          foraMin: min, tentativas,
          detalhe: segundosFora < 90 ? `oscilação de ${segundosFora}s` : null
        }).catch(() => {});

        // Quem escreveu durante a queda não recebeu resposta e some em
        // silêncio. Retoma pedindo desculpa e repetindo a pergunta pendente.
        // Só depois de queda longa: um piscar de 30s não justifica incomodar.
        const minimo = num('RECOVERY_MIN_MINUTES', 5);
        if (caiuEm && min >= minimo) {
          retomarConversas({ caiuEm })
            .then(r => r.retomadas && info('retomada.apósQueda', { retomadas: r.retomadas, foraDoArMin: min }))
            .catch(e => falha('retomada.erro', e));
        } else if (caiuEm) {
          info('retomada.dispensada', { foraDoArMin: min, minimoMin: minimo });
        }
      }

      // Reconexão automática: queda transitória se resolve sem ninguém olhar.
      // Estrangulada, porque insistir gera QR novo a cada chamada.
      if (!wa.connected && Date.now() - ultimaTentativa > 120_000) {
        ultimaTentativa = Date.now();
        try {
          const r = await reconnect();
          state.whatsapp.tentativas = tentativas + 1;
          state.whatsapp.precisaQr = r.precisaQr;
          r.precisaQr
            ? warn('whatsapp.precisaQr', { tentativa: tentativas + 1, acao: 'escaneie o QR em /admin → Conexão' })
            : info('whatsapp.reconectando', { tentativa: tentativas + 1 });
        } catch (e) {
          falha('whatsapp.reconexaoFalhou', e, { tentativa: tentativas + 1 });
        }
      }
    } catch (e) {
      state.whatsapp = {
        ok: false, error: e.message, info: state.whatsapp.info,
        checkedAt: new Date().toISOString(),
        caiuEm: caiuEm || new Date().toISOString(),
        tentativas, precisaQr: state.whatsapp.precisaQr
      };
      if (antes) falha('whatsapp.inacessivel', e);
    }
  };

  const timer = setInterval(tick, segundos * 1000);
  timer.unref?.();
  info('monitor.ativo', { intervaloSegundos: segundos });

  /**
   * Vigia a ENTREGA, não o aceite.
   *
   * A Evolution pode responder PENDING e o WhatsApp engolir a mensagem. Foi o
   * que aconteceu em 08/08/2026 e ficou horas invisível. Se nada dos últimos
   * 30 min confirmou entrega, isso agora vira ERRO na cara de quem opera.
   */
  const vigiaEntrega = async () => {
    try {
      const r = await resumoEntrega({ minutos: 30 });
      const antes = state.entrega.saudavel;
      state.entrega = { ...r, checadoEm: new Date().toISOString() };

      if (r.saudavel === false && antes !== false) {
        falha('entrega.falhando', new Error(`${r.semConfirmacao} mensagens sem confirmação`), {
          enviadas: r.enviadas, entregues: r.entregues,
          acao: 'a Evolution aceita mas o WhatsApp não entrega — use "Desconectar e pareear"'
        });
      } else if (r.saudavel === true && antes === false) {
        info('entrega.normalizou', { entregues: r.entregues, enviadas: r.enviadas });
      }
    } catch (e) {
      falha('entrega.checagemFalhou', e);
    }
  };
  const t2 = setInterval(vigiaEntrega, Math.max(segundos, 60) * 1000);
  t2.unref?.();
  vigiaEntrega();
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
    info('keepalive.desativado', { motivo: 'KEEPALIVE_HOURS=0' });
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
      info('keepalive.ok', { execucao: state.keepalive.runs });
    } catch (e) {
      state.keepalive.lastError = e.message;
      falha('keepalive.falhou', e);
    }
  };

  const timer = setInterval(tick, hours * 3600_000);
  timer.unref?.();
  tick();   // uma vez já no boot
  info('keepalive.ativo', { intervaloHoras: hours });
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
    filasPorTelefone: filasAbertas(),
    entrega: state.entrega,
    config: {
      rearmeHoras: num('REARM_HOURS', 24),
      delayMs: [num('REPLY_DELAY_MIN_MS', 3000), num('REPLY_DELAY_MAX_MS', 5000)],
      keepaliveHoras: num('KEEPALIVE_HOURS', 6),
      fuso: str('TIMEZONE', 'America/Fortaleza')
    },
    caixaPreta: resumoCaixaPreta(),
    ...state
  }));

  /**
   * Ping público que TOCA o banco.
   *
   * Existe para que qualquer cron externo — GitHub Actions, cron-job.org,
   * UptimeRobot — possa manter o projeto Supabase acordado sem precisar de
   * credencial nenhuma. É a segunda camada anti-pause: a primeira (keepalive
   * interno) morre junto com o container; esta não depende dele estar de pé
   * por meses, só de alguém chamando a URL.
   *
   * Não expõe dado algum: devolve apenas se o banco respondeu.
   */
  let ultimoPing = 0;
  app.get('/ping', async (_req, res) => {
    const agora = Date.now();
    try {
      await keepalive();
      // Registra no máximo a cada 5 min para o ping não afogar a caixa preta.
      if (agora - ultimoPing > 300_000) {
        ultimoPing = agora;
        info('ping.externo', { banco: 'ok' });
      }
      res.json({ ok: true, db: true, at: new Date().toISOString() });
    } catch (e) {
      falha('ping.falhou', e);
      res.status(503).json({ ok: false, db: false, erro: e.message });
    }
  });

  app.get('/', (_req, res) => res.redirect('/admin'));

  setupWebhook(app);
  setupAdmin(app, { publicUrl: PUBLIC_URL, state });

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
  return app;
}

function listen(app, port) {
  return new Promise(resolve => {
    const server = app.listen(port, '0.0.0.0', () => {
      info('boot.escutando', { porta: port });
      resolve(server);
    });
    server.on('error', err => {
      warn('boot.portaIndisponivel', { porta: port, codigo: err.code });
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

  // Fora de ambiente de teste, o banco de produção não guarda dado de teste.
  if (state.db.ok && str('NODE_ENV') !== 'test') {
    try {
      const apagados = await purgeTestes();
      const total = Object.values(apagados).reduce((a, b) => a + b, 0);
      if (total) info('boot.testesApagados', apagados);
    } catch (e) {
      falha('boot.purgeTestesFalhou', e);
    }
  }

  if (state.db.ok) startKeepalive();
  startConnectionMonitor();

  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('\n' + (state.db.ok ? '✔ Pronto.' : '⚠ No ar, mas DEGRADADO.'));
  console.log(`  Dashboard  ${base}/admin`);
  console.log(`  Webhook    ${base}${WEBHOOK_PATH}`);
  console.log(`  Saúde      ${base}/health`);
  console.log(`  Delay      ${num('REPLY_DELAY_MIN_MS', 3000)}–${num('REPLY_DELAY_MAX_MS', 5000)} ms`);
  console.log(`  Rearme     ${num('REARM_HOURS', 24)}h após o último contato`);
  console.log(`  Keepalive  ${state.keepalive.enabled ? `a cada ${state.keepalive.everyHours}h (anti-pause do Supabase free)` : 'desativado'}`);
  console.log(`  Monitor    conexão do WhatsApp a cada ${num('MONITOR_SECONDS', 60)}s`);

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

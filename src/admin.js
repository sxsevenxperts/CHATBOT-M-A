import './env.js';
import { str } from './env.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';

import {
  getTriages, updateTriageStatus, getMessages, getStats, contarTestes,
  purgeTestes, db, resetSession, resumoConexao, resumoEntrega,
  logMessage, statusPorWaId, listarDestinosBloqueados
} from './database.js';
import {
  listInstances, checkConnection, getQrCode, getWebhook, setWebhook, getConfig,
  reconnect, restartInstance, criarInstanciaOficial, logoutEPareaerDeNovo,
  sendText, webhookTemAutenticacao
} from './evolution.js';
import { ver as verFreio } from './freio.js';
import { reconciliarFreioPersistido, registrarEventoEReconciliar } from './canal.js';
import { list as listarEventos, resumo as resumoEventos, info } from './recorder.js';
import { retomarConversas } from './flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Tardia: no import o .env pode ainda não estar carregado. Sem segredo, o
// painel falha fechado; nunca volta silenciosamente para "admin".
const password = () => str('ADMIN_PASSWORD') || str('DASHBOARD_PASSWORD') || null;
const sessoesAdmin = new Map();
const tentativasLogin = new Map();
const SESSAO_MS = 8 * 3600_000;
let janelaGlobalLogin = { desde: Date.now(), falhas: 0 };

function limparControlesAdmin() {
  const agora = Date.now();
  for (const [token, expira] of sessoesAdmin) {
    if (expira <= agora) sessoesAdmin.delete(token);
  }
  for (const [ip, item] of tentativasLogin) {
    if (agora - item.desde > 30 * 60_000 && item.bloqueadoAte <= agora) tentativasLogin.delete(ip);
  }
  while (sessoesAdmin.size > 1000) sessoesAdmin.delete(sessoesAdmin.keys().next().value);
  while (tentativasLogin.size > 5000) tentativasLogin.delete(tentativasLogin.keys().next().value);
  if (agora - janelaGlobalLogin.desde > 15 * 60_000) {
    janelaGlobalLogin = { desde: agora, falhas: 0 };
  }
}

function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function tokenDaRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookies = Object.fromEntries(String(req.headers.cookie || '')
    .split(';').map(v => v.trim()).filter(v => v.includes('=')).map(v => {
      const i = v.indexOf('=');
      return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
    }));
  return cookies.ma_admin_session || '';
}

function novaSessao() {
  limparControlesAdmin();
  const token = crypto.randomBytes(32).toString('base64url');
  sessoesAdmin.set(token, Date.now() + SESSAO_MS);
  return token;
}

function sessaoValida(token) {
  const expira = sessoesAdmin.get(token);
  if (!expira || expira <= Date.now()) {
    if (token) sessoesAdmin.delete(token);
    return false;
  }
  return true;
}

function cookieSessao(req, token, maxAge = Math.floor(SESSAO_MS / 1000)) {
  const seguro = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  return [
    `ma_admin_session=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', seguro ? 'Secure' : null,
    `Max-Age=${maxAge}`
  ].filter(Boolean).join('; ');
}

function requireAuth(req, res, next) {
  if (!password()) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD não configurada' });
  }
  const token = tokenDaRequest(req);
  if (!sessaoValida(token)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  req.adminToken = token;
  next();
}

/** Envolve um handler async para que erro vire JSON em vez de derrubar a request. */
const wrap = fn => (req, res) =>
  fn(req, res).catch(err => {
    console.error(`[admin] ${req.method} ${req.path}:`, err?.message || err);
    res.status(500).json({ error: err?.message || 'Erro interno' });
  });

/** Quantos minutos o fuso está à frente do UTC naquele instante. */
function offsetMinutos(instante, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(dtf.formatToParts(instante).map(x => [x.type, x.value]));
  const comoSeFosseUTC = Date.UTC(p.year, Number(p.month) - 1, p.day, p.hour, p.minute, p.second);
  return (comoSeFosseUTC - instante.getTime()) / 60000;
}

/**
 * 00:00 de um dia LOCAL, convertido para o instante UTC correspondente.
 *
 * O dashboard escolhe datas no fuso da loja; o banco guarda UTC. Comparar
 * "2026-08-08" direto com `>= 2026-08-08T00:00:00Z` erra em 3 horas em Sobral:
 * uma mensagem das 22h caía no dia seguinte. Calcular pelo fuso resolve, e
 * continua correto se o fuso mudar.
 */
function inicioDoDiaLocalEmUTC(diaISO, tz) {
  const palpite = new Date(diaISO + 'T00:00:00Z');
  const off = offsetMinutos(palpite, tz);
  return new Date(palpite.getTime() - off * 60000).toISOString();
}

function somaDias(diaISO, n) {
  const d = new Date(diaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * URL pública desta aplicação.
 *
 * Prefere PUBLIC_URL; se não houver, deriva do próprio request (o EasyPanel
 * envia x-forwarded-proto/host). Sem isto, um ambiente sem PUBLIC_URL faria
 * "Sincronizar webhook" apontar a Evolution para localhost — quebrando o bot.
 */
function publicUrlFor(req, configured) {
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol || 'http';
  const host = req.headers['x-forwarded-host']?.split(',')[0]?.trim() || req.headers.host;
  return `${proto}://${host}`;
}

export function setupAdmin(app, { publicUrl, state = {} }) {
  // EasyPanel é o único proxy na frente do container. Confiar em qualquer
  // X-Forwarded-For permitiria burlar o rate limit com IPs inventados.
  app.set('trust proxy', 1);
  app.use('/admin', (req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  /* ---------- página ---------- */
  // no-store no HTML: uma aba aberta durante um deploy antigo continuava
  // rodando o JS velho e mostrando erros que já não existiam no servidor.
  // O selo de build deixa óbvio qual versão está carregada.
  const BUILD = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const htmlPath = path.join(PUBLIC_DIR, 'admin.html');

  app.use('/admin/assets', express.static(PUBLIC_DIR, { maxAge: '5m' }));

  app.get(['/admin', '/admin/'], (_req, res) => {
    let html;
    try {
      html = fs.readFileSync(htmlPath, 'utf8').replace(/\{\{BUILD\}\}/g, BUILD);
    } catch (e) {
      return res.status(500).send('admin.html não encontrado: ' + e.message);
    }
    res.set({
      'Cache-Control': 'no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.send(html);
  });

  app.get('/admin/api/build', (_req, res) => res.json({ build: BUILD }));

  /* ---------- login (rota pública) ---------- */
  app.post('/admin/api/login', (req, res) => {
    const { password: password_ } = req.body || {};
    const pw = password();
    if (!pw) return res.status(503).json({ error: 'ADMIN_PASSWORD não configurada no servidor' });

    const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
    const agora = Date.now();
    limparControlesAdmin();
    if (janelaGlobalLogin.falhas >= 100) {
      return res.status(429).json({ error: 'Login temporariamente limitado. Aguarde 15 minutos.' });
    }
    const controle = tentativasLogin.get(ip) || { falhas: 0, desde: agora, bloqueadoAte: 0 };
    if (controle.bloqueadoAte > agora) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    }
    if (agora - controle.desde > 15 * 60_000) {
      controle.falhas = 0;
      controle.desde = agora;
    }

    if (password_ && sameSecret(password_, pw)) {
      tentativasLogin.delete(ip);
      const token = novaSessao();
      res.setHeader('Set-Cookie', cookieSessao(req, token));
      const resposta = { ok: true, expiresIn: Math.floor(SESSAO_MS / 1000) };
      // A suíte usa bearer para testar a API; produção mantém o token somente
      // no cookie HttpOnly, fora do alcance do JavaScript do painel.
      if (process.env.NODE_ENV === 'test') resposta.token = token;
      return res.json(resposta);
    }

    controle.falhas++;
    janelaGlobalLogin.falhas++;
    if (controle.falhas >= 5) controle.bloqueadoAte = agora + 15 * 60_000;
    tentativasLogin.set(ip, controle);
    return res.status(401).json({ error: 'Senha incorreta' });
  });

  app.post('/admin/api/logout', requireAuth, (req, res) => {
    sessoesAdmin.delete(req.adminToken);
    res.setHeader('Set-Cookie', cookieSessao(req, '', 0));
    res.json({ ok: true });
  });

  /* ---------- tudo abaixo exige token ---------- */
  const api = express.Router();
  api.use(requireAuth);

  api.get('/status', wrap(async (req, res) => {
    let cfg = { baseUrl: null, instance: null };
    try { cfg = getConfig(); } catch (e) { cfg = { baseUrl: null, instance: null, error: e.message }; }
    const base = publicUrlFor(req, publicUrl);
    const freio = verFreio();
    let destinosBloqueados = [];
    let destinosBloqueadosErro = null;
    try {
      destinosBloqueados = await listarDestinosBloqueados({
        limite: Math.max(1, Number(process.env.FREIO_DESTINO_REJEICOES) || 2),
        incluirTestes: process.env.NODE_ENV === 'test'
      });
    } catch (e) {
      destinosBloqueadosErro = e.message;
    }
    const out = {
      baseUrl: cfg.baseUrl, instance: cfg.instance,
      publicUrl: base, publicUrlSource: publicUrl ? 'PUBLIC_URL' : 'request',
      ready: false,
      operational: false,
      boot: {
        db: state.db, canal: state.canal, env: state.env,
        whatsapp: state.whatsapp, webhook: state.webhook
      },
      entrega: state.entrega,
      freio,
      destinosBloqueados,
      destinosBloqueadosErro
    };

    try {
      const wa = await checkConnection();
      // Junta o que o monitor acumulou: desde quando caiu, tentativas, se pede QR.
      out.whatsapp = { ...wa, caiuEm: state.whatsapp?.caiuEm || null,
                       tentativas: state.whatsapp?.tentativas || 0,
                       precisaQr: !!state.whatsapp?.precisaQr };
    } catch (e) {
      out.whatsapp = { connected: false, error: e.message, caiuEm: state.whatsapp?.caiuEm || null };
    }

    try {
      const wh = await getWebhook();
      const expected = `${base}/webhook/messages`;
      const events = wh?.events || [];
      const authenticated = webhookTemAutenticacao(wh);
      out.webhook = {
        url: wh?.url || null,
        enabled: !!wh?.enabled,
        events,
        expected,
        correct: !!wh?.enabled && wh?.url === expected && authenticated &&
          ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'].every(e => events.includes(e)),
        authenticated
      };
      state.webhook = out.webhook.correct
        ? { ok: true, error: null, url: wh?.url || null, eventos: events, autenticado: true }
        : {
            ok: false,
            error: 'URL, eventos ou autenticação do webhook divergentes',
            url: wh?.url || null,
            eventos: events,
            autenticado: authenticated
          };
    } catch (e) {
      out.webhook = { error: e.message };
      state.webhook = { ...state.webhook, ok: false, error: e.message };
    }

    // O mesmo snapshot não pode dizer ready=true e, logo abaixo, mostrar a
    // sonda atual do WhatsApp/webhook em falha.
    out.ready = !!(
      state.db?.ok && state.canal?.ok &&
      out.whatsapp?.connected && out.webhook?.correct
    );
    out.operational = out.ready && !freio.bloqueado;

    res.json(out);
  }));

  api.post('/webhook/sync', wrap(async (req, res) => {
    const base = publicUrlFor(req, publicUrl);
    // Guarda-corpo: apontar a Evolution para localhost silencia o bot.
    if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(base)) {
      return res.status(400).json({
        error: `URL pública inválida (${base}). Defina PUBLIC_URL nas variáveis de ambiente.`
      });
    }
    const url = `${base}/webhook/messages`;
    await setWebhook(url);
    let confirmado = null;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      if (tentativa) await new Promise(resolve => setTimeout(resolve, 250));
      const atual = await getWebhook();
      const eventos = atual?.events || [];
      if (atual?.enabled && atual?.url === url &&
          ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'].every(e => eventos.includes(e)) &&
          webhookTemAutenticacao(atual)) {
        confirmado = atual;
        break;
      }
    }
    if (!confirmado) {
      return res.status(502).json({
        error: 'A Evolution respondeu ao sync, mas não confirmou o header secreto. Verifique a versão/configuração.'
      });
    }
    state.webhook = {
      ok: true, error: null, url,
      eventos: confirmado.events || [], autenticado: true
    };
    info('admin.webhookSincronizado', { url });
    // Não devolve a resposta crua: ela contém o header secreto do webhook.
    res.json({ ok: true, url, authenticated: true });
  }));

  api.get('/instances', wrap(async (_req, res) => res.json(await listInstances())));

  api.get('/qr', wrap(async (_req, res) => res.json(await getQrCode())));

  /**
   * Conectar/religar o WhatsApp pelo próprio dashboard.
   *
   * Existe para que ninguém precise abrir o Evolution Manager para religar o
   * atendimento — o QR aparece aqui e reconectar leva segundos.
   */
  api.post('/whatsapp/conectar', wrap(async (_req, res) => {
    const r = await reconnect();
    info('admin.whatsappConectar', { precisaQr: r.precisaQr });
    res.json({ ok: true, ...r });
  }));

  /**
   * Conecta pela API oficial da Meta (Cloud API).
   *
   * O token do cliente vai direto para a Evolution — não é gravado no nosso
   * banco nem aparece em log. A caixa preta registra só que a conexão foi
   * criada e para qual número.
   */
  api.post('/whatsapp/oficial', wrap(async (req, res) => {
    const { instanceName, number, token, businessId } = req.body || {};
    const faltando = Object.entries({ instanceName, number, token, businessId })
      .filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
    if (faltando.length) {
      return res.status(400).json({ error: `Preencha: ${faltando.join(', ')}` });
    }

    await criarInstanciaOficial({ instanceName, number, token, businessId });
    info('admin.conexaoOficialCriada', {
      instancia: instanceName,
      numero: String(number).replace(/\D/g, '').slice(0, 6) + '…',
      businessId: String(businessId).slice(0, 6) + '…'
    });
    res.json({
      ok: true,
      instancia: instanceName,
      proximoPasso: `Troque EVOLUTION_INSTANCE para "${instanceName}" nas variáveis do EasyPanel e faça redeploy.`
    });
  }));

  /**
   * Retoma na mão as conversas interrompidas.
   *
   * O sistema já faz isso sozinho quando a conexão volta de uma queda longa.
   * O botão existe para o caso de a atendente perceber antes, ou de a queda
   * ter sido curta demais para acionar o automático.
   */
  api.post('/retomar', wrap(async (req, res) => {
    const horas = Math.min(Math.max(Number(req.body?.horas) || 6, 1), 48);
    const r = await retomarConversas({ ultimasHoras: horas });
    res.json({ ok: true, ...r, janelaHoras: horas });
  }));

  /**
   * Encerra a sessão e devolve o QR do novo pareamento.
   *
   * Para quando a Evolution diz `open`, aceita o envio e a mensagem não chega:
   * reiniciar não resolve, porque o estado interno continua "conectado".
   */
  api.post('/whatsapp/desconectar', wrap(async (_req, res) => {
    const r = await logoutEPareaerDeNovo();
    info('admin.whatsappLogout', { qrGerado: !!r.qr });
    res.json({ ok: true, ...r });
  }));

  /** Reinicia a instância, para estado travado. */
  api.post('/whatsapp/reiniciar', wrap(async (_req, res) => {
    const r = await restartInstance();
    info('admin.whatsappReiniciar', {});
    res.json({ ok: true, resultado: r });
  }));

  /**
   * Filtros compartilhados por /triages, /stats e /messages.
   *
   * `ate` chega como o último dia desejado e vira o início do dia seguinte:
   * comparar com `< dia+1` é o único jeito de incluir o dia inteiro sem
   * depender do horário gravado.
   */
  function filtros(req) {
    const dia = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const de = dia(req.query.de);
    const ate = dia(req.query.ate);
    const tz = str('TIMEZONE', 'America/Fortaleza');

    return {
      de: de ? inicioDoDiaLocalEmUTC(de, tz) : null,
      // `ate` é o último dia desejado: o corte vai para 00:00 do dia seguinte,
      // que é o único jeito de incluir o dia inteiro.
      ate: ate ? inicioDoDiaLocalEmUTC(somaDias(ate, 1), tz) : null,
      incluirTestes: req.query.testes === '1'
    };
  }

  api.get('/triages', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const f = filtros(req);
    res.json(await getTriages({ ...f, limit }));
  }));

  api.put('/triages/:id', wrap(async (req, res) => {
    const allowed = ['pending', 'contacted', 'completed', 'rejected'];
    const { status } = req.body || {};
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status deve ser: ${allowed.join(', ')}` });
    }
    res.json(await updateTriageStatus(req.params.id, status));
  }));

  /** Marca as notificações como vistas (apaga o badge do dashboard). */
  api.post('/triages/seen', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ updated: 0 });
    const { error } = await db().from('triages').update({ seen: true }).in('id', ids);
    if (error) throw error;
    res.json({ updated: ids.length });
  }));

  /** Devolve um número ao bot (desfaz o handoff). */
  api.post('/sessions/:phone/reactivate', wrap(async (req, res) => {
    await resetSession(req.params.phone);
    info('admin.sessaoReativada', { de: req.params.phone });
    res.json({ ok: true });
  }));

  api.get('/messages', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 120, 500);
    const f = filtros(req);
    res.json(await getMessages({ ...f, limit }));
  }));

  api.get('/stats', wrap(async (req, res) => {
    const f = filtros(req);
    const [stats, testes] = await Promise.all([
      getStats(f),
      contarTestes({ de: f.de, ate: f.ate })
    ]);
    res.json({ ...stats, testes });
  }));

  /** Apaga as conversas de teste, deixando só atendimento real. */
  api.delete('/testes', wrap(async (_req, res) => {
    // A suíte usa o mesmo Supabase, porém só pode limpar os próprios números.
    // Em produção o botão mantém o comportamento administrativo de apagar
    // todas as linhas explicitamente marcadas como teste.
    const phones = process.env.NODE_ENV === 'test'
      ? str('TEST_PHONES').split(',').map(v => v.trim()).filter(Boolean)
      : null;
    const apagados = await purgeTestes({ phones });
    info('admin.testesApagados', apagados);
    res.json({ ok: true, apagados });
  }));

  /**
   * Estabilidade da conexão no período — sobrevive a deploy, ao contrário da
   * caixa preta. É o que responde "quantas vezes caiu esta semana?".
   */
  api.get('/conexao/historico', wrap(async (req, res) => {
    const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90);
    res.json(await resumoConexao({ dias, instance: getConfig().instance }));
  }));

  /** As mensagens estão sendo ENTREGUES? Aceite não é entrega. */
  api.get('/entrega', wrap(async (req, res) => {
    const minutos = Math.min(Math.max(Number(req.query.minutos) || 30, 5), 1440);
    res.json({
      ...(await resumoEntrega({ minutos, incluirTestes: process.env.NODE_ENV === 'test' })),
      freio: verFreio()
    });
  }));

  /* ---------- freio de envio ---------- */

  api.get('/envio/freio', wrap(async (_req, res) => res.json(verFreio())));

  /** Liberação manual — deliberadamente manual: religar sozinho agrava. */
  api.post('/envio/liberar', wrap(async (req, res) => {
    if (req.body?.confirmar !== 'LIBERAR_MANUALMENTE') {
      return res.status(400).json({
        error: 'Override manual não confirmado. Prefira uma sonda entregue, que libera o canal automaticamente.'
      });
    }
    const motivo = String(req.body?.motivo || 'override manual pela dashboard').slice(0, 200);
    const { estado } = await registrarEventoEReconciliar(
      'MANUAL_RELEASE', motivo, 'dashboard'
    );
    res.json({ ok: true, freio: estado });
  }));

  api.post('/envio/bloquear', wrap(async (req, res) => {
    const motivo = String(req.body?.motivo || 'bloqueio manual pela dashboard').slice(0, 200);
    const { estado } = await registrarEventoEReconciliar('MANUAL_BLOCK', motivo, 'dashboard');
    res.json({ ok: true, freio: estado });
  }));

  /**
   * Sonda de envio: UMA mensagem, com espera pelo ACK real.
   *
   * É o único jeito honesto de saber se o canal voltou — e o único envio que
   * ignora o freio. Se o ACK confirmar entrega, o freio sai sozinho.
   */
  api.post('/envio/sonda', wrap(async (req, res) => {
    const numero = String(req.body?.numero || '').replace(/\D/g, '');
    if (numero.length < 10) return res.status(400).json({ error: 'Informe o número com DDD' });
    const texto = String(req.body?.texto || 'Teste de envio do sistema M & A. Pode ignorar.').slice(0, 300);

    const r = await sendText(numero, texto);
    await logMessage(numero, 'out', texto, r?.waId || null, r?.status || null);
    info('envio.sonda', { aceito: !!r?.waId, status: r?.status || null });

    // Espera o ACK: aceite (PENDING) não prova nada.
    const limite = Date.now() + Math.max(2000, Number(process.env.SONDA_TIMEOUT_MS) || 25_000);
    let status = r?.status || null;
    while (Date.now() < limite) {
      await new Promise(s => setTimeout(s, 2500));
      const atual = await statusPorWaId(r?.waId);
      if (atual?.status) {
        status = atual.status;
        if (['DELIVERY_ACK', 'READ', 'PLAYED', 'ERROR'].includes(status)) break;
      }
    }

    const entregue = ['DELIVERY_ACK', 'READ', 'PLAYED'].includes(status);
    const evento = entregue ? 'PROBE_DELIVERED' : status === 'ERROR' ? 'PROBE_ERROR' : null;
    const detalhe = entregue
      ? 'sonda com entrega confirmada'
      : status === 'ERROR' ? 'sonda recusada pelo WhatsApp' : null;
    const { estado: freio } = evento
      ? await registrarEventoEReconciliar(evento, detalhe, 'sonda')
      : await reconciliarFreioPersistido('sonda');

    res.json({
      waId: r?.waId || null,
      status,
      entregue,
      rejeitada: status === 'ERROR',
      freio,
      veredito: entregue
        ? 'Entregue. O canal está de pé e o freio foi liberado.'
        : status === 'ERROR'
          ? freio.bloqueado
            ? 'REJEITADA pelo WhatsApp. O canal continua bloqueado — não repareie em série.'
            : 'REJEITADA para este destinatário. Os demais atendimentos seguem ativos.'
          : 'Sem confirmação no tempo de espera. Aceito e não confirmado: trate como não entregue.'
    });
  }));

  /** Caixa preta: últimos eventos do sistema, para diagnosticar sem o console. */
  api.get('/log', wrap(async (req, res) => {
    const level = ['info', 'warn', 'error', 'all'].includes(req.query.level) ? req.query.level : 'all';
    const limit = Math.min(Number(req.query.limit) || 120, 400);
    res.json({ resumo: resumoEventos(), eventos: listarEventos({ level, limit }) });
  }));

  app.use('/admin/api', api);

  info('admin.rotas', { base: '/admin' });
}

import './env.js';
import { str } from './env.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  getTriages, updateTriageStatus, getMessages, getStats, db, resetSession
} from './database.js';
import {
  listInstances, checkConnection, getQrCode, getWebhook, setWebhook, getConfig
} from './evolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Tardia: no import o .env pode ainda não estar carregado.
const password = () => str('ADMIN_PASSWORD') || str('DASHBOARD_PASSWORD') || 'admin';

function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameSecret(token, password())) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

/** Envolve um handler async para que erro vire JSON em vez de derrubar a request. */
const wrap = fn => (req, res) =>
  fn(req, res).catch(err => {
    console.error(`[admin] ${req.method} ${req.path}:`, err?.message || err);
    res.status(500).json({ error: err?.message || 'Erro interno' });
  });

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
  app.set('trust proxy', true);
  /* ---------- página ---------- */
  app.use('/admin/assets', express.static(PUBLIC_DIR, { maxAge: '1h' }));
  app.get(['/admin', '/admin/'], (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'))
  );

  /* ---------- login (rota pública) ---------- */
  app.post('/admin/api/login', (req, res) => {
    const { password: password_ } = req.body || {};
    const pw = password();
    if (password_ && sameSecret(password_, pw)) return res.json({ token: pw });
    return res.status(401).json({ error: 'Senha incorreta' });
  });

  /* ---------- tudo abaixo exige token ---------- */
  const api = express.Router();
  api.use(requireAuth);

  api.get('/status', wrap(async (req, res) => {
    let cfg = { baseUrl: null, instance: null };
    try { cfg = getConfig(); } catch (e) { cfg = { baseUrl: null, instance: null, error: e.message }; }
    const base = publicUrlFor(req, publicUrl);
    const out = {
      baseUrl: cfg.baseUrl, instance: cfg.instance,
      publicUrl: base, publicUrlSource: publicUrl ? 'PUBLIC_URL' : 'request',
      boot: { db: state.db, env: state.env }
    };

    try {
      out.whatsapp = await checkConnection();
    } catch (e) {
      out.whatsapp = { connected: false, error: e.message };
    }

    try {
      const wh = await getWebhook();
      const expected = `${base}/webhook/messages`;
      out.webhook = {
        url: wh?.url || null,
        enabled: !!wh?.enabled,
        events: wh?.events || [],
        expected,
        correct: !!wh?.enabled && wh?.url === expected
      };
    } catch (e) {
      out.webhook = { error: e.message };
    }

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
    const result = await setWebhook(url);
    console.log(`[admin] webhook apontado para ${url}`);
    res.json({ ok: true, url, result });
  }));

  api.get('/instances', wrap(async (_req, res) => res.json(await listInstances())));

  api.get('/qr', wrap(async (_req, res) => res.json(await getQrCode())));

  api.get('/triages', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await getTriages(limit));
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
    console.log(`[admin] sessão de ${req.params.phone} reativada para o bot`);
    res.json({ ok: true });
  }));

  api.get('/messages', wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 120, 500);
    res.json(await getMessages(limit));
  }));

  api.get('/stats', wrap(async (_req, res) => res.json(await getStats())));

  app.use('/admin/api', api);

  console.log('[admin] rotas registradas em /admin');
}

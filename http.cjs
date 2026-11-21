'use strict';

const crypto = require('node:crypto');

function configureHttp(app, service, config = {}, options = {}) {
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const allowedOrigins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
  const limits = new Map();
  const perMinute = Math.max(10, Number(options.rateLimit || 60) || 60);

  app.use((req, res, next) => {
    const incoming = String(req.get('x-request-id') || '').trim();
    const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.requestId = requestId;
    res.set('X-Request-ID', requestId);
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, service, version: '1.0.0' }));
  app.use('/api/v1', (req, res, next) => {
    const now = Date.now();
    const client = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const recent = (limits.get(client) || []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= perMinute) return res.status(429).json({ error: 'Limite de consultas por minuto excedido', requestId: req.requestId });
    recent.push(now); limits.set(client, recent);
    if (limits.size > 5000) for (const [key, timestamps] of limits) if (!timestamps.some((timestamp) => now - timestamp < 60_000)) limits.delete(key);
    next();
  });
}

function clampInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function safeHttpUrl(value, label = 'URL') {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(`${label} inválida.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`${label} precisa usar HTTP(S) e não pode conter credenciais ou fragmento.`);
  return url;
}

module.exports = { configureHttp, clampInt, safeHttpUrl };

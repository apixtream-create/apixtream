'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { configureHttp, clampInt, safeHttpUrl } = require('./http.cjs');

const VERSION = '1.0.0';
const CATALOG_ACTIONS = Object.freeze({ live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' });
const CATEGORY_ACTIONS = Object.freeze({ live: 'get_live_categories', vod: 'get_vod_categories', series: 'get_series_categories' });
const DEFAULT_CATALOG_PRIORITY = Object.freeze(['clbtw']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

function loadAppConfig() {
  const config = readJson(path.join(__dirname, 'config', 'app-config.json'), {});
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config/app-config.json inválido.');
  return config;
}

function loadServiceConfig() {
  return readJson(path.join(__dirname, 'config', 'service-config.json'), { playbackTokenSecret: '' });
}

function loadSources(entries = null, appConfig = loadAppConfig()) {
  const directory = path.join(__dirname, 'config', 'xtream');
  const files = entries ? [] : (fs.existsSync(directory) ? fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort() : []);
  const parsed = entries || files.map((file) => readJson(path.join(directory, file)));
  if (!Array.isArray(parsed) || parsed.length > 50) throw new Error('As contas Xtream devem formar um array com no máximo 50 fontes.');
  const priority = new Map((Array.isArray(appConfig.XTREAM_SEARCH_PRIORITY) ? appConfig.XTREAM_SEARCH_PRIORITY : []).map((id, index) => [String(id), index]));
  const ids = new Set();
  return parsed.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    const name = String(entry?.name || id).trim().slice(0, 100);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) throw new Error(`ID inválido ou duplicado na fonte ${index + 1}.`);
    ids.add(id);
    const url = safeHttpUrl(entry.base ?? entry.baseUrl, `base da fonte ${id}`);
    if (url.search || url.hash) throw new Error(`baseUrl da fonte ${id} não pode ter query ou fragmento.`);
    const baseUrl = url.toString().replace(/\/+$/, '');
    const username = String(entry.username || '');
    const password = String(entry.password || '');
    if (!username || !password || username.length > 256 || password.length > 256) throw new Error(`Credenciais ausentes ou inválidas na fonte ${id}.`);
    return { id, name, baseUrl, username, password, priority: priority.has(id) ? priority.get(id) : Number.MAX_SAFE_INTEGER, sourceIndex: index };
  }).sort((a, b) => a.priority - b.priority || a.sourceIndex - b.sourceIndex).map(({ sourceIndex, ...source }) => source);
}

function normalizeTitle(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(dublado|dublada|legendado|legendada|dual audio|720p|1080p|2160p)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function categoryMatches(actualValue, requestedValue) {
  const actual = normalizeTitle(actualValue);
  const requested = normalizeTitle(requestedValue);
  if (!requested) return true;
  if (actual.includes(requested)) return true;
  const aliases = {
    anime: ['animes', 'animacao', 'animacoes'],
    dorama: ['doramas', 'kdrama', 'kdramas', 'drama asiatico', 'dramas asiaticos']
  };
  return (aliases[requested] || []).some((alias) => actual.includes(alias));
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function makePlaybackToken(payload, secret) {
  const key = crypto.createHash('sha256').update(String(secret || 'development-only')).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + 15 * 60_000 }));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function readPlaybackToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token inválido');
  const key = crypto.createHash('sha256').update(String(secret || 'development-only')).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  if (!payload.expiresAt || Date.now() > payload.expiresAt) throw new Error('token expirado');
  return payload;
}

function streamUrl(source, kind, itemId, extension = '') {
  const segment = kind === 'live' ? 'live' : kind === 'vod' ? 'movie' : kind === 'series' ? 'series' : '';
  if (!segment || !/^[A-Za-z0-9_-]{1,120}$/.test(String(itemId))) throw new Error('Referência de stream inválida.');
  const safeExtension = /^[A-Za-z0-9]{1,8}$/.test(String(extension)) ? String(extension) : (kind === 'live' ? 'ts' : 'mp4');
  const base = new URL(source.baseUrl.endsWith('/') ? source.baseUrl : `${source.baseUrl}/`);
  const resource = `${segment}/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${encodeURIComponent(String(itemId))}.${safeExtension}`;
  return new URL(resource, base).toString();
}

function itemId(item, kind) {
  return String(kind === 'series' ? (item.series_id ?? item.id ?? '') : (item.stream_id ?? item.id ?? ''));
}

function field(item, names) {
  for (const name of names) {
    const value = item?.[name] ?? item?.info?.[name] ?? item?.movie_data?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

async function mapWithinDeadline(items, maximum, deadlineAt, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (Date.now() < deadlineAt) {
      const index = nextIndex++;
      if (index >= items.length) return;
      if (Date.now() >= deadlineAt) return;
      try { results[index] = await mapper(items[index], deadlineAt - Date.now()); }
      catch { results[index] = { failed: true }; }
    }
  }
  const workerCount = Math.min(maximum, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((result) => result !== undefined);
}

function createApp({ config = null, sources: sourceOverride = null, fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  const appConfig = config || loadAppConfig();
  const serviceConfig = loadServiceConfig();
  const sources = sourceOverride || loadSources(null, appConfig);
  const catalogCache = new Map();
  const categoryCache = new Map();
  const catalogPriority = [...new Set((Array.isArray(appConfig.XTREAM_CATALOG_PRIORITY)
    ? appConfig.XTREAM_CATALOG_PRIORITY
    : DEFAULT_CATALOG_PRIORITY).map((id) => String(id).trim()).filter(Boolean))];
  const tokenSecret = String(serviceConfig?.playbackTokenSecret || '');
  if (Buffer.byteLength(tokenSecret, 'utf8') < 32) throw new Error('Configure um playbackTokenSecret de pelo menos 32 bytes em config/service-config.json.');
  const timeoutMs = clampInt(appConfig.XTREAM_TIMEOUT_MS, 25_000, 1_000, 25_000);
  const searchDeadlineMs = clampInt(appConfig.XTREAM_IMDB_TIMEOUT_MS, 25_000, 1_000, 60_000);
  const imdbStreamTimeoutMs = clampInt(appConfig.IMDB_STREAM_TIMEOUT_MS, 25_000, 1_000, 60_000);
  const sourceConcurrency = 3;
  const cacheMs = clampInt(appConfig.CACHE_TTL_MS, 900_000, 0, 600_000);

  configureHttp(app, 'iracemaflix-xtream-api', {}, { rateLimit: 60, openApi: true });
  app.use('/api/v1', express.json({ limit: '16kb', strict: true }));
  app.get('/openapi.json', (_req, res) => {
    const file = path.join(__dirname, 'openapi.json');
    if (fs.existsSync(file)) return res.type('application/json').sendFile(file);
    res.status(404).json({ error: 'OpenAPI ainda não foi gerado.' });
  });

  async function requestXtream(source, params, remainingMs = timeoutMs) {
    if (remainingMs <= 0) throw new Error('prazo da consulta esgotado');
    const endpoint = new URL(source.baseUrl.endsWith('/') ? `${source.baseUrl}player_api.php` : `${source.baseUrl}/player_api.php`);
    endpoint.searchParams.set('username', source.username);
    endpoint.searchParams.set('password', source.password);
    for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, String(value));
    const timer = abortAfter(Math.max(1, Math.min(timeoutMs, remainingMs)));
    try {
      const response = await fetchImpl(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'IracemaFlix-Xtream-API/1.0' }, signal: timer.signal });
      if (!response.ok) throw new Error(`upstream status ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 30 * 1024 * 1024) throw new Error('upstream payload grande demais');
      try { return JSON.parse(text); } catch { throw new Error('upstream retornou JSON inválido'); }
    } finally { timer.clear(); }
  }

  async function getCatalog(source, kind, refresh = false, remainingMs = timeoutMs) {
    const action = CATALOG_ACTIONS[kind];
    if (!action) throw new Error('Tipo de catálogo inválido.');
    const key = `${source.id}:${kind}`;
    const cached = catalogCache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await requestXtream(source, { action }, remainingMs);
    if (!Array.isArray(value)) throw new Error('catálogo upstream inválido');
    if (cacheMs > 0) catalogCache.set(key, { value, expiresAt: Date.now() + cacheMs });
    return value;
  }

  async function getCategories(source, kind, remainingMs = timeoutMs) {
    const action = CATEGORY_ACTIONS[kind];
    if (!action) return [];
    const key = `${source.id}:${kind}:categories`;
    const cached = categoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await requestXtream(source, { action }, Math.min(5_000, remainingMs));
    if (!Array.isArray(value)) throw new Error('categorias upstream inválidas');
    if (cacheMs > 0) categoryCache.set(key, { value, expiresAt: Date.now() + cacheMs });
    return value;
  }

  function safeFailureCode(error) {
    const message = String(error?.message || error || '');
    const status = message.match(/status\s+(\d{3})/i)?.[1];
    if (status) return `HTTP_${status}`;
    if (/timeout|prazo|abort/i.test(message)) return 'TIMEOUT';
    if (/json/i.test(message)) return 'INVALID_JSON';
    if (/payload/i.test(message)) return 'INVALID_PAYLOAD';
    return 'UPSTREAM_ERROR';
  }

  function safeSource(source) { return { id: source.id, name: source.name }; }
  function makePlaybackPath(source, kind, id, extension) {
    const token = makePlaybackToken({ sourceId: source.id, kind, itemId: String(id), extension: String(extension || '') }, tokenSecret);
    return `/play/${token}`;
  }

  app.get('/api/v1/sources', (_req, res) => res.json({ sources: sources.map(safeSource) }));

  app.get('/api/v1/catalog/:kind', async (req, res) => {
    const kind = String(req.params.kind || '');
    if (!Object.hasOwn(CATALOG_ACTIONS, kind)) return res.status(400).json({ error: 'kind deve ser live, vod ou series' });
    const sourceId = String(req.query.sourceId || '').trim();
    const selected = sourceId
      ? sources.filter((source) => source.id === sourceId)
      : catalogPriority.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
    if (sourceId && !selected.length) return res.status(404).json({ error: 'Fonte Xtream não encontrada' });
    if (!selected.length) return res.status(503).json({ error: 'Nenhuma fonte Xtream configurada para o catálogo' });
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    const search = normalizeTitle(req.query.search);
    const categoryId = String(req.query.categoryId || '');
    const categoryName = normalizeTitle(req.query.categoryName || '');
    const deadlineAt = Date.now() + Math.min(searchDeadlineMs, imdbStreamTimeoutMs);
    const failedSources = [];
    const failedSourceDetails = [];
    const attemptedSources = [];
    let selectedSource = null;
    let items = [];

    for (const source of selected) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      try {
        const [rawItems, rawCategories] = await Promise.all([
          getCatalog(source, kind, false, remainingMs),
          getCategories(source, kind, remainingMs).catch(() => [])
        ]);
        const categoryNames = new Map(rawCategories.map((category) => [String(category.category_id), String(category.category_name || '')]));
        const sourceItems = rawItems.map((item) => {
          const id = itemId(item, kind);
          const itemCategoryId = String(item.category_id || '');
          const category = String(item.category_name || item.categoryName || categoryNames.get(itemCategoryId) || '');
          const extension = String(item.container_extension || (kind === 'live' ? 'ts' : kind === 'series' ? '' : 'mp4'));
          const mapped = {
            id, sourceId: source.id, sourceName: source.name,
            name: String(item.name || item.title || '').slice(0, 300),
            categoryId: itemCategoryId, categoryName: category,
            streamType: kind,
            extension: /^[A-Za-z0-9]{1,8}$/.test(extension) ? extension : '',
            image: String(item.stream_icon || item.cover || item.movie_image || '').slice(0, 2000),
            tmdbId: field(item, ['tmdb_id', 'tmdb']),
            imdbId: field(item, ['imdb_id', 'imdb']),
            year: field(item, ['year', 'releaseDate', 'releasedate'])
          };
          if (kind !== 'series' && id) mapped.playbackPath = makePlaybackPath(source, kind, id, extension);
          return mapped;
        }).filter((item) => item.id && (!categoryId || item.categoryId === categoryId)
          && (!categoryName || categoryMatches(item.categoryName, categoryName))
          && (!search || normalizeTitle(`${item.name} ${item.categoryName}`).includes(search)));
        attemptedSources.push({ id: source.id, status: sourceItems.length ? 'selected' : rawItems.length ? 'no_match' : 'empty', count: sourceItems.length });
        if (sourceItems.length) {
          selectedSource = safeSource(source);
          items = sourceItems;
          break;
        }
      } catch (error) {
        const code = safeFailureCode(error);
        failedSources.push(source.id);
        failedSourceDetails.push({ id: source.id, code });
        attemptedSources.push({ id: source.id, status: 'failed', code, count: 0 });
      }
    }

    const page = items.slice(offset, offset + limit);
    const result = {
      kind, total: items.length, offset, limit, selectedSource,
      items: page, failedSources, failedSourceDetails, attemptedSources,
      partial: failedSources.length > 0
    };
    console.info('[xtream-catalog] ' + JSON.stringify({
      requestId: req.requestId,
      kind,
      selectedSource: selectedSource?.id || null,
      attemptedSources,
      failedSources: failedSourceDetails,
      total: items.length,
      returned: page.length,
      offset,
      limit,
      filters: { search: Boolean(search), categoryId: Boolean(categoryId), categoryName: Boolean(categoryName) }
    }));
    res.json(result);
  });

  app.post('/api/v1/streams/search', async (req, res) => {
    const body = req.body || {};
    const mediaType = String(body.mediaType || body.type || '').toLowerCase();
    if (!['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'mediaType deve ser movie ou tv' });
    const tmdbId = String(body.tmdbId || '').trim();
    const imdbId = String(body.imdbId || '').trim();
    const title = String(body.title || '').trim().slice(0, 200);
    const normalizedTitle = normalizeTitle(title);
    if (!tmdbId && !imdbId && normalizedTitle.length < 3) return res.status(400).json({ error: 'Informe tmdbId, imdbId ou title' });
    const season = body.season == null ? null : clampInt(body.season, 0, 1, 100);
    const episode = body.episode == null ? null : clampInt(body.episode, 0, 1, 10_000);
    if (mediaType === 'tv' && ((season == null) !== (episode == null))) return res.status(400).json({ error: 'Informe season e episode juntos para séries' });
    if (!sources.length) return res.status(503).json({ streams: [], failedSources: [], error: 'Nenhuma fonte Xtream configurada' });

    const deadlineAt = Date.now() + searchDeadlineMs;
    const outputs = await mapWithinDeadline(sources, sourceConcurrency, deadlineAt, async (source) => {
      try {
        const kind = mediaType === 'movie' ? 'vod' : 'series';
        const catalog = await getCatalog(source, kind, false, deadlineAt - Date.now());
        const matches = catalog.filter((item) => {
          const idMatches = (tmdbId && field(item, ['tmdb_id', 'tmdb']) === tmdbId)
            || (imdbId && field(item, ['imdb_id', 'imdb']) === imdbId);
          if (idMatches) return true;
          if (!normalizedTitle) return false;
          const candidate = normalizeTitle(item.name || item.title);
          return candidate === normalizedTitle || (normalizedTitle.length >= 8 && candidate.includes(normalizedTitle));
        }).slice(0, 5);
        if (mediaType === 'movie') {
          return { source, streams: matches.map((item) => {
            const id = itemId(item, 'vod');
            const extension = String(item.container_extension || 'mp4');
            return id ? {
              id, name: String(item.name || item.title || title).slice(0, 300),
              sourceId: source.id, sourceName: source.name, kind: 'vod',
              quality: field(item, ['quality', 'video_quality']),
              playbackPath: makePlaybackPath(source, 'vod', id, extension)
            } : null;
          }).filter(Boolean) };
        }
        const streams = [];
        for (const item of matches) {
          const seriesId = itemId(item, 'series');
          if (!seriesId) continue;
          if (season == null) {
            streams.push({ id: seriesId, name: String(item.name || item.title || title).slice(0, 300), sourceId: source.id, sourceName: source.name, kind: 'series', seasonRequired: true });
            continue;
          }
          const info = await requestXtream(source, { action: 'get_series_info', series_id: seriesId }, deadlineAt - Date.now());
          const episodesBySeason = info?.episodes && typeof info.episodes === 'object' ? info.episodes : {};
          const episodeList = Array.isArray(episodesBySeason[String(season)]) ? episodesBySeason[String(season)] : Object.values(episodesBySeason).flatMap((list) => Array.isArray(list) ? list : []);
          const selected = episodeList.find((candidate) => Number(candidate.episode_num ?? candidate.episode ?? candidate.episode_number) === episode && Number(candidate.season ?? season) === season)
            || episodeList.find((candidate) => Number(candidate.episode_num ?? candidate.episode ?? candidate.episode_number) === episode);
          if (!selected) continue;
          const id = String(selected.id ?? selected.episode_id ?? '');
          if (!id) continue;
          const extension = String(selected.container_extension || 'mp4');
          streams.push({
            id, name: String(item.name || item.title || title).slice(0, 300), sourceId: source.id, sourceName: source.name,
            kind: 'series', season, episode, quality: field(selected, ['quality', 'video_quality']),
            playbackPath: makePlaybackPath(source, 'series', id, extension)
          });
        }
        return { source, streams };
      } catch { return { source, streams: [], failed: true }; }
    });
    const streams = outputs.flatMap((result) => result.streams);
    const completedIds = new Set(outputs.map((result) => result.source?.id).filter(Boolean));
    const failedSources = [...outputs.filter((result) => result.failed).map((result) => result.source.id), ...sources.filter((source) => !completedIds.has(source.id)).map((source) => source.id)];
    if (!streams.length && failedSources.length === sources.length) return res.status(502).json({ streams: [], failedSources, error: 'As fontes Xtream não responderam' });
    res.json({ streams, failedSources, partial: failedSources.length > 0 });
  });

  app.get('/play/:token', (req, res) => {
    try {
      const payload = readPlaybackToken(req.params.token, tokenSecret);
      const source = sources.find((candidate) => candidate.id === payload.sourceId);
      if (!source) return res.status(404).type('text/plain').send('Fonte indisponível');
      const url = streamUrl(source, payload.kind, payload.itemId, payload.extension);
      res.set('Cache-Control', 'no-store, private');
      return res.redirect(302, url);
    } catch {
      return res.status(410).type('text/plain').send('Link de reprodução inválido ou expirado');
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada', requestId: req.requestId }));
  app.use((err, req, res, _next) => {
    if (res.headersSent) return res.end();
    const candidate = Number(err?.statusCode || err?.status);
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    res.status(status).json({ error: status === 500 ? 'Erro interno do serviço' : String(err.message || 'Falha na requisição'), requestId: req?.requestId });
  });
  return app;
}

if (require.main === module) {
  const appConfig = loadAppConfig();
  const port = clampInt(appConfig.PORT, 7000, 1, 65_535);
  const app = createApp({ config: appConfig });
  app.listen(port, '0.0.0.0', () => console.log(`[xtream-api] listening on ${port}; configured sources=${loadSources(null, appConfig).length}`));
}

module.exports = { createApp, loadSources, loadAppConfig, normalizeTitle, makePlaybackToken, readPlaybackToken, streamUrl };

import config from './config.json' with { type: 'json' };
import { parseFeed, MAX_AGE } from './feed.mjs';
import { collectChannels, FeedError } from './rss.mjs';

const ASSET_PATHS = new Set(['/', '/index.html', '/styles.css', '/app.mjs', '/feed.mjs']);
const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const responseJSON = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...HEADERS, ...headers } });
const errorJSON = (error, status) => responseJSON({ error }, status);

async function pruneExpiredFeed(db, raw, now) {
  if (raw && now - Date.parse(JSON.parse(raw).generated_at) >= MAX_AGE) {
    await db.prepare("DELETE FROM app_state WHERE key='feed' AND value=?").bind(raw).run();
  }
}

export async function loadFeedState(env, now = Date.now()) {
  const stateResult = await env.DB.prepare('SELECT key, value FROM app_state').all();
  const state = Object.fromEntries(stateResult.results.map(row => [row.key, row.value]));
  let feed = null;
  if (state.feed) {
    const raw = JSON.parse(state.feed);
    if (now - Date.parse(raw.generated_at) >= MAX_AGE) {
      try { await pruneExpiredFeed(env.DB, state.feed, now); } catch { /* Read filtering remains effective when maintenance cannot write. */ }
    } else { feed = { schema_version: 1, source: 'youtube', ...parseFeed(raw, now) }; }
  }
  const refresh = state.refresh ? JSON.parse(state.refresh) : null;
  if (refresh?.status === 'running' && refresh.lease_until < now) { refresh.status = 'failed'; refresh.error = 'interrupted'; }
  return { feed, refresh, channels: config.channels.map(({ id, name, topics }) => ({ id, name, topics })) };
}

export async function refreshFeeds(env, { channels = config.channels, collect = collectChannels, now = Date.now() } = {}) {
  const run = { status: 'running', error: null, run_id: crypto.randomUUID(), attempt_ms: now, lease_until: now + 60000 };
  // attempt_ms is the last attempt's epoch milliseconds, the sole source for the five-minute cooldown.
  const acquired = await env.DB.prepare(`INSERT INTO app_state(key,value) VALUES('refresh',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(app_state.value,'$.attempt_ms')<=? AND json_extract(app_state.value,'$.lease_until')<=?`)
    .bind(JSON.stringify(run), now - 300000, now).run();
  if (acquired.meta.changes === 0) return { status: 'cooldown' };
  if (acquired.meta.changes !== 1) throw new Error('storage_unavailable');
  try {
    const previous = await env.DB.prepare("SELECT value FROM app_state WHERE key='feed'").first();
    await pruneExpiredFeed(env.DB, previous?.value, now);
    const feed = await collect(channels);
    const publishNow = Date.now();
    const finished = { ...run, status: 'ok', lease_until: 0 };
    // Both statements test the same run and bound time inside one transaction; only the second changes the lock.
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO app_state(key,value)
        SELECT 'feed',? WHERE EXISTS(SELECT 1 FROM app_state WHERE key='refresh'
        AND json_extract(value,'$.run_id')=? AND json_extract(value,'$.lease_until')>=?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(feed), run.run_id, publishNow),
      env.DB.prepare(`UPDATE app_state SET value=? WHERE key='refresh'
        AND json_extract(value,'$.run_id')=? AND json_extract(value,'$.lease_until')>=?`).bind(JSON.stringify(finished), run.run_id, publishNow),
    ]);
    if (results.every(result => result.meta.changes === 0)) return { status: 'superseded' };
    if (results.some(result => result.meta.changes !== 1)) throw new Error('storage_unavailable');
    return { status: 'ok' };
  } catch (error) {
    const code = error instanceof FeedError ? error.code : 'collection_failed';
    const failed = { ...run, status: 'failed', error: code, lease_until: 0 };
    await env.DB.prepare(`UPDATE app_state SET value=? WHERE key='refresh'
      AND json_extract(value,'$.run_id')=? AND json_extract(value,'$.lease_until')>=?`)
      .bind(JSON.stringify(failed), run.run_id, Date.now()).run();
    return { status: 'failed', error: code };
  }
}

export async function handleRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (ASSET_PATHS.has(path) && ['GET', 'HEAD'].includes(request.method)) {
    try {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers });
    } catch { return errorJSON('service_unavailable', 503); }
  }
  if (path === '/api/feed' && request.method === 'GET') {
    try { return responseJSON(await loadFeedState(env)); }
    catch { return errorJSON('service_unavailable', 503); }
  }
  return errorJSON(ASSET_PATHS.has(path) || path === '/api/feed' ? 'method_not_allowed' : 'not_found', ASSET_PATHS.has(path) || path === '/api/feed' ? 405 : 404);
}

export default {
  fetch: (request, env) => handleRequest(request, env),
  async scheduled(event, env) {
    const result = await refreshFeeds(env);
    if (result.status === 'failed') throw new Error(result.error);
  },
};

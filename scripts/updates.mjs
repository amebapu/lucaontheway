import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseUpdates, parseFeed, parsePublication, CLOCK_SKEW } from '../feed.mjs';
import { parseArchiveManifest } from '../archive.mjs';
import { MAX_HISTORY_BYTES, MAX_PUBLICATION_BYTES, MAX_HANDOFF_BYTES } from '../capacity.mjs';

export const BOOTSTRAP_PARENT_SHA = '';
export const REPOSITORY = 'amebapu/lucaontheway';
export const PAGE_FEED_URL = 'https://amebapu.github.io/lucaontheway/feed.json';
export const RUNS_URL = `https://api.github.com/repos/${REPOSITORY}/actions`;
const SHA = /^[a-f0-9]{40}$/, EVENTS = ['push', 'schedule', 'workflow_dispatch'];

export function publicationContext(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' || !EVENTS.includes(env.GITHUB_EVENT_NAME) || env.GITHUB_RUN_ATTEMPT !== '1' || !/^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID || '') || !SHA.test(env.GITHUB_SHA || '')) throw new Error('updates_context');
  return { run_id: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, attempt: 1 };
}

export function bootstrapAllowed(context, event, source) {
  return !!BOOTSTRAP_PARENT_SHA && context?.ref === 'refs/heads/main' && context.attempt === 1 && context.event === 'push' && event?.ref === context.ref && event.before === BOOTSTRAP_PARENT_SHA && event.after === context.sha && source.head_sha === BOOTSTRAP_PARENT_SHA;
}

async function pushEvent(context, env) {
  if (!BOOTSTRAP_PARENT_SHA || context.event !== 'push') return null;
  if (!env.GITHUB_EVENT_PATH || (await stat(env.GITHUB_EVENT_PATH)).size > 1024 * 1024) throw new Error('updates_context');
  const raw = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  return { before: raw.before, after: raw.after, ref: raw.ref };
}

function runInfo(raw) {
  const created = Date.parse(raw?.created_at), updated = Date.parse(raw?.updated_at);
  if (!Number.isSafeInteger(raw?.id) || raw.id <= 0 || raw.run_attempt !== 1 || raw.status !== 'completed' || !['success', 'failure', 'cancelled', 'timed_out'].includes(raw.conclusion) || raw.head_branch !== 'main' || !EVENTS.includes(raw.event) || !['.github/workflows/checks.yml', '.github/workflows/checks.yml@main', '.github/workflows/checks.yml@refs/heads/main', `.github/workflows/checks.yml@${raw.head_sha}`].includes(raw.path) || raw.repository?.full_name !== REPOSITORY || !SHA.test(raw.head_sha) || !Number.isFinite(created) || !Number.isFinite(updated) || updated < created) throw new Error('updates_source_invalid');
  return { id: String(raw.id), head_sha: raw.head_sha, created, updated, conclusion: raw.conclusion };
}

function previousPublication(body, source, now) {
  try {
    const context = parsePublication(body, now, true);
    const generated = Date.parse(body.site_generated_at);
    const feed = { schema_version: 1, source: 'youtube', ...parseFeed(body.feed, generated) };
    const archive_present = Object.hasOwn(body, 'archive');
    return { run_id: source.id, head_sha: source.head_sha, site_generated_at: body.site_generated_at, history_status: context.publication?.history_status || 'current', ...(context.publication?.capacity_reason ? { capacity_reason: context.publication.capacity_reason } : {}), feed, archive_present, ...(archive_present ? { archive: parseArchiveManifest(body.archive, now, true) } : {}) };
  } catch { throw new Error('updates_source_invalid'); }
}

export function restoredFiles(result) {
  const { previous_publication, ...history } = result;
  const updates = JSON.stringify(history) + '\n', publication = JSON.stringify({ run_id: result.run_id, previous_publication }) + '\n';
  if (Buffer.byteLength(updates) > MAX_HISTORY_BYTES || Buffer.byteLength(publication) > MAX_HANDOFF_BYTES) throw new Error('updates_size');
  return { updates, publication };
}

async function fetchJson(url, headers, limit, timeoutMs, fetcher) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 429 ? 'updates_rate_limit' : 'updates_http');
    const chunks = []; let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > limit) { controller.abort(); throw new Error('updates_size'); }
      chunks.push(Buffer.from(part));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('updates_source_invalid'); }
  } catch (error) {
    if (['updates_rate_limit', 'updates_http', 'updates_size', 'updates_source_invalid'].includes(error.message)) throw error;
    throw new Error(controller.signal.aborted ? 'updates_timeout' : 'updates_network');
  } finally { clearTimeout(timer); }
}

export async function restoreUpdates(context, { token, event = null, fetcher = fetch, now = Date.now(), clock = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!context || context.ref !== 'refs/heads/main' || context.attempt !== 1 || !EVENTS.includes(context.event)) throw new Error('updates_context');
  if (!token?.trim()) throw new Error('updates_authentication');
  const deadline = clock() + 28000;
  const get = (url, headers, size) => {
    const remaining = deadline - clock();
    if (remaining <= 0) throw new Error('updates_timeout');
    return fetchJson(url, headers, size, Math.min(6000, remaining), fetcher);
  };
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'parenting-calendar', 'Cache-Control': 'no-cache', Authorization: `Bearer ${token}` };
  const runs = await get(`${RUNS_URL}/workflows/checks.yml/runs?branch=main&status=success&exclude_pull_requests=true&per_page=10`, headers, 256 * 1024);
  if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.length > 10) throw new Error('updates_source_invalid');
  const successful = [];
  for (const raw of runs.workflow_runs) {
    if (raw?.event === 'pull_request' || raw?.run_attempt !== 1) continue;
    const info = runInfo(raw);
    if (info.id !== context.run_id && info.conclusion === 'success') successful.push(info);
  }
  const source = successful.sort((a, b) => b.updated - a.updated)[0];
  if (!source) throw new Error('updates_source_invalid');
  let previous = null, previousBody = null, previousContext = null, previousIdentity = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await get(`${PAGE_FEED_URL}?calendar_run=${context.run_id}&try=${attempt + 1}`, { 'Cache-Control': 'no-cache' }, MAX_PUBLICATION_BYTES);
    if (!body || typeof body !== 'object' || !body.feed || typeof body.site_generated_at !== 'string') throw new Error('updates_source_invalid');
    let current;
    try { current = parsePublication(body, now, true); } catch (error) { if (error.message === 'updates_invalid') throw error; throw new Error('updates_source_invalid'); }
    const legacy = body.updates === undefined, candidate = current.updates;
    if (legacy) {
      const generated = Date.parse(body.feed.generated_at);
      if (!Number.isFinite(generated) || generated > now + CLOCK_SKEW) throw new Error('updates_source_invalid');
      try { parseFeed(body.feed, generated); } catch { throw new Error('updates_source_invalid'); }
    }
    const identity = JSON.stringify({ ...current, feed: body.feed });
    if (previous && (!candidate || identity !== previousIdentity)) throw new Error('updates_stale');
    if (candidate) { previous = candidate; previousBody = body; previousContext = current; previousIdentity = identity; }
    if (current.publication?.release_run_id === source.id) {
      const built = Date.parse(body.site_generated_at);
      if (built < source.created - 5000 || built > source.updated + 5000) throw new Error('updates_stale');
      return { run_id: context.run_id, updates: previous, previous_publication: previousPublication(body, source, now) };
    }
    if (attempt === 0) {
      if (deadline - clock() < 2000) throw new Error('updates_timeout');
      await wait(2000);
    }
  }
  if (!previous) {
    if (!bootstrapAllowed(context, event, source)) throw new Error('updates_bootstrap');
    return { run_id: context.run_id, bootstrap: { before: event.before, after: event.after, ref: event.ref, source_sha: source.head_sha } };
  }
  const publicationId = previousContext.publication.release_run_id;
  const raw = await get(`${RUNS_URL}/runs/${publicationId}/attempts/1`, headers, 256 * 1024);
  const published = runInfo(raw), built = Date.parse(previousBody.site_generated_at);
  if (published.id !== publicationId || published.updated <= source.updated || built < published.created - 5000 || built > published.updated + 5000) throw new Error('updates_stale');
  return { run_id: context.run_id, updates: previous, previous_publication: previousPublication(previousBody, published, now) };
}

export async function buildHistory(context) {
  let raw;
  try {
    if ((await stat('data/updates.json')).size > MAX_HISTORY_BYTES) throw new Error('updates_size');
    raw = JSON.parse(await readFile('data/updates.json', 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && !context) return null;
    throw new Error('updates_restore_required');
  }
  if (context) {
    if (raw.run_id !== context.run_id) throw new Error('updates_restore_required');
    if (raw.bootstrap) {
      const event = await pushEvent(context, process.env);
      if (!bootstrapAllowed(context, event, { head_sha: raw.bootstrap.source_sha }) || raw.bootstrap.before !== event.before || raw.bootstrap.after !== event.after || raw.bootstrap.ref !== event.ref) throw new Error('updates_bootstrap');
      return null;
    }
    return parseUpdates(raw.updates, Date.now(), true);
  }
  return parseUpdates(raw.updates || raw);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const context = publicationContext();
    if (!context) throw new Error('updates_context');
    const result = await restoreUpdates(context, { token: process.env.GITHUB_TOKEN, event: await pushEvent(context, process.env) });
    const files = restoredFiles(result);
    await mkdir('data', { recursive: true });
    await writeFile('data/updates.json', files.updates);
    await writeFile('data/previous-publication.json', files.publication);
    console.log(JSON.stringify({ updates: result.bootstrap ? 'initial_baseline_authorized' : 'restored', seen: result.updates?.seen_ids.length || 0 }));
  } catch (error) {
    const allowed = ['updates_context', 'updates_authentication', 'updates_source_invalid', 'updates_rate_limit', 'updates_http', 'updates_size', 'updates_timeout', 'updates_network', 'updates_bootstrap', 'updates_stale', 'updates_invalid'];
    console.error(`Update history restore failed: ${allowed.includes(error.message) ? error.message : 'updates_invalid'}. Use a new Run workflow on main, not Re-run jobs; never reset an existing history.`);
    process.exitCode = 1;
  }
}

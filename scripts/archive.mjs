import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArchive, parseArchiveManifest, readArchiveResponse } from '../archive.mjs';
import { parseFeed, parseUpdates, filterItems, curateItems } from '../feed.mjs';
import { publicationContext, PAGE_FEED_URL } from './updates.mjs';

export const ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA = 'e156ca527d84b55fcc1b87bc0d4f968f22a747b9';
export const ARCHIVE_BOOTSTRAP_SOURCE_SHA = 'e156ca527d84b55fcc1b87bc0d4f968f22a747b9';
export const PAGE_ARCHIVE_URL = new URL('archive.json', PAGE_FEED_URL).href;
const SOURCE_LIMIT = 17 * 1024 * 1024;
function contextValid(context) {
  return context?.ref === 'refs/heads/main' && context.attempt === 1 && ['push', 'schedule', 'workflow_dispatch'].includes(context.event) && /^[1-9]\d{0,15}$/.test(context.run_id) && /^[a-f0-9]{40}$/.test(context.sha);
}
export function archiveBootstrapAllowed(context, event, source, parent = ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA, baseline = ARCHIVE_BOOTSTRAP_SOURCE_SHA) {
  return !!parent && !!baseline && contextValid(context) && context.event === 'push' && event?.ref === context.ref && event.before === parent && event.after === context.sha && source.head_sha === baseline;
}
async function pushEvent(context) {
  if (!ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA || context.event !== 'push') return null;
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('archive_context');
  const raw = await readJson(process.env.GITHUB_EVENT_PATH, 1024 * 1024);
  return { before: raw.before, after: raw.after, ref: raw.ref };
}
async function readJson(path, limit) {
  if ((await stat(path)).size > limit) throw new Error('archive_size');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)));
}
export function recommendationEntries(feed, snapshot_at) {
  const curated = curateItems(feed.items, Date.parse(feed.generated_at)), recommended = new Set(curated.recommended.map(item => item.id));
  return filterItems(feed.items, 'all', '').map(item => ({ snapshot_at, collected_at: feed.generated_at, mode: feed.mode, selection: recommended.has(item.id) ? 'recommended' : 'pending', item }));
}
export async function restoreArchive(context, publication, history, { event = null, fetcher = fetch, now = Date.now() } = {}) {
  if (!contextValid(context)) throw new Error('archive_context');
  const updates = parseUpdates(history, now, true);
  if (!publication || publication.run_id !== updates.release_run_id || publication.site_generated_at !== updates.last_built_at || !/^[a-f0-9]{40}$/.test(publication.head_sha) || typeof publication.archive_present !== 'boolean') throw new Error('archive_source');
  if (!publication.archive_present) {
    if (Object.hasOwn(publication, 'archive') || !archiveBootstrapAllowed(context, event, publication)) throw new Error('archive_bootstrap');
    const feed = { schema_version: 1, source: 'youtube', ...parseFeed(publication.feed, Date.parse(publication.site_generated_at)) };
    return { run_id: context.run_id, previous: null, seed: { feed, snapshot_at: publication.site_generated_at }, bootstrap: { before: event.before, after: event.after, ref: event.ref, source_sha: publication.head_sha } };
  }
  const manifest = parseArchiveManifest(publication.archive, now, true);
  if (manifest.release_run_id !== updates.release_run_id || manifest.updated_at !== publication.site_generated_at) throw new Error('archive_mismatch');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000), started = Date.now();
  try {
    const response = await fetcher(`${PAGE_ARCHIVE_URL}?archive_run=${context.run_id}`, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: controller.signal });
    const previous = await readArchiveResponse(response, manifest, now, true);
    if (Date.now() - started >= 20000) throw new Error('archive_timeout');
    const seen = new Set(updates.seen_ids);
    if (previous.records.some(row => !seen.has(row.item.id))) throw new Error('archive_seen_mismatch');
    return { run_id: context.run_id, previous, seed: null };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('archive_timeout');
    if (/^archive_(?:http|size|digest|invalid|mismatch|timeout|seen_mismatch)$/.test(error.message)) throw error;
    throw new Error('archive_network');
  } finally { clearTimeout(timer); }
}
export async function buildArchiveSource(context) {
  let raw;
  try { raw = await readJson('data/archive-source.json', SOURCE_LIMIT); }
  catch (error) { if (!context && error.code === 'ENOENT') return { previous: null, seed: null }; throw new Error('archive_restore_required'); }
  if (!raw || raw.run_id !== (context?.run_id || 'preview')) throw new Error('archive_restore_required');
  if (raw.previous !== null) return { previous: parseArchive(raw.previous, Date.now(), !!context), seed: null };
  if (context) {
    const event = await pushEvent(context), proof = raw.bootstrap;
    if (!proof || !archiveBootstrapAllowed(context, event, { head_sha: proof.source_sha }) || proof.before !== event.before || proof.after !== event.after || proof.ref !== event.ref || !raw.seed) throw new Error('archive_bootstrap');
  }
  if (!raw.seed) return { previous: null, seed: null };
  const seed = { snapshot_at: raw.seed.snapshot_at, feed: { schema_version: 1, source: 'youtube', ...parseFeed(raw.seed.feed, Date.parse(raw.seed.snapshot_at)) } };
  return { previous: null, seed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const context = publicationContext(); if (!context) throw new Error('archive_context');
    const envelope = await readJson('data/previous-publication.json', 2 * 1024 * 1024);
    const history = await readJson('data/updates.json', 1024 * 1024);
    if (envelope.run_id !== context.run_id || history.run_id !== context.run_id) throw new Error('archive_source');
    const source = await restoreArchive(context, envelope.previous_publication, history.updates, { event: await pushEvent(context) });
    const body = JSON.stringify(source) + '\n'; if (Buffer.byteLength(body) > SOURCE_LIMIT) throw new Error('archive_size');
    await writeFile('data/archive-source.json', body);
    console.log(JSON.stringify({ archive: source.previous ? 'restored' : 'initialization_authorized', records: source.previous?.records.length || 0 }));
  } catch (error) {
    const kind = /^archive_(?:context|source|bootstrap|http|size|digest|invalid|mismatch|timeout|network|seen_mismatch)$/.test(error.message) ? error.message : 'archive_source';
    console.error(`Archive restore failed: ${kind}. Existing publication is retained; never initialize over an existing archive.`);
    process.exitCode = 1;
  }
}

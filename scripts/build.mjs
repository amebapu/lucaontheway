import { mkdir, readdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { parseFeed, filterItems, advanceUpdates } from '../feed.mjs';
import { validateChannels } from '../rss.mjs';
import { publicationContext, buildHistory } from './updates.mjs';
import { advanceArchive, encodeArchive } from '../archive.mjs';
import { buildArchiveSource, recommendationEntries } from './archive.mjs';
import { MAX_PUBLICATION_BYTES } from '../capacity.mjs';

const state = JSON.parse(await readFile('data/feed.json', 'utf8'));
const feed = { schema_version: 1, source: 'youtube', ...parseFeed(state.feed) };
const channels = feed.mode === 'discovery' && !feed.items.length && Array.isArray(state.channels) && !state.channels.length ? [] : validateChannels(state.channels, feed.mode === 'discovery' ? 20 : 10).map(({ id, name, topics }) => ({ id, name, topics }));
if (feed.discovery?.total_queries === 12 && filterItems(feed.items, 'all', '').length < (feed.discovery.strategy === 'classic_first' ? 1 : 16)) throw new Error(feed.discovery.strategy === 'classic_first' ? '本批没有可见内容，保留上次网站。' : '本批可见内容不足16条，保留上次网站。');
if (feed.items.some(item => !channels.some(channel => channel.id === item.channel_id))) throw new Error('视频作者不在本批来源中');
if (feed.collection) {
  const ids = [...feed.collection.succeeded, ...feed.collection.failed];
  if (ids.length !== channels.length || channels.some(channel => !ids.includes(channel.id))) throw new Error('来源配置与更新状态不一致');
}

const context = publicationContext(), previous = await buildHistory(context), siteTime = new Date().toISOString();
const source = await buildArchiveSource(context);
if (source.previous && previous && (source.previous.release_run_id !== previous.release_run_id || source.previous.updated_at !== previous.last_built_at)) throw new Error('archive_mismatch');
if (source.previous) {
  const seen = new Set(previous?.seen_ids || []);
  if (source.previous.records.some(row => !seen.has(row.item.id))) throw new Error('archive_seen_mismatch');
}
const entries = [...(source.seed ? recommendationEntries(source.seed.feed, source.seed.snapshot_at) : []), ...recommendationEntries(feed, siteTime)];
const previousUpdatesBody = previous ? JSON.stringify(previous) + '\n' : null;
let updates, archive, encoded, published;
const publication = { version: 1, release_run_id: context?.run_id || 'preview', release_run_attempt: 1, history_status: 'current' };
const publish = () => {
  const body = JSON.stringify({ feed, channels, site_generated_at: siteTime, updates, archive: encoded.manifest, publication }) + '\n';
  if (Buffer.byteLength(body) > MAX_PUBLICATION_BYTES) throw new Error('publication_capacity');
  return body;
};
try {
  updates = advanceUpdates(previous, feed.items, siteTime, context?.run_id || 'preview');
  archive = advanceArchive(source.previous, entries, siteTime, context?.run_id || 'preview');
  const seen = new Set(updates.seen_ids);
  if (archive.records.some(row => !seen.has(row.item.id))) throw new Error('archive_seen_mismatch');
  encoded = await encodeArchive(archive);
  published = publish();
} catch (error) {
  if (!['updates_capacity', 'archive_capacity', 'publication_capacity'].includes(error.message) || !previous || !source.previous || !source.manifest) throw error;
  updates = previous; archive = source.previous; encoded = await encodeArchive(archive);
  if (JSON.stringify(updates) + '\n' !== previousUpdatesBody || JSON.stringify(encoded.manifest) !== JSON.stringify(source.manifest)) throw new Error('archive_mismatch');
  publication.history_status = 'capacity_paused'; publication.capacity_reason = error.message;
  published = publish();
}

await mkdir('dist', { recursive: true });
for (const name of await readdir('dist')) await rm(`dist/${name}`, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs', 'archive.mjs', 'capacity.mjs']) await copyFile(name, `dist/${name}`);
await writeFile('dist/feed.json', published);
await writeFile('dist/archive.json', encoded.body);
console.log(`Built 8 static files; ${archive.records.length} archived recommendations; history ${publication.history_status}. Source configuration and private runtime files excluded.`);

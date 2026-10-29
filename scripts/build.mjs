import { mkdir, readdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { parseFeed, filterItems, advanceUpdates } from '../feed.mjs';
import { validateChannels } from '../rss.mjs';
import { publicationContext, buildHistory } from './updates.mjs';

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
const updates = advanceUpdates(previous, feed.items, siteTime, context?.run_id || 'preview');
const published = JSON.stringify({ feed, channels, site_generated_at: siteTime, updates }) + '\n';
if (Buffer.byteLength(published) > 1024 * 1024) throw new Error('Update history capacity reached; migration is required.');

await mkdir('dist', { recursive: true });
for (const name of await readdir('dist')) await rm(`dist/${name}`, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs']) await copyFile(name, `dist/${name}`);
await writeFile('dist/feed.json', published);
console.log('Built 5 static files; source configuration and private runtime files excluded.');

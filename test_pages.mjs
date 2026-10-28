import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectToFile, fetchRss } from './scripts/collect.mjs';
import { FeedError } from './rss.mjs';

const channel = { id: `UC${'A'.repeat(22)}`, name: 'Synthetic source', topics: ['language'] };
function snapshot(offset = 0) {
  const generated = new Date(Date.now() + offset).toISOString();
  return { schema_version: 1, source: 'youtube', mode: 'channels', generated_at: generated, items: [{ id: 'SYNTHETIC01', channel_id: channel.id, channel: channel.name, title: 'Synthetic toddler language play', description: 'Own fixture only', topics: ['language'], fetched_at: generated, published_at: generated }] };
}
async function temporaryProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'parenting-pages-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function buildFixture(t, state) {
  const root = await temporaryProject(t);
  for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs']) await copyFile(new URL(name, import.meta.url), join(root, name));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/feed.json'), JSON.stringify(state));
  return root;
}
function build(root) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' });
}

test('RSS failure diagnostics expose only HTTP status or a fixed network error type', async t => {
  const originalFetch = globalThis.fetch, originalInfo = console.info, messages = [];
  t.after(() => { globalThis.fetch = originalFetch; console.info = originalInfo; });
  console.info = message => messages.push(message);
  globalThis.fetch = async () => new Response('SYNTHETIC_PRIVATE_MARKER', { status: 403, headers: { Location: 'SYNTHETIC_PRIVATE_MARKER' } });
  assert.equal((await fetchRss('https://www.youtube.com/feeds/videos.xml', { headers: { Authorization: 'SYNTHETIC_PRIVATE_MARKER' } })).status, 403);
  for (const code of ['ECONNRESET', 'SYNTHETIC_PRIVATE_MARKER']) {
    const failure = new TypeError('SYNTHETIC_PRIVATE_MARKER', { cause: { code } });
    globalThis.fetch = async () => { throw failure; };
    await assert.rejects(fetchRss('https://www.youtube.com/feeds/videos.xml'), error => error === failure);
  }
  assert.deepEqual(messages.map(message => JSON.parse(message)), [{ source: 'youtube_rss', http_status: 403 }, { source: 'youtube_rss', network_error: 'ECONNRESET' }, { source: 'youtube_rss', network_error: 'OTHER' }]);
  assert.equal(messages.join('').includes('SYNTHETIC_PRIVATE_MARKER'), false);
});

test('collector publishes a validated snapshot and only public channel fields', async t => {
  const root = await temporaryProject(t), destination = join(root, 'data/feed.json');
  const feed = snapshot(); feed.items[0].private_note = 'SYNTHETIC_PRIVATE_MARKER';
  const state = await collectToFile(destination, [{ ...channel, private_note: 'SYNTHETIC_PRIVATE_MARKER' }], async () => feed);
  const text = await readFile(destination, 'utf8');
  assert.equal(text.includes('SYNTHETIC_PRIVATE_MARKER'), false);
  assert.equal(state.feed.generated_at, feed.generated_at);
  assert.equal(JSON.parse(text).feed.items[0].id, 'SYNTHETIC01');
  assert.deepEqual(await readdir(join(root, 'data')), ['feed.json']);
});
test('failed collection leaves the prior file and success time unchanged', async t => {
  const root = await temporaryProject(t), destination = join(root, 'feed.json');
  await collectToFile(destination, [channel], async () => snapshot(-86400000));
  const previous = await readFile(destination, 'utf8');
  await assert.rejects(collectToFile(destination, [channel], async () => { throw new FeedError('upstream_unavailable'); }), /upstream_unavailable/);
  assert.equal(await readFile(destination, 'utf8'), previous);
  assert.deepEqual(await readdir(root), ['feed.json']);
});
test('a valid empty collection publishes zero candidates', async t => {
  const root = await temporaryProject(t), destination = join(root, 'feed.json');
  const feed = snapshot(); feed.items = [];
  const state = await collectToFile(destination, [channel], async () => feed);
  assert.deepEqual(state.feed.items, []);
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).channels[0].id, channel.id);
});
test('the actual build emits only static files and removes unrelated runtime fields', async t => {
  const feed = snapshot(); feed.items[0].private_note = 'SYNTHETIC_PRIVATE_MARKER';
  feed.items[0].published_at = new Date(Date.parse(feed.generated_at) - 86400000).toISOString();
  feed.collection = { succeeded: [channel.id], failed: [], private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  feed.enrichment = { status: 'ready', private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  feed.items[0].analysis = { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: new Date(Date.parse(feed.generated_at) - 3600000).toISOString(), title_zh: '一起玩拼图', summary: '简介介绍拼图互动，具体月龄未说明。', takeaways: ['先看原片。'], topics: ['fine_motor'], relevance: 'unclear', private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  const root = await buildFixture(t, { feed, channels: [{ ...channel, private_note: 'SYNTHETIC_PRIVATE_MARKER' }], site_generated_at: '2000-01-01T00:00:00.000Z', private_notes: 'SYNTHETIC_PRIVATE_MARKER' });
  await writeFile(join(root, '.env'), 'SYNTHETIC_PRIVATE_MARKER');
  await writeFile(join(root, 'config.json'), 'SYNTHETIC_PRIVATE_MARKER');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/private.json'), 'SYNTHETIC_PRIVATE_MARKER');
  const before = Date.now(), result = build(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
  assert.equal((await readFile(join(root, 'dist/feed.json'), 'utf8')).includes('SYNTHETIC_PRIVATE_MARKER'), false);
  const published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  assert.equal(published.feed.items[0].analysis.title_zh, '一起玩拼图');
  assert.ok(Date.parse(published.site_generated_at) >= before && Date.parse(published.site_generated_at) <= Date.now());
  assert.equal(published.feed.generated_at, feed.generated_at);
  assert.equal(published.feed.items[0].published_at, feed.items[0].published_at);
  assert.equal(published.feed.items[0].analysis.generated_at, feed.items[0].analysis.generated_at);
  const html = await readFile(join(root, 'dist/index.html'), 'utf8');
  for (const [, link] of html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)) {
    if (/^https?:/.test(link)) continue;
    assert.ok(new URL(link, 'https://example.github.io/lucaontheway/').pathname.startsWith('/lucaontheway/'), link);
  }
});
test('the build rejects expired data before changing an existing output', async t => {
  const root = await buildFixture(t, { feed: snapshot(-29 * 86400000), channels: [channel] });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
  assert.notEqual(build(root).status, 0);
  assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE');
});
test('the actual build keeps timestamped play notes while excluding transcript text and backend caches', async t => {
  const feed = snapshot(), note = { text: '陪孩子来回滚球。', start: 6 };
  feed.items[0].caption_status = 'available';
  feed.items[0].captions = 'SYNTHETIC_RAW_TRANSCRIPT';
  feed.items[0].analysis = {
    model: 'deepseek/deepseek-flash', basis: 'captions', generated_at: feed.generated_at,
    title_zh: '一起滚球', summary: '字幕介绍滚球互动。', takeaways: [], topics: ['everyday'], relevance: 'unclear',
    caption: { language: 'en', coverage: 'excerpt', fetched_at: feed.generated_at, ranges: [{ start: 5, end: 10 }], cues: 'SYNTHETIC_RAW_TRANSCRIPT' },
    play: { age: null, materials: [], steps: [{ ...note, quote: 'SYNTHETIC_RAW_TRANSCRIPT' }], cautions: [] },
    raw_response: 'SYNTHETIC_RAW_TRANSCRIPT',
  };
  const root = await buildFixture(t, { feed, channels: [channel], transcript: 'SYNTHETIC_RAW_TRANSCRIPT' });
  for (const name of ['captions-cache.json', 'ai-cache.json']) await writeFile(join(root, 'data', name), 'SYNTHETIC_RAW_TRANSCRIPT');
  assert.equal(build(root).status, 0);
  const text = await readFile(join(root, 'dist/feed.json'), 'utf8'), published = JSON.parse(text).feed.items[0];
  assert.deepEqual(published.analysis.play.steps, [note]);
  assert.equal(published.caption_status, 'available');
  assert.equal(text.includes('SYNTHETIC_RAW_TRANSCRIPT'), false);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
});
test('the actual build supports healthy empty discovery but rejects missing authors before clearing output', async t => {
  const feed = { ...snapshot(), mode: 'discovery', items: [], discovery: { total_queries: 4, successful_queries: 4, failed_queries: 0, recent_successful_queries: 2, popular_successful_queries: 2, recent_window_days: 90 } };
  const empty = await buildFixture(t, { feed, channels: [] });
  assert.equal(build(empty).status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(empty, 'dist/feed.json'), 'utf8')).channels, []);
  const mismatch = await buildFixture(t, { feed: { ...snapshot(), mode: 'discovery' }, channels: [{ ...channel, id: `UC${'B'.repeat(22)}` }] });
  await mkdir(join(mismatch, 'dist')); await writeFile(join(mismatch, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
  assert.notEqual(build(mismatch).status, 0); assert.equal(await readFile(join(mismatch, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE');
  const rss = await buildFixture(t, { feed: { ...snapshot(), items: [] }, channels: [] });
  assert.notEqual(build(rss).status, 0);
});
test('preview policy adds only the image host without relaxing scripts or embedding video', async () => {
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com;/);
  assert.match(csp, /script-src 'self';/); assert.match(csp, /connect-src 'self';/); assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(/<iframe|onerror=/.test(html), false);
});
test('an all-low batch does not claim that summaries were never generated or originals are visible', async t => {
  const root = await temporaryProject(t), feed = snapshot();
  feed.items[0].analysis = { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: feed.generated_at, title_zh: '课程介绍', summary: '这条候选是课程介绍，与亲子玩法相关度低。', takeaways: [], topics: ['everyday'], relevance: 'low' };
  const script = `const nodes=new Map();\nconst element=()=>({textContent:'',value:'',children:[],classList:{toggle(){},remove(){}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},addEventListener(){},setAttribute(){}});\nglobalThis.document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector)},querySelectorAll(){return []},createElement:element,addEventListener(){}};\nglobalThis.setInterval=()=>0;\nglobalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify({ feed, channels: [channel], site_generated_at: feed.generated_at }))});\nawait import(${JSON.stringify(new URL('app.mjs', import.meta.url).href)});\nconsole.log(JSON.stringify({status:nodes.get('#analysis-detail').textContent,count:nodes.get('#feed-count').textContent,cards:nodes.get('#cards').children.length}));`;
  await writeFile(join(root, 'render.mjs'), script);
  const result = spawnSync(process.execPath, [join(root, 'render.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(String(shown.count), '0'); assert.equal(shown.cards, 0);
  assert.match(shown.status, /已隐藏 1 条AI低相关/); assert.doesNotMatch(shown.status, /尚未生成|当前显示原文/);
});

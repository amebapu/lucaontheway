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
  for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs', 'archive.mjs', 'capacity.mjs']) await copyFile(new URL(name, import.meta.url), join(root, name));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/feed.json'), JSON.stringify(state));
  return root;
}
function build(root) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
}

test('a later batch retains earlier visible recommendations in the public archive', async t => {
  const first = snapshot(), root = await buildFixture(t, { feed: first, channels: [channel] });
  assert.equal(build(root).status, 0);
  const archive = JSON.parse(await readFile(join(root, 'dist/archive.json'), 'utf8'));
  const published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  await writeFile(join(root, 'data/updates.json'), JSON.stringify({ updates: published.updates }));
  await writeFile(join(root, 'data/archive-source.json'), JSON.stringify({ run_id: 'preview', previous: archive, manifest: published.archive, seed: null }));
  const next = snapshot(); next.items[0].id = 'SYNTHETIC02';
  await writeFile(join(root, 'data/feed.json'), JSON.stringify({ feed: next, channels: [channel] }));
  assert.equal(build(root).status, 0);
  const retained = JSON.parse(await readFile(join(root, 'dist/archive.json'), 'utf8'));
  assert.deepEqual(retained.records.map(row => row.item.id).sort(), ['SYNTHETIC01', 'SYNTHETIC02']);
  assert.deepEqual(retained.records.find(row => row.item.id === 'SYNTHETIC01'), archive.records[0]);
});

test('homepage leads with a seven-day calendar and keeps operational details below both views', async () => {
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const calendar = html.indexOf('id="update-calendar"'), details = html.indexOf('id="update-details"');
  assert.ok(calendar >= 0 && calendar < html.indexOf('id="feed-view"'));
  assert.ok(details > html.indexOf('id="sources-view"') && details < html.indexOf('<footer>'));
  const opening = html.slice(html.lastIndexOf('<details', details), html.indexOf('>', details));
  assert.doesNotMatch(opening, /\bopen\b/);
  const body = html.slice(details, html.indexOf('</details>', details));
  for (const id of ['status-text', 'status-detail', 'site-updated-at', 'batch-detail', 'analysis-detail']) assert.ok(body.includes(`id="${id}"`), id);
});

test('the actual build initializes existing visible IDs as a zero-new baseline', async t => {
  const feed = snapshot();
  feed.items.push({ ...feed.items[0], id: 'SYNTHETIC02', analysis: { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: feed.generated_at, title_zh: '合成低相关', summary: '合成课程介绍。', takeaways: [], topics: ['language'], relevance: 'low' } });
  const root = await buildFixture(t, { feed, channels: [channel] });
  assert.equal(build(root).status, 0);
  const published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  assert.ok(published.updates);
  assert.equal(published.updates.baseline_count, 1);
  assert.deepEqual(published.updates.seen_ids, ['SYNTHETIC01']);
  assert.equal(published.updates.days.length, 1);
  assert.equal(published.updates.days[0].new_count, 0);
  assert.equal(published.updates.last_built_at, published.site_generated_at);
});

test('production without restored history fails before clearing the existing site', async t => {
  const root = await buildFixture(t, { feed: snapshot(), channels: [channel] });
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'amebapu/lucaontheway', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '300', GITHUB_SHA: 'b'.repeat(40) };
  for (const patch of [{}, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', env: { ...env, ...patch } });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE');
  }
});

test('restored daily history survives the actual build while private inputs stay ignored and unpublished', async t => {
  const feed = snapshot(), root = await buildFixture(t, { feed, channels: [channel] });
  const { advanceUpdates } = await import('./feed.mjs');
  const updates = advanceUpdates(null, feed.items, new Date(Date.now() - 1000).toISOString(), '100');
  await writeFile(join(root, 'data/updates.json'), JSON.stringify({ updates: { ...updates, private_note: 'SYNTHETIC_PRIVATE_MARKER' } }));
  await copyFile(new URL('.gitignore', import.meta.url), join(root, '.gitignore'));
  assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['check-ignore', '--', 'data/updates.json'], { cwd: root }).status, 0);
  assert.equal(build(root).status, 0);
  const text = await readFile(join(root, 'dist/feed.json'), 'utf8'), next = JSON.parse(text).updates;
  assert.equal(next.tracked_since, updates.tracked_since); assert.deepEqual(next.seen_ids, updates.seen_ids);
  assert.equal(next.days.at(-1).new_count, 0); assert.equal(text.includes('SYNTHETIC_PRIVATE_MARKER'), false);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'archive.json', 'archive.mjs', 'capacity.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
});

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
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'archive.json', 'archive.mjs', 'capacity.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
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
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'archive.json', 'archive.mjs', 'capacity.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
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


test('discovery builds twenty authors while RSS keeps ten; visible sixteen is checked before clearing output', async t => {
  const authors = Array.from({ length: 20 }, (_, index) => ({ id: `UC${String.fromCharCode(65 + index).repeat(22)}`, name: `Synthetic author ${index}`, topics: ['language'] }));
  const base = snapshot(), discovery = { total_queries: 12, successful_queries: 12, failed_queries: 0, recent_successful_queries: 8, popular_successful_queries: 4, recent_window_days: 90, unique_videos: 100, eligible_videos: 60, selected_videos: 40 };
  const entries = Array.from({ length: 40 }, (_, index) => ({ ...base.items[0], id: `F${String(index).padStart(10, '0')}`, channel_id: authors[index % 20].id, channel: authors[index % 20].name }));
  for (const [selected, low] of [[40, 0], [40, 1], [40, 24], [40, 25], [16, 0], [16, 1]]) {
    const feed = { ...base, mode: 'discovery', discovery: { ...discovery, selected_videos: selected }, items: entries.slice(0, selected).map((value, index) => ({ ...value, ...(index < low ? { analysis: { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: base.generated_at, title_zh: '合成课程', summary: '合成的低相关课程，仅供测试。', takeaways: [], topics: ['language'], relevance: 'low' } } : {}) })) };
    const root = await buildFixture(t, { feed, channels: authors });
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
    const result = build(root);
    if (selected - low < 16) { assert.notEqual(result.status, 0); assert.match(result.stderr, /不足16/); assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE'); }
    else { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8')).channels.length, 20); }
  }
  const rss = await buildFixture(t, { feed: { ...base, items: entries }, channels: authors });
  assert.notEqual(build(rss).status, 0);
});

test('homepage counts actual AI-low items and combines recent, topic and Chinese filters', async t => {
  const root = await temporaryProject(t), base = snapshot(), reference = Date.parse(base.generated_at);
  const authors = Array.from({ length: 20 }, (_, index) => ({ ...channel, id: `UC${String.fromCharCode(65 + index).repeat(22)}`, name: `Synthetic author ${index}` }));
  const items = Array.from({ length: 40 }, (_, index) => ({ ...base.items[0], id: `F${String(index).padStart(10, '0')}`, title: 'Play for a 1-year-old', channel_id: authors[index % 20].id, channel: authors[index % 20].name, topics: [index % 2 ? 'language' : 'art'], published_at: new Date(reference - (index < 20 ? 1 : 365) * 86400000).toISOString(), popularity: { view_count: index < 20 ? index : 1000000 + index }, analysis: { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: base.generated_at, title_zh: `合成${index}亲子活动`, summary: '用胶带开展亲子游戏，具体月龄待核对。', takeaways: [], topics: [index % 2 ? 'language' : 'art'], relevance: index % 5 < 3 ? 'low' : 'relevant' } }));
  const feed = { ...base, mode: 'discovery', discovery: { total_queries: 12, successful_queries: 12, failed_queries: 0, recent_successful_queries: 8, popular_successful_queries: 4, recent_window_days: 90, unique_videos: 300, eligible_videos: 100, selected_videos: 40 }, items };
  const script = `const nodes=new Map();
const element=tagName=>({tagName,textContent:'',value:'',children:[],listeners:{},classList:{toggle(){},remove(){}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},addEventListener(name,callback){this.listeners[name]=callback},setAttribute(){}});
const controls=(key,values)=>values.map(value=>Object.assign(element('button'),{dataset:{[key]:value}}));
const periods=controls('period',['all','recent','classic']),topics=controls('topic',['all','art']);
globalThis.document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,element('div'));return nodes.get(selector)},querySelectorAll(selector){return selector==='[data-period]'?periods:selector==='[data-topic]'?topics:[]},createElement:element,addEventListener(){}};
globalThis.setInterval=()=>0;
globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify({ feed, channels: authors, site_generated_at: feed.generated_at }))});
await import(${JSON.stringify(new URL('app.mjs', import.meta.url).href)});
const current=()=>({count:nodes.get('#cards').children.length,total:nodes.get('#feed-count').textContent,batch:nodes.get('#batch-detail').textContent,result:nodes.get('#result-count').textContent});
const states=[current()];
const firstTitle=nodes.get('#cards').children[0].children.find(value=>value.className==='card-body').children.find(value=>value.tagName==='h3').textContent;
periods[1].listeners.click();states.push(current());
topics[1].listeners.click();states.push(current());
nodes.get('#search').value='不存在的词';nodes.get('#search').listeners.input();states.push(current());
nodes.get('#search').value='胶带';nodes.get('#search').listeners.input();states.push(current());
periods[2].listeners.click();states.push(current());
topics[0].listeners.click();periods[0].listeners.click();states.push(current());
console.log(JSON.stringify({states,firstTitle}));`;
  await writeFile(join(root, 'render.mjs'), script);
  const result = spawnSync(process.execPath, [join(root, 'render.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.states.map(value => value.count), [8, 0, 0, 0, 0, 4, 8]);
  assert.ok(observed.states.every(value => String(value.total) === '8'));
  assert.match(observed.states[0].batch, /检索去重 300 → 规则通过 100 → 本批入选 40/);
  assert.match(observed.states[0].batch, /隐藏 24 条.*精选 8 条.*往期 8.*待看 8 条/);
  assert.equal(observed.firstTitle, '合成39亲子活动');
});


test('classic-first build does not pad a small visible batch and preserves output when all are low', async t => {
  const base = snapshot();
  for (const low of [15, 16]) {
    const feed = { ...base, mode: 'discovery', discovery: { strategy: 'classic_first', total_queries: 12, successful_queries: 12, failed_queries: 0, recent_successful_queries: 4, popular_successful_queries: 8, recent_window_days: 90, unique_videos: 16, eligible_videos: 16, selected_videos: 16 }, items: Array.from({ length: 16 }, (_, index) => ({ ...base.items[0], id: `F${String(index).padStart(10, '0')}`, ...(index < low ? { analysis: { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: base.generated_at, title_zh: '合成课程', summary: '合成低相关，仅供验证。', takeaways: [], topics: ['language'], relevance: 'low' } } : {}) })) };
    const root = await buildFixture(t, { feed, channels: [channel] });
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
    const result = build(root);
    if (low === 16) { assert.notEqual(result.status, 0); assert.match(result.stderr, /没有可见内容/); assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE'); }
    else { assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8')).feed.items.length, 16); }
  }
});

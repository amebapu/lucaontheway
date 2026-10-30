import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ARCHIVE_TOPICS, ARCHIVE_LIMIT, advanceArchive, parseArchive, encodeArchive, readArchiveResponse, filterArchive, sha256 } from './archive.mjs';
import { TOPICS, CONTENT_MODEL, parseFeed, advanceUpdates } from './feed.mjs';
import { BOOTSTRAP_PARENT_SHA, bootstrapAllowed, restoredFiles } from './scripts/updates.mjs';
import { ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA, ARCHIVE_BOOTSTRAP_SOURCE_SHA, PAGE_ARCHIVE_URL, archiveBootstrapAllowed, restoreArchive, recommendationEntries } from './scripts/archive.mjs';

const NOW = Date.now(), at = offset => new Date(NOW + offset).toISOString(), OLD = -45 * 86400000;
const channel = { id: `UC${'A'.repeat(22)}`, name: 'Synthetic author', topics: ['everyday'] };
const item = (index = 0, time = at(OLD)) => ({ id: `A${String(index).padStart(10, '0')}`, title: 'Synthetic toddler play', description: 'Synthetic description', channel: channel.name, channel_id: channel.id, topics: ['everyday'], published_at: time, fetched_at: time });
const summary = time => ({ model: CONTENT_MODEL, basis: 'captions', generated_at: time, title_zh: '纸杯滚球', summary: '合成字幕里的纸杯滚球互动。', takeaways: ['陪孩子一起玩。'], topics: ['everyday'], relevance: 'relevant', caption: { language: 'en', coverage: 'excerpt', fetched_at: time, ranges: [{ start: 5, end: 10 }] }, play: { age: null, materials: [{ text: '纸杯', start: 5 }], steps: [{ text: '一起滚球', start: 6 }], cautions: [] } });
const feed = (time = at(OLD), items = [item(0, time)]) => ({ schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: time, items });
const initial = () => advanceArchive(null, recommendationEntries(feed(at(OLD), [{ ...item(), analysis: summary(at(OLD)) }]), at(OLD)), at(OLD), '100');
const reply = body => new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const ctx = { run_id: '300', sha: 'b'.repeat(40), event: 'push', ref: 'refs/heads/main', attempt: 1 };
const event = { ref: ctx.ref, before: ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA, after: ctx.sha };
const history = () => advanceUpdates(null, [item()], at(OLD), '100');
const publication = archive => ({ run_id: '100', head_sha: ARCHIVE_BOOTSTRAP_SOURCE_SHA || 'a'.repeat(40), site_generated_at: at(OLD), feed: feed(), archive_present: !!archive, ...(archive ? { archive } : {}) });
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'parenting-archive-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('45-day snapshots retain summaries and caption points while the current feed still expires', () => {
  const value = parseArchive(initial(), NOW, true);
  assert.equal(value.records[0].item.analysis.play.steps[0].start, 6);
  assert.throws(() => parseFeed(feed()), /28/);
  assert.equal(value.records[0].snapshot_at, at(OLD));
});

test('repeats only advance last appearance; first metadata, summary, category and dates never change', () => {
  const old = initial(), changed = { ...item(0, at(0)), title: 'Changed title', analysis: { ...summary(at(0)), title_zh: '后来的概要' } };
  const next = advanceArchive(old, recommendationEntries(feed(at(0), [changed, item(1, at(0))]), at(0)), at(0), '101');
  assert.equal(next.records.length, 2);
  const repeat = next.records.find(row => row.item.id === item().id);
  assert.deepEqual({ ...repeat, last_recommended_at: old.records[0].last_recommended_at }, old.records[0]);
  assert.equal(repeat.last_recommended_at, at(0));
  assert.deepEqual(advanceArchive(next, [], at(1000), '102').records, next.records);
});

test('unanalysed first snapshots remain explicit originals and AI-low entries never enter the archive', () => {
  const first = advanceArchive(null, recommendationEntries(feed(), at(OLD)), at(OLD), '100');
  const low = { ...item(1, at(0)), analysis: { ...summary(at(0)), relevance: 'low' } };
  const next = advanceArchive(first, recommendationEntries(feed(at(0), [{ ...item(0, at(0)), analysis: summary(at(0)) }, low]), at(0)), at(0), '101');
  assert.equal(next.records.length, 1); assert.equal(next.records[0].selection, 'pending'); assert.equal(next.records[0].item.analysis, undefined);
});

test('initial seed keeps the original snapshot but uses the enablement day for first archive', () => {
  const old = feed(), current = feed(at(0), [item(0, at(0)), item(1, at(0))]);
  const value = advanceArchive(null, [...recommendationEntries(old, at(OLD)), ...recommendationEntries(current, at(0))], at(0), '100');
  assert.equal(value.records[0].first_archived_at, at(0)); assert.equal(value.records[0].snapshot_at, at(OLD)); assert.equal(value.records[0].last_recommended_at, at(0));
  const seedOnly = advanceArchive(null, recommendationEntries(old, at(OLD)), at(0), '100');
  assert.ok(seedOnly.records[0].last_recommended_at < seedOnly.records[0].first_archived_at);
});

test('description truncation counts Unicode points and exactly 400 is not marked truncated', () => {
  for (const [length, truncated] of [[399, false], [400, false], [401, true]]) {
    const value = advanceArchive(null, recommendationEntries(feed(at(0), [{ ...item(0, at(0)), description: '🌱'.repeat(length) }]), at(0)), at(0));
    assert.equal(value.records[0].description_truncated, truncated); assert.equal(Array.from(value.records[0].item.description).length, Math.min(length, 400));
  }
});

test('invalid dates, duplicates, low or malformed summaries and invalid public optionals fail without losing summaries', () => {
  const old = initial(), row = old.records[0];
  for (const patch of [{ first_archived_at: at(OLD - 1) }, { snapshot_at: at(0) }, { last_recommended_at: at(0) }, { collected_at: at(OLD + 600000) }, { description_truncated: true }, { item: { ...row.item, id: 'bad' } }, { item: { ...row.item, duration_seconds: -1 } }, { item: { ...row.item, analysis: null } }, { item: { ...row.item, analysis: { ...row.item.analysis, relevance: 'low' } } }, { item: { ...row.item, popularity: { view_count: -1 } } }]) assert.throws(() => parseArchive({ ...old, records: [{ ...row, ...patch }] }, NOW));
  assert.throws(() => parseArchive({ ...old, records: [row, row] }, NOW));
  assert.throws(() => parseArchive({ ...old, updated_at: at(600000) }, NOW));
  const clean = parseArchive({ ...old, private_note: 'SYNTHETIC_PRIVATE_MARKER', records: [{ ...row, private_note: 'SYNTHETIC_PRIVATE_MARKER', item: { ...row.item, captions: 'SYNTHETIC_RAW_TRANSCRIPT' } }] });
  assert.equal(JSON.stringify(clean).includes('SYNTHETIC_'), false);
});

test('the v1 validator is independent of changed live model, topics and expiry constants', async t => {
  assert.ok(Object.keys(TOPICS).every(key => Object.hasOwn(ARCHIVE_TOPICS, key)), 'A current topic change requires an archive schema migration.');
  const root = await temporary(t);
  await copyFile(new URL('archive.mjs', import.meta.url), join(root, 'archive.mjs'));
  const current = (await readFile(new URL('feed.mjs', import.meta.url), 'utf8')).replace("CONTENT_MODEL = 'deepseek/deepseek-flash'", "CONTENT_MODEL = 'changed/model'").replace("language: '语言互动'", "new_topic: '新主题'").replace('MAX_AGE = 28 * 86400000', 'MAX_AGE = 1');
  await writeFile(join(root, 'feed.mjs'), current);
  const frozen = await import(pathToFileURL(join(root, 'archive.mjs'))), changed = await import(pathToFileURL(join(root, 'feed.mjs')));
  assert.equal(changed.CONTENT_MODEL, 'changed/model'); assert.equal(changed.TOPICS.language, undefined); assert.equal(changed.MAX_AGE, 1);
  assert.equal(frozen.parseArchive(initial(), NOW).records[0].item.analysis.title_zh, '纸杯滚球');
});

test('Beijing inclusive first-archive dates combine with stable topics, Chinese summaries and play text', () => {
  const rows = initial().records, day = new Date(NOW + OLD + 8 * 3600000).toISOString().slice(0, 10);
  for (const query of ['纸杯', '滚球', '亲子游戏', 'Synthetic author']) assert.equal(filterArchive(rows, { from: day, to: day, topic: 'everyday', query }).length, 1);
  assert.equal(filterArchive(rows, { topic: 'art' }).length, 0);
  assert.equal(filterArchive(rows, { from: '2099-01-01' }).length, 0);
  assert.throws(() => filterArchive(rows, { from: '2026-02-31' })); assert.throws(() => filterArchive(rows, { from: '2026-04-01', to: '2026-03-01' }));
});

test('exact bytes bind count, run, dates and hash; corruption never becomes an empty archive', async () => {
  const value = initial(), encoded = await encodeArchive(value);
  assert.deepEqual(await readArchiveResponse(reply(encoded.body), encoded.manifest, NOW, true), value);
  for (const patch of [{ sha256: '0'.repeat(64) }, { item_count: 0 }, { release_run_id: '101' }, { updated_at: at(0) }, { byte_length: encoded.manifest.byte_length + 1 }]) await assert.rejects(readArchiveResponse(reply(encoded.body), { ...encoded.manifest, ...patch }, NOW, true));
  for (const response of [new Response(encoded.body), new Response(null, { status: 307 }), reply(encoded.body + ' ')]) await assert.rejects(readArchiveResponse(response, encoded.manifest, NOW, true));
  const bytes = new Uint8Array([0xff]);
  await assert.rejects(readArchiveResponse(reply(bytes), { ...encoded.manifest, byte_length: 1, sha256: await sha256(bytes) }, NOW, true), /archive_invalid/);
});

test('stream size guards cancel oversized bodies; serialization refuses over-capacity without eviction', async () => {
  const encoded = await encodeArchive(initial()); let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(ARCHIVE_LIMIT + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readArchiveResponse(reply(stream), encoded.manifest), /archive_size/); assert.equal(cancelled, true);
  const row = initial().records[0];
  const count = Math.ceil(ARCHIVE_LIMIT / Buffer.byteLength(JSON.stringify(row))) + 1;
  await assert.rejects(encodeArchive({ ...initial(), records: Array.from({ length: count }, () => row) }), /archive_capacity/);
  assert.throws(() => parseArchive({ ...initial(), records: Array(50001).fill(row) }));
});

test('production restore fetches only the fixed public archive, with no credentials or redirects', async () => {
  const value = initial(), encoded = await encodeArchive(value); let calls = 0;
  const result = await restoreArchive(ctx, publication(encoded.manifest), history(), { now: NOW, fetcher: async (url, options) => {
    calls++; assert.equal(url, `${PAGE_ARCHIVE_URL}?archive_run=300`); assert.equal(options.redirect, 'error'); assert.deepEqual(options.headers, { 'Cache-Control': 'no-cache' }); return reply(encoded.body);
  } });
  assert.equal(calls, 1); assert.deepEqual(result.previous, value); assert.equal(result.seed, null);
});

test('malformed manifests, unknown run, lost seen IDs and failed network cannot initialize or fall back', async () => {
  const encoded = await encodeArchive(initial()), noRequest = () => assert.fail('No archive request expected');
  for (const p of [{ ...publication(), archive_present: true, archive: null }, { ...publication(), archive_present: undefined }, { ...publication(), run_id: '101' }]) await assert.rejects(restoreArchive(ctx, p, history(), { now: NOW, event, fetcher: noRequest }));
  for (const context of [{ ...ctx, event: 'pull_request' }, { ...ctx, ref: 'refs/heads/feature' }, { ...ctx, attempt: 2 }]) await assert.rejects(restoreArchive(context, publication(), history(), { event, fetcher: noRequest }), /archive_context/);
  await assert.rejects(restoreArchive(ctx, publication(encoded.manifest), history(), { now: NOW, fetcher: async () => { throw new Error('SYNTHETIC_PRIVATE_MARKER'); } }), error => error.message === 'archive_network');
  const empty = advanceUpdates(null, [], at(OLD), '100');
  await assert.rejects(restoreArchive(ctx, publication(encoded.manifest), empty, { now: NOW, fetcher: async () => reply(encoded.body) }), /archive_seen_mismatch/);
});

test('the restore timer aborts a stalled request and exposes only a fixed timeout kind', async t => {
  const timer = globalThis.setTimeout;
  t.after(() => { globalThis.setTimeout = timer; });
  globalThis.setTimeout = (callback, ms, ...args) => timer(callback, ms === 20000 ? 5 : ms, ...args);
  const encoded = await encodeArchive(initial());
  await assert.rejects(restoreArchive(ctx, publication(encoded.manifest), history(), { now: NOW, fetcher: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SYNTHETIC_PRIVATE_MARKER')), { once: true })) }), error => error.message === 'archive_timeout');
});

test('archive initialization has independent precise source/parent bindings; calendar bootstrap stays closed', async () => {
  const parent = 'a'.repeat(40), baseline = 'c'.repeat(40), proof = { ref: ctx.ref, before: parent, after: ctx.sha };
  assert.equal(BOOTSTRAP_PARENT_SHA, ''); assert.equal(bootstrapAllowed(ctx, proof, { head_sha: baseline }), false);
  assert.equal(archiveBootstrapAllowed(ctx, proof, { head_sha: baseline }, parent, baseline), true);
  assert.equal(archiveBootstrapAllowed(ctx, proof, { head_sha: baseline }, '', ''), false);
  assert.equal(archiveBootstrapAllowed(ctx, { ...proof, before: baseline }, { head_sha: baseline }, parent, baseline), false);
  for (const context of [{ ...ctx, event: 'schedule' }, { ...ctx, event: 'workflow_dispatch' }, { ...ctx, attempt: 2 }]) assert.equal(archiveBootstrapAllowed(context, proof, { head_sha: baseline }, parent, baseline), false);
  const promise = restoreArchive(ctx, publication(), history(), { now: NOW, event, fetcher: () => assert.fail('Initialization must not fetch an absent archive') });
  if (ARCHIVE_BOOTSTRAP_PUSH_PARENT_SHA && ARCHIVE_BOOTSTRAP_SOURCE_SHA) { const source = await promise; assert.equal(source.previous, null); assert.equal(source.seed.feed.items.length, 1); }
  else await assert.rejects(promise, /archive_bootstrap/);
});

test('separate publication handoff cannot inflate the calendar history file near its size limit', () => {
  const updates = advanceUpdates(null, Array.from({ length: 45000 }, (_, i) => item(i)), at(0), '100');
  const { updates: calendar, publication: seed } = restoredFiles({ run_id: ctx.run_id, updates, previous_publication: { ...publication(), padding: 'x'.repeat(900000) } });
  assert.ok(Buffer.byteLength(calendar) < 1024 * 1024); assert.ok(Buffer.byteLength(seed) < 2 * 1024 * 1024);
  assert.equal(JSON.parse(calendar).previous_publication, undefined); assert.equal(JSON.parse(seed).run_id, ctx.run_id);
  assert.throws(() => restoredFiles({ run_id: ctx.run_id, updates, previous_publication: { padding: 'x'.repeat(2 * 1024 * 1024) } }), /updates_size/);
});

test('invalid production archive sources stop actual builds before clearing output', async t => {
  const root = await temporary(t), current = feed(at(0), [item(1, at(0))]);
  await mkdir(join(root, 'data')); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'SYNTHETIC_PREVIOUS_SITE');
  for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs', 'archive.mjs']) await copyFile(new URL(name, import.meta.url), join(root, name));
  await writeFile(join(root, 'data/feed.json'), JSON.stringify({ feed: current, channels: [channel] }));
  const updates = history(); await writeFile(join(root, 'data/updates.json'), JSON.stringify({ run_id: ctx.run_id, updates }));
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'amebapu/lucaontheway', GITHUB_REF: ctx.ref, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: ctx.run_id, GITHUB_SHA: ctx.sha };
  for (const source of [null, { run_id: '299', previous: initial(), seed: null }, { run_id: ctx.run_id, previous: { ...initial(), records: [...initial().records, ...initial().records] }, seed: null }, { run_id: ctx.run_id, previous: null, seed: null }]) {
    if (source) await writeFile(join(root, 'data/archive-source.json'), JSON.stringify(source));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'SYNTHETIC_PREVIOUS_SITE');
  }
  await writeFile(join(root, 'data/archive-source.json'), JSON.stringify({ run_id: ctx.run_id, previous: initial(), seed: null }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(join(root, 'dist/archive.json'))); assert.deepEqual(saved.records[0], initial().records[0]); assert.equal(saved.records.length, 2);
});

test('history restore is mandatory before collection and the public source files stay ignored', async () => {
  const workflow = await readFile(new URL('.github/workflows/checks.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('npm run updates') < workflow.indexOf('npm run archive') && workflow.indexOf('npm run archive') < workflow.indexOf('npm run collect'));
  const stage = workflow.slice(workflow.indexOf('- name: Restore recommendation archive'), workflow.indexOf('- run: npm run collect'));
  assert.match(stage, /if: github.event_name != 'pull_request'/); assert.doesNotMatch(stage, /continue-on-error|GITHUB_TOKEN|secrets/);
  assert.match(await readFile(new URL('.gitignore', import.meta.url), 'utf8'), /^data\/$/m);
  const server = await readFile(new URL('scripts/serve.mjs', import.meta.url), 'utf8'); assert.match(server, /'archive.mjs'/); assert.match(server, /'archive.json'/);
});

test('the actual browser module lazily loads history despite an expired feed and combines filters with pagination', async t => {
  const root = await temporary(t), oldFeed = feed(at(OLD), Array.from({ length: 13 }, (_, index) => ({ ...item(index), analysis: { ...summary(at(OLD)), title_zh: `纸杯${index}` } })));
  const value = advanceArchive(null, recommendationEntries(oldFeed, at(OLD)), at(OLD), '100'), encoded = await encodeArchive(value);
  const state = { feed: oldFeed, channels: [channel], site_generated_at: at(OLD), updates: advanceUpdates(null, oldFeed.items, at(OLD), '100'), archive: encoded.manifest };
  const script = `const nodes=new Map(), calls=[];
const element=tagName=>({tagName,textContent:'',value:'',children:[],listeners:{},classList:{toggle(){},remove(){}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},addEventListener(name,callback){this.listeners[name]=callback},setAttribute(){},removeAttribute(){}});
const views=['feed','sources','archive'].map(view=>Object.assign(element('button'),{dataset:{view}}));
const node=selector=>{if(!nodes.has(selector))nodes.set(selector,element('div'));return nodes.get(selector)};
globalThis.document={querySelector:node,querySelectorAll:selector=>selector==='[data-view]'?views:[],createElement:element,addEventListener(){}};
globalThis.setInterval=()=>0;
globalThis.fetch=async url=>{calls.push(url);return new Response(url.startsWith('./archive.json')?${JSON.stringify(encoded.body)}:${JSON.stringify(JSON.stringify(state))},{headers:{'Content-Type':'application/json'}})};
await import(${JSON.stringify(new URL('app.mjs', import.meta.url).href)});
const before=calls.length;
views[2].listeners.click();
for(let i=0;i<100&&!node('#archive-cards').children.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
const counts=[node('#archive-cards').children.length];
node('#archive-next').listeners.click();counts.push(node('#archive-cards').children.length);
node('#archive-search').value='纸杯12';node('#archive-search').listeners.input();counts.push(node('#archive-cards').children.length);
node('#archive-topic').value='art';node('#archive-topic').listeners.change();counts.push(node('#archive-cards').children.length);
node('#archive-topic').value='everyday';node('#archive-topic').listeners.change();counts.push(node('#archive-cards').children.length);
node('#archive-from').value='2099-01-01';node('#archive-from').listeners.change();counts.push(node('#archive-cards').children.length);
await node('#refresh').listeners.click();
console.log(JSON.stringify({before,calls,counts,current:node('#cards').children.length,hidden:node('#archive-view').hidden,heroHidden:node('.hero').hidden,from:node('#archive-from').value,final:node('#archive-status').textContent}));`;
  await writeFile(join(root, 'render.mjs'), script);
  const result = spawnSync(process.execPath, [join(root, 'render.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.before, 1); assert.equal(shown.calls.filter(url => url.startsWith('./archive.json')).length, 1);
  assert.deepEqual(shown.counts, [12, 1, 1, 0, 1, 0]); assert.equal(shown.current, 0); assert.equal(shown.hidden, false); assert.equal(shown.heroHidden, true);
  assert.equal(shown.from, '2099-01-01'); assert.match(shown.final, /没有匹配/);
});

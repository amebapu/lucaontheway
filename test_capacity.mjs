import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { advanceArchive, encodeArchive, parseArchive, sha256 } from './archive.mjs';
import { parsePublication, calendarWeek, beijingDay } from './feed.mjs';
import { restoreUpdates, restoredFiles, REPOSITORY, RUNS_URL } from './scripts/updates.mjs';
import { restoreArchive } from './scripts/archive.mjs';
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_SOURCE_BYTES, MAX_HISTORY_IDS, MAX_HISTORY_BYTES, MAX_HANDOFF_BYTES, MAX_PUBLICATION_BYTES } from './capacity.mjs';

const id = i => `C${String(i).padStart(10, '0')}`;
const channel = { id: `UC${'A'.repeat(22)}`, name: 'Synthetic source', topics: ['everyday'] };
function sample(at) { return { id: id(0), channel_id: channel.id, channel: channel.name, title: '玩法'.repeat(150), description: '材料'.repeat(200), topics: ['everyday'], published_at: at, fetched_at: at }; }
function entry(item, at) { return { item, snapshot_at: at, collected_at: at, mode: 'discovery', selection: 'pending' }; }
function history(archive) { return { version: 1, tracked_since: archive.started_at, last_built_at: archive.updated_at, baseline_count: archive.records.length, seen_ids: archive.records.map(row => row.item.id), days: [{ date: beijingDay(archive.updated_at), new_count: 0 }], release_run_id: archive.release_run_id, release_run_attempt: 1 }; }
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'parenting-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs', 'archive.mjs', 'capacity.mjs']) await copyFile(new URL(name, import.meta.url), join(root, name));
  await mkdir(join(root, 'data')); return root;
}
function build(root, run = '300') {
  return spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: run, GITHUB_SHA: 'b'.repeat(40) } });
}
async function inputs(root, archive, manifest, updates, run = '300', nextId = 'Z0000000000') {
  const at = new Date().toISOString(), item = { ...sample(at), id: nextId };
  await writeFile(join(root, 'data/feed.json'), JSON.stringify({ feed: { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: at, items: [item] }, channels: [channel] }));
  await writeFile(join(root, 'data/updates.json'), JSON.stringify({ run_id: run, updates }));
  await writeFile(join(root, 'data/archive-source.json'), JSON.stringify({ run_id: run, previous: archive, manifest, seed: null }));
}

test('a full unique-ID history pauses archiving while publishing the new valid recommendations', async t => {
  const root = await project(t);
  const before = new Date(Date.now() - 10000).toISOString(), at = new Date().toISOString();
  const channel = { id: `UC${'A'.repeat(22)}`, name: 'Synthetic source', topics: ['everyday'] };
  const item = { id: 'C0000000000', channel_id: channel.id, channel: channel.name, title: 'Play', description: 'Synthetic', topics: ['everyday'], published_at: before, fetched_at: before };
  const archive = advanceArchive(null, [{ item, snapshot_at: before, collected_at: before, mode: 'discovery', selection: 'pending' }], before);
  const encoded = await encodeArchive(archive);
  const updates = { version: 1, tracked_since: before, last_built_at: before, baseline_count: MAX_HISTORY_IDS, seen_ids: Array.from({ length: MAX_HISTORY_IDS }, (_, i) => `C${String(i).padStart(10, '0')}`), days: [{ date: new Date(Date.parse(before) + 8 * 3600000).toISOString().slice(0, 10), new_count: 0 }], release_run_id: 'preview', release_run_attempt: 1 };
  const feed = { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: at, items: [{ ...item, id: 'Z0000000000', fetched_at: at }] };
  await writeFile(join(root, 'data/feed.json'), JSON.stringify({ feed, channels: [channel] }));
  await writeFile(join(root, 'data/updates.json'), JSON.stringify({ updates }));
  await writeFile(join(root, 'data/archive-source.json'), JSON.stringify({ run_id: 'preview', previous: archive, manifest: encoded.manifest, seed: null }));
  const built = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', import.meta.url))], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.equal(built.status, 0, built.stderr);
  const published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  assert.equal(published.feed.items[0].id, 'Z0000000000');
  assert.equal(published.publication.history_status, 'capacity_paused');
  assert.equal(published.publication.capacity_reason, 'updates_capacity');
  assert.deepEqual(published.updates, updates);
  assert.deepEqual(published.archive, encoded.manifest);
  assert.equal(await readFile(join(root, 'dist/archive.json'), 'utf8'), encoded.body);
});

test('near the real byte cap, a new publication preserves exact old bytes and survives the next production restore', async t => {
  const root = await project(t), at = new Date(Date.now() - 10000).toISOString();
  const base = advanceArchive(null, [entry(sample(at), at)], at, '100'), row = base.records[0];
  const unit = Buffer.byteLength(JSON.stringify(row)) + 1;
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, records: [] })) + 1;
  const count = Math.floor((MAX_ARCHIVE_BYTES - overhead) / unit);
  const old = { ...base, records: Array.from({ length: count }, (_, i) => ({ ...row, item: { ...row.item, id: id(i) } })) };
  const encoded = await encodeArchive(old), updates = history(old), updatesHash = await sha256(new TextEncoder().encode(JSON.stringify(updates) + '\n'));
  assert.ok(encoded.manifest.byte_length <= MAX_ARCHIVE_BYTES && MAX_ARCHIVE_BYTES - encoded.manifest.byte_length < unit);
  assert.ok(Buffer.byteLength(JSON.stringify({ run_id: '300', previous: old, manifest: encoded.manifest, seed: null }) + '\n') <= MAX_ARCHIVE_SOURCE_BYTES);
  await inputs(root, old, encoded.manifest, updates);
  const result = build(root); assert.equal(result.status, 0, result.stderr);
  let published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  assert.equal(published.publication.history_status, 'capacity_paused'); assert.equal(published.publication.capacity_reason, 'archive_capacity');
  assert.equal(published.publication.release_run_id, '300'); assert.equal(published.updates.release_run_id, '100');
  assert.equal(await readFile(join(root, 'dist/archive.json'), 'utf8'), encoded.body);
  assert.equal(await sha256(new TextEncoder().encode(JSON.stringify(published.updates) + '\n')), updatesHash);
  const context = { run_id: '400', sha: 'b'.repeat(40), event: 'push', ref: 'refs/heads/main', attempt: 1 }, calls = [];
  const now = Date.now() + 5000;
  const restored = await restoreUpdates(context, { token: 'SYNTHETIC_TOKEN', now, wait: async () => {}, fetcher: async (url, options) => {
    calls.push(url);
    if (url.startsWith(RUNS_URL)) return Response.json({ workflow_runs: [{ id: 300, run_attempt: 1, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', path: '.github/workflows/checks.yml', repository: { full_name: REPOSITORY }, head_sha: 'a'.repeat(40), created_at: at, updated_at: new Date(now).toISOString() }] });
    assert.equal(options.headers.Authorization, undefined); return Response.json(published);
  } });
  assert.equal(calls.length, 2); assert.equal(restored.previous_publication.run_id, '300'); assert.equal(restored.previous_publication.history_status, 'capacity_paused');
  const source = await restoreArchive(context, restored.previous_publication, restored.updates, { now, fetcher: async () => new Response(encoded.body, { headers: { 'Content-Type': 'application/json' } }) });
  assert.deepEqual(source.manifest, encoded.manifest);
  const files = restoredFiles(restored);
  assert.ok(Buffer.byteLength(files.updates) <= MAX_HISTORY_BYTES && Buffer.byteLength(files.publication) <= MAX_HANDOFF_BYTES);
  await inputs(root, source.previous, source.manifest, restored.updates, '400', 'Z0000000001');
  const again = build(root, '400'); assert.equal(again.status, 0, again.stderr);
  published = JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8'));
  assert.equal(published.publication.release_run_id, '400'); assert.equal(published.publication.history_status, 'capacity_paused');
  assert.equal(published.feed.items[0].id, 'Z0000000001'); assert.deepEqual(published.updates, updates);
  assert.equal(await readFile(join(root, 'dist/archive.json'), 'utf8'), encoded.body);
  const previousPage = await readFile(join(root, 'dist/feed.json'), 'utf8');
  await writeFile(join(root, 'data/archive-source.json'), JSON.stringify({ ...source, manifest: { ...source.manifest, sha256: '0'.repeat(64) } }));
  assert.notEqual(build(root, '400').status, 0);
  assert.equal(await readFile(join(root, 'dist/feed.json'), 'utf8'), previousPage);
});

test('paused calendar preserves the last recorded date across days, with unknown current totals and an unchanged same-day subtotal', async () => {
  const now = Date.now(), at = new Date(now - 86400000).toISOString();
  const archive = advanceArchive(null, [entry(sample(at), at)], at, '100'), encoded = await encodeArchive(archive);
  const updates = history(archive); updates.baseline_count = 0; updates.days[0].new_count = 1;
  const marker = { version: 1, release_run_id: '200', release_run_attempt: 1, history_status: 'capacity_paused', capacity_reason: 'archive_capacity' };
  const state = { site_generated_at: new Date(now).toISOString(), updates, archive: encoded.manifest, publication: marker };
  const parsed = parsePublication(state, now, true), days = calendarWeek(parsed.updates, now, parsed);
  assert.equal(days.find(day => day.date === beijingDay(at)).count, 1); assert.equal(days.at(-1).count, null); assert.equal(days.at(-1).status, 'capacity_unknown');
  const same = parsePublication({ ...state, site_generated_at: at }, now, true), sameDays = calendarWeek(same.updates, Date.parse(at), same);
  assert.equal(sameDays.at(-1).count, null); assert.equal(sameDays.at(-1).recorded_count, 1);
  for (const patch of [{ publication: { ...marker, capacity_reason: undefined } }, { archive: undefined }, { archive: { ...encoded.manifest, release_run_id: '200' } }, { site_generated_at: new Date(Date.parse(at) - 1).toISOString() }, { publication: { ...marker, history_status: 'current' } }]) assert.throws(() => parsePublication({ ...state, ...patch }, now, true));
  assert.equal(parsePublication({ site_generated_at: at, updates, archive: encoded.manifest }, now, true).legacy, true);
});

test('public and restored size guards use the same shared capacities, not the old one-MiB history ceiling', async () => {
  const at = new Date().toISOString(), archive = advanceArchive(null, [entry(sample(at), at)], at, '100');
  const updates = { ...history(archive), baseline_count: MAX_HISTORY_IDS, seen_ids: Array.from({ length: MAX_HISTORY_IDS }, (_, i) => id(i)) };
  const files = restoredFiles({ run_id: '200', updates, previous_publication: { feed: { text: '中'.repeat(200000) } } });
  assert.ok(Buffer.byteLength(files.updates) > 1024 * 1024 && Buffer.byteLength(files.updates) < MAX_HISTORY_BYTES);
  assert.ok(Buffer.byteLength(files.publication) < MAX_HANDOFF_BYTES);
  assert.equal(MAX_PUBLICATION_BYTES, 8 * 1024 * 1024);
  assert.throws(() => restoredFiles({ run_id: '200', updates, previous_publication: { padding: 'x'.repeat(MAX_HANDOFF_BYTES) } }), /updates_size/);
  const row = archive.records[0];
  const many = { ...archive, records: Array.from({ length: MAX_HISTORY_IDS }, (_, i) => ({ ...row, item: { ...row.item, id: id(i), title: 'Play', description: '' } })) };
  assert.equal(parseArchive(many).records.length, MAX_HISTORY_IDS);
  assert.throws(() => advanceArchive(many, [entry({ ...sample(at), id: 'Z0000000000' }, at)], at), /archive_capacity/);
});

test('paused provenance follows the newer published run, and repeated reads cannot hide changed publication identity', async () => {
  const now = Date.now(), oldTime = new Date(now - 20000).toISOString(), siteTime = new Date(now - 5000).toISOString();
  const archive = advanceArchive(null, [entry(sample(oldTime), oldTime)], oldTime, '100'), encoded = await encodeArchive(archive), updates = history(archive);
  const marker = { version: 1, release_run_id: '200', release_run_attempt: 1, history_status: 'capacity_paused', capacity_reason: 'archive_capacity' };
  const body = { site_generated_at: siteTime, updates, archive: encoded.manifest, publication: marker, feed: { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: siteTime, items: [{ ...sample(siteTime), title: 'Synthetic play' }] } };
  const context = { run_id: '300', sha: 'b'.repeat(40), event: 'push', ref: 'refs/heads/main', attempt: 1 };
  const info = (id, conclusion) => ({ id, run_attempt: 1, status: 'completed', conclusion, head_branch: 'main', event: 'push', path: '.github/workflows/checks.yml', repository: { full_name: REPOSITORY }, head_sha: 'a'.repeat(40), created_at: new Date(now - 30000).toISOString(), updated_at: new Date(now - (id === 150 ? 10000 : 1000)).toISOString() });
  const calls = [];
  const result = await restoreUpdates(context, { token: 'SYNTHETIC_TOKEN', now, wait: async () => {}, fetcher: async (url, options) => {
    calls.push(url);
    if (url.includes('/workflows/')) return Response.json({ workflow_runs: [info(150, 'success')] });
    if (url.startsWith(RUNS_URL)) { assert.match(url, /\/runs\/200\/attempts\/1$/); return Response.json(info(200, 'failure')); }
    assert.equal(options.headers.Authorization, undefined); return Response.json(body);
  } });
  assert.equal(calls.length, 4); assert.equal(result.previous_publication.run_id, '200'); assert.equal(result.updates.release_run_id, '100');
  for (const patch of [{ publication: { ...marker, release_run_id: '201' } }, { site_generated_at: new Date(now - 4000).toISOString() }, { archive: { ...encoded.manifest, sha256: '0'.repeat(64) } }, { feed: { ...body.feed, items: [{ ...body.feed.items[0], title: 'Changed feed' }] } }]) {
    let pages = 0;
    await assert.rejects(restoreUpdates(context, { token: 'SYNTHETIC_TOKEN', now, wait: async () => {}, fetcher: async url => {
      if (url.includes('/workflows/')) return Response.json({ workflow_runs: [info(150, 'success')] });
      assert.ok(!url.startsWith(RUNS_URL), 'conflicting page reads fail before a run lookup');
      return Response.json(++pages === 1 ? body : { ...body, ...patch });
    } }), /updates_stale/);
  }
});

test('a fully populated valid current feed plus 200k old IDs passes real build and bounded restore', async t => {
  const root = await project(t), at = new Date(Date.now() - 10000).toISOString();
  const archive = advanceArchive(null, [entry(sample(at), at)], at, '100'), encoded = await encodeArchive(archive);
  const updates = { ...history(archive), baseline_count: MAX_HISTORY_IDS, seen_ids: Array.from({ length: MAX_HISTORY_IDS }, (_, i) => id(i)) };
  await inputs(root, archive, encoded.manifest, updates);
  const now = new Date().toISOString(), point = { text: '玩法'.repeat(80), start: 5 };
  const items = Array.from({ length: 40 }, (_, i) => ({ ...sample(now), id: id(i), channel: '作'.repeat(300), description: '中'.repeat(5000), caption_status: 'available', analysis: { model: 'deepseek/deepseek-flash', basis: 'captions', generated_at: now, title_zh: '字'.repeat(100), summary: '概'.repeat(240), takeaways: ['点'.repeat(80), '点'.repeat(80)], topics: ['everyday', 'art', 'sensory'], relevance: 'relevant', caption: { language: 'en', coverage: 'excerpt', fetched_at: now, ranges: [{ start: 0, end: 100 }] }, play: { age: { text: '龄'.repeat(120), start: 5 }, materials: Array(3).fill(point), steps: Array(4).fill(point), cautions: Array(3).fill(point) } } }));
  await writeFile(join(root, 'data/feed.json'), JSON.stringify({ feed: { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: now, items }, channels: [channel] }));
  const result = build(root); assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(join(root, 'dist/feed.json')), published = JSON.parse(bytes);
  assert.equal(published.feed.items.length, 40); assert.equal(published.updates.seen_ids.length, MAX_HISTORY_IDS); assert.equal(published.publication.history_status, 'current');
  assert.ok(bytes.byteLength > 1024 * 1024 && bytes.byteLength < MAX_PUBLICATION_BYTES);
  const context = { run_id: '400', sha: 'b'.repeat(40), event: 'push', ref: 'refs/heads/main', attempt: 1 }, latest = Date.now() + 5000;
  const restored = await restoreUpdates(context, { token: 'SYNTHETIC_TOKEN', now: latest, wait: async () => {}, fetcher: async url => url.startsWith(RUNS_URL) ? Response.json({ workflow_runs: [{ id: 300, run_attempt: 1, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', path: '.github/workflows/checks.yml', repository: { full_name: REPOSITORY }, head_sha: 'a'.repeat(40), created_at: at, updated_at: new Date(latest).toISOString() }] }) : new Response(bytes) });
  const files = restoredFiles(restored);
  assert.ok(Buffer.byteLength(files.updates) <= MAX_HISTORY_BYTES && Buffer.byteLength(files.publication) <= MAX_HANDOFF_BYTES);
  assert.equal(restored.previous_publication.feed.items.length, 40);
});

test('the homepage, calendar and archive work with getReader streams that have no async iterator', async t => {
  const root = await project(t), at = new Date().toISOString(), item = { ...sample(at), analysis: { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: at, title_zh: '亲子玩法', summary: '合成亲子游戏。', takeaways: [], topics: ['everyday'], relevance: 'relevant' } };
  const archive = advanceArchive(null, [entry(item, at)], at), encoded = await encodeArchive(archive);
  const state = { feed: { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: at, items: [item] }, channels: [channel], site_generated_at: at, updates: history(archive), archive: encoded.manifest, publication: { version: 1, release_run_id: 'preview', release_run_attempt: 1, history_status: 'current' } };
  const script = `const nodes=new Map();
const element=tagName=>({tagName,textContent:'',value:'',children:[],listeners:{},classList:{toggle(){},remove(){}},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},addEventListener(name,callback){this.listeners[name]=callback},setAttribute(){},removeAttribute(){}});
const views=['feed','sources','archive'].map(view=>Object.assign(element('button'),{dataset:{view}}));
const node=selector=>{if(!nodes.has(selector))nodes.set(selector,element('div'));return nodes.get(selector)};
globalThis.document={querySelector:node,querySelectorAll:selector=>selector==='[data-view]'?views:[],createElement:element,addEventListener(){}};
globalThis.setInterval=()=>0;
globalThis.fetch=async url=>{const response=new Response(url.startsWith('./archive.json')?${JSON.stringify(encoded.body)}:${JSON.stringify(JSON.stringify(state))},{headers:{'Content-Type':'application/json'}});Object.defineProperty(response.body,Symbol.asyncIterator,{value:undefined});return response;};
await import(${JSON.stringify(new URL('app.mjs', import.meta.url).href)});
const current=node('#cards').children.length, days=node('#calendar-days').children.length;
views[2].listeners.click();
for(let i=0;i<100&&!node('#archive-cards').children.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
console.log(JSON.stringify({current,days,history:node('#archive-cards').children.length,status:node('#status-text').textContent}));`;
  await writeFile(join(root, 'reader-render.mjs'), script);
  const result = spawnSync(process.execPath, [join(root, 'reader-render.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const shown = JSON.parse(result.stdout);
  assert.equal(shown.current, 1, shown.status); assert.equal(shown.days, 7); assert.equal(shown.history, 1);
});

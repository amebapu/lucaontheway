import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectToFile } from './scripts/collect.mjs';
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
  feed.collection = { succeeded: [channel.id], failed: [], private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  feed.enrichment = { status: 'ready', private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  feed.items[0].analysis = { model: 'deepseek/deepseek-flash', basis: 'metadata', generated_at: feed.generated_at, title_zh: '一起玩拼图', summary: '简介介绍拼图互动，具体月龄未说明。', takeaways: ['先看原片。'], topics: ['fine_motor'], relevance: 'unclear', private_note: 'SYNTHETIC_PRIVATE_MARKER' };
  const root = await buildFixture(t, { feed, channels: [{ ...channel, private_note: 'SYNTHETIC_PRIVATE_MARKER' }], private_notes: 'SYNTHETIC_PRIVATE_MARKER' });
  await writeFile(join(root, '.env'), 'SYNTHETIC_PRIVATE_MARKER');
  await writeFile(join(root, 'config.json'), 'SYNTHETIC_PRIVATE_MARKER');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/private.json'), 'SYNTHETIC_PRIVATE_MARKER');
  const result = build(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['app.mjs', 'feed.json', 'feed.mjs', 'index.html', 'styles.css']);
  assert.equal((await readFile(join(root, 'dist/feed.json'), 'utf8')).includes('SYNTHETIC_PRIVATE_MARKER'), false);
  assert.equal(JSON.parse(await readFile(join(root, 'dist/feed.json'), 'utf8')).feed.items[0].analysis.title_zh, '一起玩拼图');
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

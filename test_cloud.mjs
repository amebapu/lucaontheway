import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { parseAtom, collectChannels, validateChannels, readTextLimited, FeedError } from './rss.mjs';
import worker, { handleRequest, refreshFeeds, loadFeedState } from './worker.mjs';
import config from './config.json' with { type: 'json' };
import { screenContent } from './content.mjs';

const channel = { id: `UC${'A'.repeat(22)}`, name: 'Synthetic source', topics: ['language'] };
const NOW = Date.now();
const stamp = offset => new Date(NOW + offset).toISOString();
function entry({ id = 'SYNTHETIC01', cid = channel.id, title = 'Synthetic &amp; play', published = stamp(-86400000) } = {}) {
  return `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${cid}</yt:channelId><title>${title}</title><published>${published}</published><author><name>Synthetic author</name></author><media:group><media:description>Own fixture only</media:description></media:group></entry>`;
}
function atom(entries = entry(), cid = channel.id.slice(2)) {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><yt:channelId>${cid}</yt:channelId>${entries}</feed>`;
}
function snapshot(offset = 0) {
  return { schema_version: 1, source: 'youtube', mode: 'channels', generated_at: stamp(offset), items: [{ id: 'SYNTHETIC01', channel_id: channel.id, channel: 'Synthetic author', title: 'Synthetic title', description: '', topics: ['language'], published_at: stamp(offset - 86400000), fetched_at: stamp(offset) }] };
}
let mf, DB;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(r){return new Response(new Request("https://www.youtube.com/feeds/videos.xml", {redirect:r.headers.get("x-redirect-mode") || "manual"}).redirect)}}', d1Databases: ['DB'], compatibilityDate: '2026-10-27' }));
  DB = await mf.getD1Database('DB');
  const sql = await readFile('schema.sql', 'utf8');
  await DB.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => DB.prepare(s)));
});
beforeEach(async () => { await DB.prepare('DELETE FROM app_state').run(); });
after(async () => { if (mf) await mf.dispose(); });
async function putFeed(feed) { await DB.prepare("INSERT INTO app_state(key,value) VALUES('feed',?)").bind(JSON.stringify(feed)).run(); }
async function storedFeed() { return (await DB.prepare("SELECT value FROM app_state WHERE key='feed'").first())?.value; }

test('Atom namespaces, observed shortened root id, XML entities and offset dates are handled', () => {
  const items = parseAtom(atom(entry({ published: new Date(NOW - 1000).toISOString().replace('Z', '+00:00') })), channel, NOW);
  assert.equal(items[0].title, 'Synthetic & play');
  assert.equal(items[0].channel_id, channel.id);
  assert.equal(items[0].published_at, stamp(-1000));
  assert.equal(parseAtom(atom(entry(), channel.id), channel, NOW).length, 1);
});
test('valid empty Atom succeeds; HTML and malformed XML do not masquerade as empty results', () => {
  assert.deepEqual(parseAtom(atom(''), channel, NOW), []);
  for (const bad of ['<html>not Atom</html>', atom().slice(0, -7), '<feed/>']) assert.throws(() => parseAtom(bad, channel, NOW), /upstream_format/);
});
test('wrong channel, invalid video id, missing fields and future publication fail', () => {
  for (const body of [atom(entry(), 'wrong'), atom(entry({ cid: `UC${'B'.repeat(22)}` })), atom(entry({ id: '../secret' })), atom(entry({ published: 'invalid' })), atom(entry({ published: stamp(600000) })), atom(entry({ title: '' }))]) assert.throws(() => parseAtom(body, channel, NOW), /upstream_format/);
});
test('old entries are filtered and entities, excessive depth and entry count are bounded', () => {
  assert.equal(parseAtom(atom(entry({ published: stamp(-15 * 86400000) })), channel, NOW).length, 0);
  for (const body of ['<!DOCTYPE feed [<!ENTITY x "bad">]>' + atom(), atom('<x>'.repeat(20) + '</x>'.repeat(20)), atom(entry().repeat(16))]) assert.throws(() => parseAtom(body, channel, NOW), /upstream_format/);
});
test('channel configuration rejects duplicates, unsupported topics and too many sources', () => {
  assert.equal(validateChannels([channel]).length, 1);
  for (const bad of [[], [channel, channel], [channel, channel, channel], [{ ...channel, topics: ['constructor'] }], [{ ...channel, id: 'https://other.example.test' }]]) assert.throws(() => validateChannels(bad));
});
test('collection uses fixed HTTPS feeds, no redirects or API key, and deduplicates', async () => {
  const calls = [];
  const feed = await collectChannels([channel], async (url, options) => { calls.push({ url, options }); return new Response(atom(entry() + entry())); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(feed.items.length, 1);
});
test('RSS redirect options are accepted by the actual Workers Request implementation', async () => {
  await collectChannels([channel], async (url, options) => {
    const probe = await mf.dispatchFetch('http://localhost/', { headers: { 'x-redirect-mode': options.redirect } });
    assert.equal(probe.status, 200);
    assert.equal(await probe.text(), 'manual');
    return new Response(atom());
  });
});
test('temporary HTTP failure retries once, permanent failure and long Retry-After do not', async () => {
  let calls = 0;
  await collectChannels([channel], async () => ++calls === 1 ? new Response('private upstream text', { status: 503 }) : new Response(atom()));
  assert.equal(calls, 2);
  for (const status of [302, 404, 429]) {
    calls = 0;
    await assert.rejects(collectChannels([channel], async () => { calls++; return new Response('private upstream text', { status, headers: { 'Retry-After': '3600' } }); }), error => error.message === 'upstream_unavailable');
    assert.equal(calls, 1);
  }
});
test('stream limit counts actual bytes and collection rejects oversized bodies', async () => {
  await assert.rejects(readTextLimited(new Response('x'.repeat(21)).body, 20), /payload_too_large/);
  await assert.rejects(collectChannels([channel], async () => new Response('x'.repeat(256 * 1024 + 1))), /payload_too_large/);
});
test('real local D1 publishes feed and status together', async () => {
  assert.deepEqual(await refreshFeeds({ DB }, { collect: async () => snapshot() }), { status: 'ok' });
  const state = await loadFeedState({ DB });
  assert.equal(state.refresh.status, 'ok');
  assert.equal(state.feed.items[0].id, 'SYNTHETIC01');
  assert.equal(state.feed.generated_at, stamp(0));
});
test('failed collection preserves the previous snapshot and its success timestamp byte for byte', async () => {
  await putFeed(snapshot(-86400000));
  const previous = await storedFeed();
  assert.equal((await refreshFeeds({ DB }, { collect: async () => { throw new FeedError('upstream_format'); } })).status, 'failed');
  assert.equal(await storedFeed(), previous);
  const state = await loadFeedState({ DB });
  assert.equal(state.refresh.error, 'upstream_format');
  assert.equal(state.feed.generated_at, stamp(-86400000));
});
test('one failed channel prevents partial collection from publishing', async () => {
  const other = { ...channel, id: `UC${'B'.repeat(22)}` };
  await putFeed(snapshot()); const previous = await storedFeed();
  const collect = sources => collectChannels(sources, async url => url.includes(other.id) ? new Response('failed', { status: 404 }) : new Response(atom()));
  assert.equal((await refreshFeeds({ DB }, { channels: [channel, other], collect })).status, 'failed');
  assert.equal(await storedFeed(), previous);
});
test('atomic cooldown allows only one concurrent collector', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = refreshFeeds({ DB }, { collect: async () => { calls++; entered(); await gate; return snapshot(); } });
  await started;
  const second = await refreshFeeds({ DB }, { collect: async () => { calls++; return snapshot(); } });
  release();
  assert.equal(second.status, 'cooldown');
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
});
test('old runs cannot overwrite a replaced lease or publish after expiry', async () => {
  for (const replacement of ['newer-run', 'expired']) {
    await DB.prepare('DELETE FROM app_state').run(); await putFeed(snapshot(-1000)); const previous = await storedFeed();
    const result = await refreshFeeds({ DB }, { collect: async () => {
      const row = await DB.prepare("SELECT value FROM app_state WHERE key='refresh'").first();
      const state = JSON.parse(row.value);
      if (replacement === 'newer-run') state.run_id = replacement; else state.lease_until = Date.now() - 1;
      await DB.prepare("UPDATE app_state SET value=? WHERE key='refresh'").bind(JSON.stringify(state)).run();
      return snapshot();
    } });
    assert.equal(result.status, 'superseded'); assert.equal(await storedFeed(), previous);
  }
});
test('expired feed is hidden and pruned even when collection fails', async () => {
  await putFeed(snapshot(-29 * 86400000));
  await refreshFeeds({ DB }, { collect: async () => { throw new FeedError('upstream_unavailable'); } });
  assert.equal(await storedFeed(), undefined);
  assert.equal((await loadFeedState({ DB })).feed, null);
});
test('read filtering still works if expired-data maintenance cannot write', async () => {
  await putFeed(snapshot(-29 * 86400000));
  const failingDB = { prepare(sql) {
    if (sql.startsWith('DELETE')) return { bind() { return { async run() { throw new Error('fixed synthetic error'); } }; } };
    return DB.prepare(sql);
  } };
  assert.equal((await loadFeedState({ DB: failingDB })).feed, null);
  assert.notEqual(await storedFeed(), undefined);
});
test('a terminated run is shown as failed after its lease expires', async () => {
  await DB.prepare("INSERT INTO app_state(key,value) VALUES('refresh',?)").bind(JSON.stringify({ status: 'running', run_id: 'old', attempt_ms: NOW - 360000, lease_until: NOW - 300000 })).run();
  assert.equal((await loadFeedState({ DB })).refresh.error, 'interrupted');
  assert.equal((await refreshFeeds({ DB }, { collect: async () => snapshot() })).status, 'ok');
});
test('public feed excludes unrelated stored keys and has no public mutation endpoint', async () => {
  await putFeed(snapshot());
  await DB.prepare("INSERT INTO app_state(key,value) VALUES('private_notes',?)").bind('SYNTHETIC_PRIVATE_MARKER').run();
  const response = await handleRequest(new Request('https://parenting.example.test/api/feed'), { DB });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text(); assert.equal(body.includes('SYNTHETIC_PRIVATE_MARKER'), false); assert.equal(body.includes('notes'), false);
  for (const [path, method] of [['/api/refresh', 'POST'], ['/api/state', 'GET'], ['/api/notes/SYNTHETIC01', 'PUT']]) assert.equal((await handleRequest(new Request(`https://parenting.example.test${path}`, { method }), { DB })).status, 404);
  assert.equal((await handleRequest(new Request('https://parenting.example.test/api/feed', { method: 'POST' }), { DB })).status, 405);
});
test('content rules cover the requested eight topics without treating titles as age verification', () => {
  for (const [title, topic] of [['Toddler language play','language'],['Walking and balance for toddlers','movement'],['Fine motor puzzles for toddlers','fine_motor'],['Toddler sensory bin','sensory'],['Toddler painting','art'],['Reading books with toddlers','reading'],['Toddler games','everyday'],['Serve and return development','theory']]) {
    assert.ok(screenContent({ title, description: '' }).topics.includes(topic));
  }
  for (const title of ['3 Cozy Ways to Do Tummy Time','Newborn sensory play','Games for 5 year olds','Black Friday toddler toy discount','Family weekend vlog']) assert.equal(screenContent({ title, description: '' }), null);
  for (const title of ['When Do Babies Sit On Their Own?','How to Help Your Baby Sit Up','Baby sitting up sensory play']) assert.equal(screenContent({ title, description: 'Motor skills activities' }), null);
  assert.ok(screenContent({ title: 'Sensory play for 18 months', description: '' }));
});
test('only the static allowlist is served and security headers apply to every response', async () => {
  const env = { DB, ASSETS: { fetch: async () => new Response('synthetic asset', { headers: { 'Content-Type': 'text/html' } }) } };
  for (const path of ['/', '/index.html', '/styles.css', '/app.mjs', '/feed.mjs']) {
    const response = await handleRequest(new Request(`https://parenting.example.test${path}`), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  }
  const head = await handleRequest(new Request('https://parenting.example.test/', { method: 'HEAD' }), env);
  assert.equal(await head.text(), '');
  for (const path of ['/worker.mjs', '/config.json', '/schema.sql', '/.env', '/review/cloud-plan-v4.md']) assert.equal((await handleRequest(new Request(`https://parenting.example.test${path}`), env)).status, 404);
});
test('local scheduled entrypoint collects the configured feeds and persists them', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url); const cid = new URL(url).searchParams.get('channel_id');
    assert.ok(config.channels.some(source => source.id === cid));
    return new Response(atom(entry({ cid, id: cid === config.channels[0].id ? 'SYNTHETIC01' : 'SYNTHETIC02' }), cid.slice(2)));
  });
  await worker.scheduled({}, { DB });
  assert.equal(calls.length, 2); assert.equal((await loadFeedState({ DB })).feed.items.length, 2);
});

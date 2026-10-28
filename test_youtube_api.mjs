import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectApiChannels, parseUploads } from './scripts/youtube-api.mjs';
import { parseAtom } from './rss.mjs';

const NOW = Date.now(), KEY = 'SYNTHETIC_API_SECRET';
const sources = count => Array.from({ length: count }, (_, index) => ({ id: `UC${String.fromCharCode(65 + index).repeat(22)}`, name: 'Synthetic source', topics: ['everyday'] }));
const channel = sources(1)[0], playlist = source => `UU${source.id.slice(2)}`;
const stamp = offset => new Date(NOW + offset).toISOString();
const mapping = channels => ({ kind: 'youtube#channelListResponse', items: channels.map(source => ({ id: source.id, contentDetails: { relatedPlaylists: { uploads: playlist(source) } } })) });
const listing = items => ({ kind: 'youtube#playlistItemListResponse', items });
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...options });
function row(source = channel, index = 0) {
  const id = `${source.id[2]}${String(index).padStart(10, '0')}`;
  return { snippet: { channelId: source.id, videoOwnerChannelId: source.id, playlistId: playlist(source), publishedAt: stamp(-1000), title: 'Toddler play & learn', description: 'Own synthetic fixture only.', resourceId: { kind: 'youtube#video', videoId: id } }, contentDetails: { videoId: id, videoPublishedAt: stamp(-3600000 - index * 1000) }, status: { privacyStatus: 'public' } };
}
function fixture(channels, count = 1) {
  return async url => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://www.googleapis.com');
    if (request.pathname.endsWith('/channels')) return json(mapping(channels));
    assert.equal(request.pathname, '/youtube/v3/playlistItems');
    const source = channels.find(source => playlist(source) === request.searchParams.get('playlistId'));
    assert.ok(source);
    return json(listing(Array.from({ length: count }, (_, index) => row(source, index))));
  };
}
function logs(t) {
  const original = console.info, messages = [];
  console.info = line => messages.push(JSON.parse(line));
  t.after(() => { console.info = original; });
  return messages;
}

test('official collection uses two fixed public endpoints and a header key, preserving video publication time', async () => {
  const calls = [], fetcher = fixture([channel]);
  const feed = await collectApiChannels([channel], KEY, async (url, options) => { calls.push({ url, options }); return fetcher(url); });
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url), second = new URL(calls[1].url);
  assert.equal(first.pathname, '/youtube/v3/channels');
  assert.equal(first.searchParams.get('id'), channel.id);
  assert.equal(first.searchParams.get('part'), 'contentDetails');
  assert.equal(first.searchParams.get('maxResults'), '50');
  assert.equal(second.pathname, '/youtube/v3/playlistItems');
  assert.equal(second.searchParams.get('part'), 'snippet,contentDetails,status');
  assert.equal(second.searchParams.get('maxResults'), '15');
  for (const call of calls) {
    assert.equal(call.options.headers['x-goog-api-key'], KEY);
    assert.equal(call.options.redirect, 'manual');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.url.includes(KEY), false);
    assert.equal(new URL(call.url).searchParams.has('pageToken'), false);
  }
  assert.equal(feed.items[0].published_at, row().contentDetails.videoPublishedAt);
  assert.notEqual(feed.items[0].published_at, row().snippet.publishedAt);
  assert.equal(JSON.stringify(feed).includes(KEY), false);
});

test('API text is truncated without dropping the source and matches decoded RSS text', () => {
  const source = row(); source.snippet.title += 'x'.repeat(400); source.snippet.description += 'x'.repeat(5000);
  const [item] = parseUploads(listing([source]), channel, playlist(channel), NOW);
  assert.equal(item.title.length, 300); assert.equal(item.description.length, 800);
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><yt:channelId>${channel.id}</yt:channelId><entry><yt:videoId>${row().contentDetails.videoId}</yt:videoId><yt:channelId>${channel.id}</yt:channelId><title>Toddler play &amp; learn</title><published>${row().contentDetails.videoPublishedAt}</published><author><name>${channel.name}</name></author><media:group><media:description>Own synthetic fixture only.</media:description></media:group></entry></feed>`;
  assert.deepEqual(parseUploads(listing([row()]), channel, playlist(channel), NOW), parseAtom(xml, channel, NOW));
});

test('privacy is checked before missing metadata and healthy empty sources remain valid', async () => {
  const hidden = [{ status: { privacyStatus: 'private' } }, { status: { privacyStatus: 'unlisted' } }];
  assert.equal(parseUploads(listing([...hidden, row()]), channel, playlist(channel), NOW).length, 1);
  assert.deepEqual(parseUploads(listing(hidden), channel, playlist(channel), NOW), []);
  const feed = await collectApiChannels([channel], KEY, async url => json(new URL(url).pathname.endsWith('/channels') ? mapping([channel]) : listing(hidden)));
  assert.deepEqual(feed.items, []); assert.deepEqual(feed.collection.succeeded, [channel.id]);
  for (const status of [undefined, {}, { privacyStatus: 'unknown' }]) assert.throws(() => parseUploads(listing([{ ...row(), status }]), channel, playlist(channel), NOW), /upstream_format/);
  const empty = await collectApiChannels([channel], KEY, fixture([channel], 0));
  assert.equal(empty.items.length, 0); assert.equal(empty.collection.failed.length, 0);
});

test('only the subscribed public video, playlist and original publication date are accepted', () => {
  const changes = [
    source => { source.snippet.channelId = sources(2)[1].id; },
    source => { source.snippet.videoOwnerChannelId = sources(2)[1].id; },
    source => { source.snippet.playlistId = 'OTHER_PLAYLIST'; },
    source => { source.snippet.resourceId.kind = 'other'; },
    source => { source.snippet.resourceId.videoId = 'INVALID'; },
    source => { source.contentDetails.videoId = 'B0000000000'; },
    source => { source.contentDetails.videoPublishedAt = 'invalid'; },
    source => { source.contentDetails.videoPublishedAt = stamp(300001); },
    source => { source.snippet.title = ''; },
    source => { source.snippet.description = null; },
  ];
  for (const change of changes) { const source = row(); change(source); assert.throws(() => parseUploads(listing([source]), channel, playlist(channel), NOW), /upstream_format/); }
  const old = row(); old.contentDetails.videoPublishedAt = stamp(-14 * 86400000 - 1);
  assert.deepEqual(parseUploads(listing([old]), channel, playlist(channel), NOW), []);
  old.contentDetails.videoPublishedAt = stamp(-14 * 86400000);
  assert.equal(parseUploads(listing([old]), channel, playlist(channel), NOW).length, 1);
  assert.throws(() => parseUploads(listing(Array.from({ length: 16 }, () => row())), channel, playlist(channel), NOW), /upstream_format/);
  for (const raw of [null, { ...listing([]), error: null }, { ...listing([]), kind: 'other' }, { ...listing([]), items: {} }]) assert.throws(() => parseUploads(raw, channel, playlist(channel), NOW), /upstream_format/);
});

test('missing mappings and failed playlists preserve healthy sources; all failures reject', async t => {
  logs(t);
  const channels = sources(3), healthy = fixture(channels);
  const feed = await collectApiChannels(channels, KEY, async url => {
    const request = new URL(url);
    if (request.pathname.endsWith('/channels')) return json(mapping(channels.slice(0, 2)));
    return request.searchParams.get('playlistId') === playlist(channels[1]) ? new Response('not available', { status: 404 }) : healthy(url);
  });
  assert.deepEqual(feed.collection, { succeeded: [channels[0].id], failed: channels.slice(1).map(source => source.id) });
  assert.equal(feed.items.length, 1);
  await assert.rejects(collectApiChannels(channels, KEY, async () => json(mapping([]))), /upstream_unavailable/);
});

test('unknown or repeated channel mappings fail and returned playlist values cannot change the endpoint', async () => {
  const configured = sources(2);
  for (const items of [[...mapping([channel]).items, ...mapping([channel]).items], mapping(sources(3).slice(2)).items]) {
    let calls = 0;
    await assert.rejects(collectApiChannels(configured, KEY, async () => { calls++; return json({ kind: 'youtube#channelListResponse', items }); }), /upstream_format/);
    assert.equal(calls, 1);
  }
  const raw = mapping([channel]); raw.items[0].contentDetails.relatedPlaylists.uploads = 'https://other.example.test/';
  let calls = 0;
  await assert.rejects(collectApiChannels([channel], KEY, async () => { calls++; return json(raw); }), /upstream_unavailable/);
  assert.equal(calls, 1);
});

test('ten API sources share forty slots while a single source keeps fifteen', async () => {
  const channels = sources(10), fetcher = fixture(channels, 15); let calls = 0;
  const feed = await collectApiChannels(channels, KEY, async url => { calls++; return fetcher(url); });
  assert.equal(calls, 11); assert.equal(feed.items.length, 40);
  for (const source of channels) assert.equal(feed.items.filter(item => item.channel_id === source.id).length, 4);
  assert.equal((await collectApiChannels([channel], KEY, fixture([channel], 15))).items.length, 15);
});

test('each API request retries at most once, bounding ten-source collection at twenty-two calls', async t => {
  const messages = logs(t), channels = sources(10), fetcher = fixture(channels), calls = new Map();
  await collectApiChannels(channels, KEY, async url => {
    const count = (calls.get(url) || 0) + 1; calls.set(url, count);
    return count === 1 ? new Response('SYNTHETIC_PRIVATE_MARKER', { status: 503, headers: { 'Retry-After': '0' } }) : fetcher(url);
  });
  assert.equal(calls.size, 11); assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 22);
  assert.ok(messages.every(message => message.source === 'youtube_api' && message.http_status === 503));
});

test('permanent failures, redirects and long Retry-After never replay or expose upstream details', async t => {
  const messages = logs(t);
  for (const [status, retry] of [[302, '0'], [403, '0'], [408, '0'], [429, '3600'], [503, new Date(Date.now() + 3600000).toUTCString()]]) {
    let calls = 0;
    await assert.rejects(collectApiChannels([channel], KEY, async () => { calls++; return new Response(KEY, { status, headers: { 'Retry-After': retry, Location: `https://other.example.test/${KEY}` } }); }), /upstream_unavailable/);
    assert.equal(calls, 1);
  }
  assert.equal(JSON.stringify(messages).includes(KEY), false);
  assert.ok(messages.every(message => Object.keys(message).sort().join(',') === 'http_status,source'));
});

test('bad JSON, content types, envelopes and oversized bodies fail without a retry', async t => {
  logs(t);
  const replies = [
    () => new Response('<html>not data</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }),
    () => json({ ...mapping([channel]), error: { message: KEY } }),
    () => json({ ...mapping([channel]), kind: 'other' }),
    () => new Response('x'.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const reply of replies) {
    let calls = 0;
    await assert.rejects(collectApiChannels([channel], KEY, async () => { calls++; return reply(); }), error => ['upstream_format', 'payload_too_large'].includes(error.code) && !error.message.includes(KEY));
    assert.equal(calls, 1);
  }
});

test('temporary network errors retry but certificate failures do not, with fixed diagnostics only', async t => {
  const messages = logs(t), fetcher = fixture([channel]); let calls = 0;
  await collectApiChannels([channel], KEY, async url => { if (++calls === 1) throw new TypeError(KEY, { cause: { code: 'ECONNRESET' } }); return fetcher(url); });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(collectApiChannels([channel], KEY, async () => { calls++; throw new TypeError(KEY, { cause: { code: 'CERT_HAS_EXPIRED' } }); }), /upstream_unavailable/);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(messages).includes(KEY), false);
  assert.ok(messages.every(message => message.network_error === 'network'));
});

test('HTTP-date Retry-After is respected before a second attempt', async t => {
  logs(t);
  const retryAt = new Date(Date.now() + 1500).toUTCString(), fetcher = fixture([channel]); let calls = 0;
  await collectApiChannels([channel], KEY, async url => {
    if (++calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': retryAt } });
    assert.ok(Date.now() >= Date.parse(retryAt)); return fetcher(url);
  });
  assert.equal(calls, 3);
});

test('a slow mapping retry preserves the separate playlist budget and expired phases stop', async t => {
  logs(t);
  const original = Date.now, start = original(), counts = new Map(); let elapsed = 0;
  Date.now = () => start + elapsed; t.after(() => { Date.now = original; });
  const fetcher = fixture([channel]);
  const feed = await collectApiChannels([channel], KEY, async url => {
    const path = new URL(url).pathname, count = (counts.get(path) || 0) + 1; counts.set(path, count);
    elapsed += path.endsWith('/channels') && count === 2 ? 2000 : 5000;
    return count === 1 ? new Response('', { status: 503, headers: { 'Retry-After': '0' } }) : fetcher(url);
  });
  assert.equal(elapsed, 17000); assert.equal(feed.items.length, 1);
  elapsed = 0; let calls = 0;
  await assert.rejects(collectApiChannels([channel], KEY, async () => { calls++; elapsed = 13001; return json(mapping([channel])); }), /upstream_timeout/);
  assert.equal(calls, 1);
});

test('the request timeout also aborts a stalled response body', { timeout: 10000 }, async t => {
  logs(t);
  const fetcher = fixture([channel]); let stalled = false, aborted = false;
  const feed = await collectApiChannels([channel], KEY, async (url, options) => {
    if (new URL(url).pathname.endsWith('/playlistItems') && !stalled) {
      stalled = true;
      const body = new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('SYNTHETIC_PRIVATE_MARKER', 'AbortError')); }, { once: true }); } });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    return fetcher(url);
  });
  assert.equal(aborted, true); assert.equal(feed.items.length, 1);
});

test('the production CLI selects API only with a key, and failures leave the previous file untouched', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'parenting-youtube-api-')));
  try {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'data'));
    for (const name of ['collect.mjs', 'youtube-api.mjs']) copyFileSync(fileURLToPath(new URL(`scripts/${name}`, import.meta.url)), join(dir, 'scripts', name));
    for (const name of ['rss.mjs', 'feed.mjs', 'content.mjs']) symlinkSync(fileURLToPath(new URL(name, import.meta.url)), join(dir, name));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ channels: [channel] }));
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><yt:channelId>${channel.id}</yt:channelId><entry><yt:videoId>${row().contentDetails.videoId}</yt:videoId><yt:channelId>${channel.id}</yt:channelId><title>Toddler play</title><published>${stamp(-3600000)}</published><author><name>${channel.name}</name></author><media:group><media:description>Own fixture</media:description></media:group></entry></feed>`;
    const hook = `import { writeFileSync } from 'node:fs';\nconst calls=[];\nglobalThis.fetch=async(url,options)=>{const u=new URL(url); const source=u.hostname==='www.googleapis.com'?'youtube_api':'rss'; calls.push({source,keyMatches:options.headers['x-goog-api-key']===${JSON.stringify(KEY)},urlContainsKey:url.includes(${JSON.stringify(KEY)})}); writeFileSync('observed.json',JSON.stringify(calls)); if(process.env.SYNTHETIC_FAILURE)return new Response('SYNTHETIC_PRIVATE_MARKER',{status:403}); if(source==='rss')return new Response(${JSON.stringify(atom)}); if(!['/youtube/v3/channels','/youtube/v3/playlistItems'].includes(u.pathname))throw new Error('unexpected route'); return new Response(JSON.stringify(u.pathname.endsWith('/channels')?${JSON.stringify(mapping([channel]))}:${JSON.stringify(listing([row()]))}),{headers:{'Content-Type':'application/json'}});};\n`;
    writeFileSync(join(dir, 'hook.mjs'), hook);
    const run = env => spawnSync(process.execPath, ['--import', join(dir, 'hook.mjs'), join(dir, 'scripts/collect.mjs')], { cwd: dir, encoding: 'utf8', timeout: 5000, env });
    const api = run({ YOUTUBE_API_KEY: KEY }); assert.equal(api.status, 0, api.stderr);
    const observed = JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8'));
    assert.deepEqual(observed.map(call => call.source), ['youtube_api', 'youtube_api']);
    assert.ok(observed.every(call => call.keyMatches && !call.urlContainsKey));
    assert.equal(readFileSync(join(dir, 'data/feed.json'), 'utf8').includes(KEY), false);
    assert.equal((api.stdout + api.stderr).includes(KEY), false);
    const rss = run({}); assert.equal(rss.status, 0, rss.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8')).map(call => call.source), ['rss']);
    writeFileSync(join(dir, 'data/feed.json'), 'prior-success');
    const failed = run({ YOUTUBE_API_KEY: KEY, SYNTHETIC_FAILURE: '1' });
    assert.equal(failed.status, 1); assert.equal(readFileSync(join(dir, 'data/feed.json'), 'utf8'), 'prior-success');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8')).map(call => call.source), ['youtube_api']);
    assert.equal((failed.stdout + failed.stderr).includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

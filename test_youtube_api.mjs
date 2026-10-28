import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectDiscovery, rotatingQueries, parseVideos } from './scripts/youtube-api.mjs';
import { screenContent } from './content.mjs';
import config from './config.json' with { type: 'json' };

const NOW = Date.now(), KEY = 'SYNTHETIC_API_SECRET', queries = config.queries;
const stamp = offset => new Date(NOW + offset).toISOString();
const id = index => `S${String(index).padStart(10, '0')}`;
const channel = index => `UC${String.fromCharCode(65 + index).repeat(22)}`;
const search = ids => ({ kind: 'youtube#searchListResponse', items: ids.map(videoId => ({ id: { kind: 'youtube#video', videoId } })) });
const videos = items => ({ kind: 'youtube#videoListResponse', items });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
function row(index = 0, author = 0) {
  return { id: id(index), snippet: { channelId: channel(author), channelTitle: 'Own synthetic source', title: 'Play ideas for a 1-year-old', description: 'Own synthetic fixture only.', publishedAt: stamp(-3600000 - index * 1000), liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT2M3S' }, status: { privacyStatus: 'public' }, statistics: { viewCount: String(1000 - index), likeCount: '12' } };
}
const provenance = (ids = [id(0)], popular = true) => new Map(ids.map(value => [value, { topics: new Set(['everyday']), popular }]));
function fixture(rows = [row()]) {
  return async url => {
    const request = new URL(url); assert.equal(request.origin, 'https://www.googleapis.com');
    if (request.pathname.endsWith('/search')) return json(search(rows.slice(0, 10).map(value => value.id)));
    assert.equal(request.pathname, '/youtube/v3/videos'); return json(videos(rows));
  };
}
function logs(t) {
  const original = console.info, messages = [];
  console.info = line => messages.push(JSON.parse(line)); t.after(() => { console.info = original; }); return messages;
}

test('four Beijing days cover eight topics twice with opposite orders and reject invalid configuration', () => {
  const observed = new Map(), start = Date.parse('2026-10-27T16:00:00Z');
  for (let day = 0; day < 4; day++) {
    const selected = rotatingQueries(queries, start + day * 86400000);
    assert.equal(selected.length, 4); assert.equal(selected.filter(query => query.order === 'date').length, 2);
    for (const query of selected) observed.set(query.topic, [...(observed.get(query.topic) || []), query.order]);
  }
  assert.equal(observed.size, 8);
  for (const orders of observed.values()) assert.deepEqual(orders.sort(), ['date', 'viewCount']);
  assert.notDeepEqual(rotatingQueries(queries, start - 1), rotatingQueries(queries, start));
  for (const invalid of [[], queries.slice(1), [...queries.slice(0, 7), queries[0]], queries.map((value, index) => index ? value : { ...value, query: 'x'.repeat(161) }), queries.map((value, index) => index ? value : { ...value, query: 'line\nbreak' })]) assert.throws(() => rotatingQueries(invalid), /queries_not_configured/);
  assert.equal(config.channels.length, 8); assert.ok(config.channels.every(value => !/Teach Me To Talk|Hanen/.test(value.name)));
});

test('four fixed searches and one canonical request use a header key and preserve source time and counters', async () => {
  const calls = [], healthy = fixture();
  const state = await collectDiscovery(queries, KEY, async (url, options) => { calls.push({ url, options }); return healthy(url); });
  assert.equal(calls.length, 5);
  const searches = calls.slice(0, 4).map(call => new URL(call.url));
  for (const request of searches) {
    for (const [name, value] of Object.entries({ part: 'snippet', type: 'video', maxResults: '10', safeSearch: 'strict', relevanceLanguage: 'en', fields: 'kind,items(id(kind,videoId))' })) assert.equal(request.searchParams.get(name), value);
    assert.equal(request.pathname, '/youtube/v3/search');
    assert.match(request.searchParams.get('q'), / -autism -podcast -webinar -lecture -cartoon$/);
    assert.equal(request.searchParams.has('publishedAfter'), request.searchParams.get('order') === 'date');
    if (request.searchParams.has('publishedAfter')) assert.equal(Date.parse(request.searchParams.get('publishedBefore')) - Date.parse(request.searchParams.get('publishedAfter')), 90 * 86400000);
  }
  assert.equal(new Set(searches.map(request => request.searchParams.get('publishedBefore'))).size, 1);
  const canonical = new URL(calls[4].url);
  assert.equal(canonical.pathname, '/youtube/v3/videos'); assert.equal(canonical.searchParams.get('id'), id(0));
  assert.equal(canonical.searchParams.has('maxResults'), false); assert.equal(canonical.searchParams.has('pageToken'), false);
  assert.equal(canonical.searchParams.get('part'), 'snippet,contentDetails,status,statistics');
  assert.match(canonical.searchParams.get('fields'), /statistics\(viewCount,likeCount\)/);
  for (const call of calls) {
    assert.equal(call.options.headers['x-goog-api-key'], KEY); assert.equal(call.options.redirect, 'manual'); assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.url.includes(KEY), false); assert.equal(new URL(call.url).searchParams.has('pageToken'), false);
  }
  assert.deepEqual(state.feed.discovery, { total_queries: 4, successful_queries: 4, failed_queries: 0, recent_successful_queries: 2, popular_successful_queries: 2, recent_window_days: 90 });
  assert.equal(state.feed.items[0].published_at, row().snippet.publishedAt);
  assert.deepEqual(state.feed.items[0].popularity, { view_count: 1000, like_count: 12 });
  assert.equal(state.feed.items[0].duration_seconds, 123); assert.equal(JSON.stringify(state).includes(KEY), false);
});

test('query encoding cannot create extra parameters or change endpoints', async () => {
  const custom = queries.map(value => ({ ...value, query: `${value.query} & q=unsafe | art` })), calls = [];
  await collectDiscovery(custom, KEY, async url => { calls.push(new URL(url)); return json(search([])); });
  assert.equal(calls.length, 4);
  for (const request of calls) { assert.match(request.searchParams.get('q'), /& q=unsafe \| art/); assert.equal(request.searchParams.getAll('q').length, 1); }
});

test('canonical data binds IDs, validates public fields, truncates text and permits missing IDs', () => {
  const source = row(); source.snippet.title += 'x'.repeat(400); source.snippet.description += 'x'.repeat(5000);
  const [item] = parseVideos(videos([source]), provenance(), NOW);
  assert.equal(item.title.length, 300); assert.equal(item.description.length, 800);
  const changes = [value => { value.id = id(1); }, value => { value.snippet.channelId = 'invalid'; }, value => { value.snippet.channelTitle = ''; }, value => { value.snippet.title = ''; }, value => { value.snippet.description = null; }, value => { value.snippet.publishedAt = 'invalid'; }, value => { value.snippet.liveBroadcastContent = 'unknown'; }, value => { value.contentDetails.duration = 'bad'; }, value => { value.status = {}; }];
  for (const change of changes) { const value = row(); change(value); assert.throws(() => parseVideos(videos([value]), provenance(), NOW), /upstream_format/); }
  assert.throws(() => parseVideos(videos([row(), row()]), provenance([id(0), id(1)]), NOW), /upstream_format/);
  for (const value of [null, { ...videos([]), error: null }, { ...videos([]), kind: 'other' }, { ...videos([]), items: {} }]) assert.throws(() => parseVideos(value, provenance(), NOW), /upstream_format/);
  assert.deepEqual(parseVideos(videos([]), provenance(), NOW), []);
});

test('private/live/upcoming, age-restricted, future and long videos never become candidates', () => {
  for (const privacyStatus of ['private', 'unlisted']) assert.deepEqual(parseVideos(videos([{ id: id(0), status: { privacyStatus } }]), provenance(), NOW), []);
  for (const liveBroadcastContent of ['live', 'upcoming']) assert.deepEqual(parseVideos(videos([{ id: id(0), status: { privacyStatus: 'public' }, snippet: { liveBroadcastContent } }]), provenance(), NOW), []);
  for (const change of [value => { value.contentDetails.contentRating = { ytRating: 'ytAgeRestricted' }; }, value => { value.snippet.publishedAt = stamp(300001); }, value => { value.contentDetails.duration = 'PT20M1S'; }, value => { value.contentDetails.duration = 'PT0S'; }]) { const value = row(); change(value); assert.deepEqual(parseVideos(videos([value]), provenance(), NOW), []); }
  for (const duration of ['PT1S', 'PT20M', 'PT0H2M3S']) { const value = row(); value.contentDetails.duration = duration; assert.equal(parseVideos(videos([value]), provenance(), NOW).length, 1); }
});

test('classics require popular provenance; invalid optional statistics do not manufacture zero', () => {
  const value = row(); value.snippet.publishedAt = stamp(-365 * 86400000);
  assert.equal(parseVideos(videos([value]), provenance(), NOW).length, 1);
  assert.deepEqual(parseVideos(videos([value]), provenance([id(0)], false), NOW), []);
  value.snippet.publishedAt = stamp(-90 * 86400000); assert.equal(parseVideos(videos([value]), provenance([id(0)], false), NOW).length, 1);
  for (const count of [undefined, null, -1, '1.5', '-1', '9007199254740992', {}]) { value.statistics = { viewCount: count, likeCount: '0' }; assert.deepEqual(parseVideos(videos([value]), provenance(), NOW)[0].popularity, { like_count: 0 }); }
  delete value.statistics; assert.equal(parseVideos(videos([value]), provenance(), NOW)[0].popularity, undefined);
});

test('screening rejects explicit clinical, lecture, promotion, passive programs and wrong ages, retaining real play', () => {
  for (const title of ['Autism language games', 'AAC play training', 'Echolalia toddler play', 'CEU language development', 'Toddler play podcast', 'Montessori webinar', 'Limited edition play kitchen', 'Limited-edition play kitchen', 'Brand collaboration toddler toys', 'Acme collab with Other play kit', 'Nursery rhymes for toddlers', 'Cartoon toddler activities']) assert.equal(screenContent({ title, description: '' }), null, title);
  for (const description of ['Activities for 6-month-old babies.', 'For 12-week-old babies.', 'For 4-year-olds.']) assert.equal(screenContent({ title: 'Sensory exploration', description }), null);
  for (const value of [{ title: 'Toddler turn taking games', description: 'A speech therapist shares play ideas.' }, { title: 'Collaborative play: 3 games with a toy', description: '' }, { title: 'Reading and singing together with your toddler', description: '' }, { title: 'Sensory play for babies and toddlers', description: 'For 6 to 18 months.' }]) assert.ok(screenContent(value), value.title);
  assert.equal(screenContent({ title: 'A little moment', description: '' }), null);
  assert.deepEqual(screenContent({ title: 'A little moment', description: '' }, ['reading', 'reading', 'invalid']).topics, ['reading']);
  assert.equal(screenContent({ title: 'A little moment', description: '' }, ['reading']).topic_basis, 'query');
  assert.equal(screenContent({ title: 'Toddler painting play', description: '' }, ['reading']).topic_basis, undefined);
});
test('generic toddler wording cannot override explicit other-age evidence or turn creative pairings into ads', () => {
  for (const description of ['For 6-month-old babies.', 'For 4-year-olds.']) assert.equal(screenContent({ title: 'Toddler sensory play', description }), null);
  for (const title of ['Sensory x Art toddler play', 'DIY 2 x 4 wood ramp play']) assert.ok(screenContent({ title, description: '' }), title);
  assert.ok(screenContent({ title: 'Toddler sensory play', description: 'For 6 to 18 months.' }));
  assert.ok(screenContent({ title: 'Toddler play', description: 'For 1–2 years and 4-year-old siblings.' }));
});

test('deduplication unions matching query topics; author diversity caps at 20 items / 2 per author / 10 authors', async () => {
  let searches = 0; const rows = Array.from({ length: 40 }, (_, index) => row(index, index % 15));
  const result = await collectDiscovery(queries, KEY, async url => new URL(url).pathname.endsWith('/search') ? json(search(rows.slice(searches++ * 10, searches * 10).map(value => value.id))) : json(videos(rows)));
  assert.equal(result.feed.items.length, 20); assert.equal(result.channels.length, 10);
  for (const author of result.channels) assert.equal(result.feed.items.filter(item => item.channel_id === author.id).length, 2);
  const unknown = row(); unknown.snippet.title = 'A little moment'; unknown.snippet.description = '';
  const union = await collectDiscovery(queries, KEY, fixture([unknown]));
  assert.deepEqual(union.feed.items[0].topics.sort(), rotatingQueries(queries).map(query => query.topic).sort()); assert.equal(union.feed.items[0].topic_basis, 'query');
});

test('partial searches need eligible candidates; only four healthy searches may publish empty', async t => {
  logs(t); const healthy = fixture(); let searches = 0;
  const partial = await collectDiscovery(queries, KEY, async url => new URL(url).pathname.endsWith('/search') && ++searches === 1 ? new Response('', { status: 404 }) : healthy(url));
  assert.equal(partial.feed.discovery.successful_queries, 3); assert.equal(partial.feed.items.length, 1);
  for (const rows of [[], [row()]]) {
    searches = 0;
    await assert.rejects(collectDiscovery(queries, KEY, async url => new URL(url).pathname.endsWith('/search') ? (++searches === 1 ? new Response('', { status: 404 }) : json(search(rows.map(value => value.id)))) : json(videos([]))), /upstream_unavailable/);
  }
  let calls = 0; const empty = await collectDiscovery(queries, KEY, async () => { calls++; return json(search([])); });
  assert.equal(calls, 4); assert.deepEqual(empty.feed.items, []); assert.deepEqual(empty.channels, []);
  await assert.rejects(collectDiscovery(queries, KEY, async () => new Response('', { status: 403 })), /upstream_unavailable/);
});

test('search envelopes reject malformed IDs, non-video rows and oversized lists', async t => {
  logs(t);
  for (const value of [{ ...search([]), error: {} }, { ...search([]), kind: 'other' }, search(Array(11).fill(id(0))), { kind: 'youtube#searchListResponse', items: [{ id: { kind: 'youtube#channel', videoId: id(0) } }] }, search(['invalid'])]) {
    let calls = 0; await assert.rejects(collectDiscovery(queries, KEY, async () => { calls++; return json(value); }), /upstream_format/); assert.equal(calls, 4);
  }
});

test('one retry per resource caps collection at eight search attempts plus two canonical attempts', async t => {
  const messages = logs(t), counts = new Map(), healthy = fixture();
  await collectDiscovery(queries, KEY, async url => { const count = (counts.get(url) || 0) + 1; counts.set(url, count); return count === 1 ? new Response(KEY, { status: 503, headers: { 'Retry-After': '0' } }) : healthy(url); });
  assert.equal(counts.size, 5); assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 10); assert.equal(JSON.stringify(messages).includes(KEY), false);
});

test('permanent errors, redirects and backoff beyond the phase do not replay or expose details', async t => {
  const messages = logs(t);
  for (const [status, retry] of [[302, '0'], [403, '0'], [408, '0'], [429, '3600'], [503, new Date(Date.now() + 3600000).toUTCString()]]) {
    let calls = 0; await assert.rejects(collectDiscovery(queries, KEY, async () => { calls++; return new Response(KEY, { status, headers: { 'Retry-After': retry, Location: `https://other.example.test/${KEY}` } }); }), /upstream_unavailable/); assert.equal(calls, 4);
  }
  assert.equal(JSON.stringify(messages).includes(KEY), false); assert.ok(messages.every(message => Object.keys(message).sort().join(',') === 'http_status,source'));
});

test('bad media types, UTF-8, JSON and oversized bodies do not retry', async t => {
  logs(t);
  for (const reply of [() => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), () => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }), () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }), () => new Response('x'.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
    let calls = 0; await assert.rejects(collectDiscovery(queries, KEY, async () => { calls++; return reply(); }), error => ['upstream_format', 'payload_too_large'].includes(error.code) && !error.message.includes(KEY)); assert.equal(calls, 4);
  }
});

test('network retries differ from certificate failures and HTTP-date Retry-After is respected', async t => {
  const messages = logs(t), healthy = fixture(), counts = new Map();
  await collectDiscovery(queries, KEY, async url => { const count = (counts.get(url) || 0) + 1; counts.set(url, count); if (count === 1) throw new TypeError(KEY, { cause: { code: 'ECONNRESET' } }); return healthy(url); });
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 10);
  let calls = 0; await assert.rejects(collectDiscovery(queries, KEY, async () => { calls++; throw new TypeError(KEY, { cause: { code: 'CERT_HAS_EXPIRED' } }); }), /upstream_unavailable/); assert.equal(calls, 4);
  const retryAt = new Date(Date.now() + 1500).toUTCString(); let canonical = 0;
  await collectDiscovery(queries, KEY, async url => { if (new URL(url).pathname.endsWith('/videos')) { if (++canonical === 1) return new Response('', { status: 429, headers: { 'Retry-After': retryAt } }); assert.ok(Date.now() >= Date.parse(retryAt)); } return healthy(url); });
  assert.equal(canonical, 2); assert.equal(JSON.stringify(messages).includes(KEY), false);
});

test('separate 13-second phases respect the 26-second overall deadline', async t => {
  logs(t); const original = Date.now, start = original(), healthy = fixture(); let elapsed = 0, canonical = 0;
  Date.now = () => start + elapsed; t.after(() => { Date.now = original; });
  const result = await collectDiscovery(queries, KEY, async url => {
    if (new URL(url).pathname.endsWith('/search')) elapsed = 7000;
    else { elapsed += ++canonical === 1 ? 5000 : 2000; if (canonical === 1) return new Response('', { status: 503, headers: { 'Retry-After': '0' } }); }
    return healthy(url);
  });
  assert.equal(elapsed, 14000); assert.equal(result.feed.items.length, 1); elapsed = 0;
  await assert.rejects(collectDiscovery(queries, KEY, async () => { elapsed = 13001; return json(search([])); }), /upstream_timeout/); elapsed = 0;
  await assert.rejects(collectDiscovery(queries, KEY, async url => { elapsed = new URL(url).pathname.endsWith('/search') ? 12000 : 26001; return healthy(url); }), /upstream_timeout/);
});

test('six-second attempt timeout also aborts a stalled response body', { timeout: 10000 }, async t => {
  logs(t); const healthy = fixture(); let stalled = false, aborted = false;
  const result = await collectDiscovery(queries, KEY, async (url, options) => {
    if (new URL(url).pathname.endsWith('/videos') && !stalled) {
      stalled = true;
      const body = new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException(KEY, 'AbortError')); }, { once: true }); } });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    return healthy(url);
  });
  assert.equal(aborted, true); assert.equal(result.feed.items.length, 1);
});

test('the real CLI uses search only with a key and leaves prior data untouched on failures', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'parenting-youtube-discovery-')));
  try {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'data'));
    for (const name of ['collect.mjs', 'youtube-api.mjs']) copyFileSync(fileURLToPath(new URL(`scripts/${name}`, import.meta.url)), join(dir, 'scripts', name));
    for (const name of ['rss.mjs', 'feed.mjs', 'content.mjs']) symlinkSync(fileURLToPath(new URL(name, import.meta.url)), join(dir, name));
    const source = { id: channel(0), name: 'Synthetic source', topics: ['everyday'] };
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ queries, channels: [source] }));
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><yt:channelId>${source.id}</yt:channelId><entry><yt:videoId>${id(0)}</yt:videoId><yt:channelId>${source.id}</yt:channelId><title>Toddler play</title><published>${stamp(-3600000)}</published><author><name>${source.name}</name></author><media:group><media:description>Own fixture</media:description></media:group></entry></feed>`;
    const hook = `import { writeFileSync } from 'node:fs';\nconst calls=[];\nglobalThis.fetch=async(url,options)=>{const u=new URL(url); const source=u.hostname==='www.googleapis.com'?'youtube_api':'rss'; calls.push({source,path:u.pathname,keyMatches:options.headers['x-goog-api-key']===${JSON.stringify(KEY)},urlContainsKey:url.includes(${JSON.stringify(KEY)})}); writeFileSync('observed.json',JSON.stringify(calls)); if(process.env.SYNTHETIC_FAILURE)return new Response('SYNTHETIC_PRIVATE_MARKER',{status:403}); if(source==='rss')return new Response(${JSON.stringify(atom)}); if(!['/youtube/v3/search','/youtube/v3/videos'].includes(u.pathname))throw new Error('unexpected route'); return new Response(JSON.stringify(u.pathname.endsWith('/search')?${JSON.stringify(search([id(0)]))}:${JSON.stringify(videos([row()]))}),{headers:{'Content-Type':'application/json'}});};\n`;
    writeFileSync(join(dir, 'hook.mjs'), hook);
    const run = env => spawnSync(process.execPath, ['--import', join(dir, 'hook.mjs'), join(dir, 'scripts/collect.mjs')], { cwd: dir, encoding: 'utf8', timeout: 5000, env });
    const api = run({ YOUTUBE_API_KEY: KEY }); assert.equal(api.status, 0, api.stderr);
    const observed = JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8'));
    assert.equal(observed.length, 5); assert.ok(observed.every(call => call.source === 'youtube_api' && call.keyMatches && !call.urlContainsKey));
    assert.equal(JSON.parse(readFileSync(join(dir, 'data/feed.json'), 'utf8')).feed.mode, 'discovery');
    assert.equal((api.stdout + api.stderr + readFileSync(join(dir, 'data/feed.json'), 'utf8')).includes(KEY), false);
    const rss = run({}); assert.equal(rss.status, 0, rss.stderr); assert.deepEqual(JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8')).map(call => call.source), ['rss']);
    writeFileSync(join(dir, 'data/feed.json'), 'prior-success');
    const failed = run({ YOUTUBE_API_KEY: KEY, SYNTHETIC_FAILURE: '1' });
    assert.equal(failed.status, 1); assert.equal(readFileSync(join(dir, 'data/feed.json'), 'utf8'), 'prior-success');
    assert.equal(JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8')).length, 4); assert.equal((failed.stdout + failed.stderr).includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

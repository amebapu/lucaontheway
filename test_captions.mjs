import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCaptions, parseCaptionRecord, collectCaptions, selectCaptionCues } from './scripts/captions.mjs';
import { enrichFeed, makeRequest, parseResponse, fingerprint } from './scripts/enrich.mjs';
import { CONTENT_MODEL, parseAnalysis, parseFeed, filterItems, captionUrl } from './feed.mjs';

const NOW = Date.now(), stamp = time => new Date(time).toISOString();
const item = (index = 0, time = NOW) => ({ id: `C${String(index).padStart(10, '0')}`, title: 'Toddler play at eighteen months', channel: 'Synthetic source', channel_id: `UC${'A'.repeat(22)}`, description: 'Own fixture only. A sufficiently descriptive source for retrieval priority. No private data is used.', published_at: stamp(time), fetched_at: stamp(time), topics: ['everyday'] });
const snapshot = (count = 1, time = NOW) => ({ schema_version: 1, source: 'youtube', mode: 'channels', generated_at: stamp(time), items: Array.from({ length: count }, (_, i) => item(i, time)) });
const source = { lang: 'en', content: [
  { text: 'For an eighteen-month-old child, use a large soft ball.', offset: 1500, duration: 5000 },
  { text: 'Sit together and roll the ball back and forth.', offset: 6500, duration: 5000 },
  { text: 'Stay beside your child and stop when they lose interest.', offset: 11500, duration: 5000 },
] };
const row = id => ({ id, title_zh: '一起滚球', summary: '字幕示范一起滚球，并提醒陪在孩子身旁。', takeaways: ['跟随孩子的兴趣。'], topics: ['everyday'], relevance: 'relevant' });
const play = () => ({
  age: { text: '作者提到18个月的孩子。', cue_id: 'c0', quote: 'eighteen-month-old child' },
  materials: [{ text: '一颗大软球。', cue_id: 'c0', quote: 'a large soft ball' }],
  steps: [{ text: '一起坐下，把球来回滚动。', cue_id: 'c1', quote: 'roll the ball back and forth' }],
  cautions: [{ text: '陪在孩子身旁，失去兴趣时停止。', cue_id: 'c2', quote: 'Stay beside your child and stop when they lose interest.' }],
});
const response = rows => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: rows }) } }], usage: { prompt_tokens: 12, completion_tokens: 24 } });
const model = async (url, options) => {
  const rows = JSON.parse(JSON.parse(options.body).messages[1].content).items;
  return new Response(JSON.stringify(response(rows.map(value => ({ ...row(value.id), ...(value.captions ? { play: play() } : {}) })))));
};

test('native captions convert milliseconds, preserve original cue IDs and reject malformed tracks', () => {
  const record = normalizeCaptions(source, item().id, NOW);
  assert.equal(record.cues[0].start, 1.5);
  assert.equal(record.cues[2].end, 16.5);
  assert.equal(record.coverage, 'full');
  assert.deepEqual(record.ranges, [{ start: 1.5, end: 16.5 }]);
  assert.deepEqual(parseCaptionRecord(record, item().id, NOW), record);
  for (const value of [{ content: 'not timestamped', lang: 'en' }, { content: [], lang: 'en' }, { ...source, lang: '../invalid' }, { ...source, content: [{ text: 'bad', offset: -1, duration: 1 }] }, { ...source, content: [{ text: 'bad', offset: 1, duration: Infinity }] }, { ...source, content: [...source.content].reverse() }]) assert.throws(() => normalizeCaptions(value, item().id, NOW));
  assert.throws(() => parseCaptionRecord(record, item(1).id, NOW));
  assert.throws(() => parseCaptionRecord(record, item().id, NOW + 28 * 86400000));
});

test('bounded excerpts retain head, middle and tail warnings and expose the actual read ranges', () => {
  const content = Array.from({ length: 900 }, (_, index) => ({ text: `Synthetic cue ${index}: ${'word '.repeat(20)}`, offset: index * 1000, duration: 1000 }));
  content.at(-1).text = 'Tail warning: never leave the child alone.';
  const record = normalizeCaptions({ lang: 'en', content }, item().id, NOW);
  assert.equal(record.coverage, 'excerpt');
  assert.ok(record.cues.some(cue => cue.id === 'c0'));
  assert.ok(record.cues.some(cue => cue.id === 'c450'));
  assert.ok(record.cues.some(cue => cue.id === 'c899' && cue.text.includes('Tail warning')));
  assert.equal(record.ranges.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(record.cues)) <= 12 * 1024);
  assert.ok(record.cues.length <= 300);
  assert.deepEqual(selectCaptionCues(record.cues), record.cues);
  assert.deepEqual(parseCaptionRecord(record, item().id, NOW).ranges, record.ranges);
});

test('missing key and cache-only make no caption requests; new requests stop at three', async () => {
  for (const options of [{}, { apiKey: 'SYNTHETIC_KEY', cacheOnly: true }]) {
    const result = await collectCaptions(snapshot(5), { ...options, now: NOW, fetcher: () => assert.fail('No request expected') });
    assert.equal(result.metrics.requests, 0);
    assert.equal(result.cache.statuses[item().id], options.cacheOnly ? 'not_selected' : 'not_configured');
  }
  const waits = [], calls = [];
  const result = await collectCaptions(snapshot(5), { apiKey: 'SYNTHETIC_KEY', now: NOW, wait: async ms => waits.push(ms), fetcher: async id => { calls.push(id); return source; } });
  assert.equal(calls.length, 3); assert.deepEqual(waits, [1000, 1000]);
  assert.equal(result.metrics.available, 3);
  const repeat = await collectCaptions(snapshot(3), { apiKey: 'SYNTHETIC_KEY', now: NOW, cache: result.cache, fetcher: () => assert.fail('Cache must avoid calls') });
  assert.equal(repeat.metrics.requests, 0); assert.equal(repeat.metrics.cache_hits, 3);
  assert.equal(Object.keys(repeat.cache.entries).length, 3);
  assert.equal(JSON.stringify(result.cache).includes('SYNTHETIC_KEY'), false);
});

test('unavailable and pending are reused for a day; authentication and quota stop later calls', async () => {
  for (const code of ['unavailable', 'pending']) {
    const first = await collectCaptions(snapshot(), { apiKey: 'SYNTHETIC_KEY', now: NOW, fetcher: async () => { throw new Error(code); } });
    assert.equal(first.cache.statuses[item().id], code);
    const next = await collectCaptions(snapshot(), { apiKey: 'SYNTHETIC_KEY', now: NOW + 3600000, cache: first.cache, fetcher: () => assert.fail('Do not repeat pending work') });
    assert.equal(next.metrics.requests, 0);
    assert.throws(() => parseCaptionRecord(first.cache.entries[item().id], item().id, NOW + 86400000));
  }
  for (const code of ['authentication', 'rate_limit', 'network', 'upstream_http']) {
    let calls = 0;
    const result = await collectCaptions(snapshot(5), { apiKey: 'SYNTHETIC_KEY', now: NOW, fetcher: async () => { calls++; throw new Error(code); } });
    assert.equal(calls, 1); assert.equal(result.failure, code);
    assert.equal(result.cache.statuses[item().id], 'error');
    assert.equal(Object.keys(result.cache.entries).length, 0);
  }
});

test('caption stage declines another request when its overall deadline is too close', async () => {
  let time = 0, calls = 0;
  const result = await collectCaptions(snapshot(5), { apiKey: 'SYNTHETIC_KEY', now: NOW, clock: () => time, wait: async ms => { time += ms; }, fetcher: async () => { calls++; time += 30000; return source; } });
  assert.equal(calls, 2); assert.equal(result.metrics.requests, 2);
  assert.ok(time < 75000);
});

test('caption summaries validate all evidence including age, strip quotes, and retain safe general summaries', () => {
  const caption = normalizeCaptions(source, item().id, NOW);
  const result = parseResponse(response([{ ...row(item().id), play: play(), basis: 'fake' }]), [item()], NOW, caption).get(item().id);
  assert.equal(result.basis, 'captions'); assert.equal(result.play.age.start, 1);
  assert.equal(result.play.steps[0].start, 6);
  assert.equal(JSON.stringify(result).includes('quote'), false);
  assert.equal(JSON.stringify(result).includes('Stay beside'), false);
  for (const patch of [{ age: { text: '两岁适用', cue_id: 'c0', quote: 'not in these captions' } }, { steps: [{ text: '伪造步骤', cue_id: 'c999', quote: 'roll' }] }, { cautions: [{ text: '伪造提醒', cue_id: 'c1', quote: '请全程看护' }] }]) {
    const bad = parseResponse(response([{ ...row(item().id), play: { ...play(), ...patch } }]), [item()], NOW, caption).get(item().id);
    assert.equal(bad.play, undefined); assert.equal(bad.summary, row(item().id).summary);
  }
  const low = parseResponse(response([{ ...row(item().id), relevance: 'low', play: play() }]), [item()], NOW, caption).get(item().id);
  assert.equal(low.play, undefined);
  const metadata = parseResponse(response([{ ...row(item().id), caption, play: play(), basis: 'captions' }]), [item()], NOW).get(item().id);
  assert.equal(metadata.basis, 'metadata'); assert.equal(metadata.play, undefined); assert.equal(metadata.caption, undefined);
  assert.equal(captionUrl(item().id, 6), `https://www.youtube.com/watch?v=${item().id}&t=6s`);
  for (const time of [-1, Infinity, 1.5, 14401, '6']) assert.equal(captionUrl(item().id, time), '');
});

test('caption input, fingerprints and public parser preserve provenance without raw transcript text', () => {
  const caption = normalizeCaptions(source, item().id, NOW);
  const body = makeRequest([item()], caption);
  assert.equal(body.max_tokens, 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 24 * 1024);
  assert.match(body.messages[0].content, /本次读取的字幕/);
  assert.equal(JSON.parse(body.messages[1].content).items[0].captions.cues[0].start, 1.5);
  assert.notEqual(fingerprint(item(), caption), fingerprint(item()));
  assert.notEqual(fingerprint(item(), caption), fingerprint(item(), { ...caption, coverage: 'excerpt' }));
  const analysis = parseResponse(response([{ ...row(item().id), play: play() }]), [item()], NOW, caption).get(item().id);
  const raw = snapshot(); raw.items[0].analysis = analysis; raw.items[0].transcript = 'SYNTHETIC_RAW_TRANSCRIPT';
  const publicFeed = parseFeed(raw, NOW);
  assert.equal(JSON.stringify(publicFeed).includes('SYNTHETIC_RAW_TRANSCRIPT'), false);
  assert.equal(JSON.stringify(publicFeed).includes('eighteen-month-old'), false);
  assert.equal(filterItems(publicFeed.items, 'all', '软球').length, 1);
  assert.throws(() => parseAnalysis({ ...analysis, play: { ...analysis.play, age: { text: '伪造年龄', start: 999 } } }, NOW));
});

test('forty candidates share eight model calls and at most three new subtitle analyses', async () => {
  const raw = snapshot(40), entries = {};
  for (const entry of raw.items) entries[entry.id] = normalizeCaptions(source, entry.id, NOW);
  let subtitleCalls = 0;
  const result = await enrichFeed(raw, { apiKey: 'SYNTHETIC_KEY', endpoint: 'https://models.example.test/chat', now: NOW, captions: { version: 1, entries }, fetcher: async (url, options) => {
    if (JSON.parse(JSON.parse(options.body).messages[1].content).items[0].captions) subtitleCalls++;
    return model(url, options);
  } });
  assert.equal(subtitleCalls, 3); assert.equal(result.metrics.requests, 8);
  assert.equal(result.feed.items.filter(entry => entry.analysis).length, 28);
  assert.equal(result.feed.enrichment.status, 'partial');
  assert.ok(Object.keys(result.cache.entries).length <= 40);
});

test('an eight-day subtitle snapshot and analysis survive new retrieval priorities without downgrade', async () => {
  const old = NOW - 8 * 86400000, previousFeed = snapshot(1, old), caption = normalizeCaptions(source, item().id, old);
  const first = await enrichFeed(previousFeed, { apiKey: 'SYNTHETIC_KEY', endpoint: 'https://models.example.test/chat', now: old, captions: { version: 1, entries: { [item().id]: caption } }, fetcher: model });
  const next = snapshot(4); next.items[0].published_at = previousFeed.items[0].published_at;
  const calls = [];
  const captions = await collectCaptions(next, { apiKey: 'SYNTHETIC_KEY', now: NOW, cache: { version: 1, entries: { [item().id]: caption } }, wait: async () => {}, fetcher: async id => { calls.push(id); return source; } });
  assert.equal(calls.length, 3); assert.equal(calls.includes(item().id), false);
  const result = await enrichFeed(next, { cache: first.cache, captions: captions.cache, cacheOnly: true, now: NOW, fetcher: () => assert.fail('Old card needs no model call') });
  const reused = result.feed.items.find(entry => entry.id === item().id);
  assert.equal(reused.analysis.basis, 'captions');
  assert.equal(reused.analysis.generated_at, stamp(old));
  assert.deepEqual(reused.analysis.play, first.feed.items[0].analysis.play);
  assert.equal(result.metrics.requests, 0);
});

test('failed caption upgrades retain metadata cache and whole-enrichment deadlines stop further calls', async () => {
  const raw = snapshot(2), first = await enrichFeed(raw, { apiKey: 'SYNTHETIC_KEY', endpoint: 'https://models.example.test/chat', now: NOW, fetcher: model });
  const entries = Object.fromEntries(raw.items.map(entry => [entry.id, normalizeCaptions(source, entry.id, NOW)]));
  const failed = await enrichFeed(raw, { apiKey: 'SYNTHETIC_KEY', endpoint: 'https://models.example.test/chat', cache: first.cache, captions: { version: 1, entries }, now: NOW, fetcher: async () => new Response('', { status: 429 }) });
  assert.equal(failed.metrics.requests, 1);
  assert.equal(failed.feed.items.filter(entry => entry.analysis?.basis === 'metadata').length, 2);
  let time = 0;
  const stopped = await enrichFeed(snapshot(10), { apiKey: 'SYNTHETIC_KEY', endpoint: 'https://models.example.test/chat', now: NOW, clock: () => time, fetcher: async (...args) => { time += 365001; return model(...args); } });
  assert.equal(stopped.metrics.requests, 1); assert.equal(stopped.failure, 'timeout');
});

test('the fourteen-day candidate window is relative to collection, while stale deployments expire after twenty-eight days', () => {
  const collected = snapshot(), caption = normalizeCaptions(source, item().id, NOW);
  collected.items[0].analysis = parseResponse(response([{ ...row(item().id), play: play() }]), [item()], NOW, caption).get(item().id);
  assert.equal(parseFeed(collected, NOW + 15 * 86400000).items[0].analysis.basis, 'captions');
  assert.throws(() => parseFeed(collected, NOW + 29 * 86400000));
  const fresh = snapshot(1, NOW + 15 * 86400000); fresh.items[0].published_at = stamp(NOW);
  assert.throws(() => parseFeed(fresh, NOW + 15 * 86400000));
});

test('Python caption transport fixes native-only URL and keeps credentials out of responses and URLs', () => {
  const path = fileURLToPath(new URL('scripts/captions-transport.py', import.meta.url));
  const program = `import importlib.util,json,sys,io,urllib.parse\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('caption_transport',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nseen={}\nclass Reply:\n status=200\n def __enter__(self):return self\n def __exit__(self,*args):pass\n def read(self,n):return b'{"lang":"en","content":[],"private_field":"SYNTHETIC_PRIVATE_MARKER"}'\nclass Client:\n def open(self,request,timeout):\n  seen['url']=request.full_url;seen['key_matches']=request.get_header('X-api-key')=='SYNTHETIC_CAPTION_KEY';seen['no_model_key_header']=request.get_header('Authorization') is None;seen['timeout']=timeout;return Reply()\nclass Input:\n buffer=io.BytesIO(b'{"video_id":"C0000000000"}')\nwith patch.object(m.urllib.request,'build_opener',return_value=Client()),patch.object(m.sys,'stdin',Input()):result=m.send()\nseen['result']=result;seen['redirect_refused']=m.NoRedirect().redirect_request(None,None,302,'',{},'https://other.example.test') is None\nprint(json.dumps(seen))`;
  const observed = JSON.parse(execFileSync('python3', ['-c', program, path], { encoding: 'utf8', timeout: 5000, env: { ...process.env, SUPADATA_API_KEY: 'SYNTHETIC_CAPTION_KEY' } }));
  const url = new URL(observed.url);
  assert.equal(url.origin + url.pathname, 'https://api.supadata.ai/v1/transcript');
  assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=C0000000000');
  assert.equal(url.searchParams.get('mode'), 'native'); assert.equal(url.searchParams.get('text'), 'false');
  assert.equal(url.searchParams.get('chunkSize'), '500');
  assert.equal(observed.key_matches, true); assert.equal(observed.no_model_key_header, true); assert.equal(observed.redirect_refused, true);
  assert.equal(JSON.stringify(observed).includes('SYNTHETIC_CAPTION_KEY'), false);
  assert.equal(JSON.stringify(observed).includes('SYNTHETIC_PRIVATE_MARKER'), false);
  const invalid = JSON.parse(execFileSync('python3', [path], { input: '{"video_id":"https://bad.example.test"}', encoding: 'utf8', timeout: 5000 }));
  assert.equal(invalid.error, 'input_limit');
  assert.equal(CONTENT_MODEL, 'deepseek/deepseek-flash');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAtom, collectChannels, validateChannels, readTextLimited } from './rss.mjs';
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
  const many = Array.from({ length: 11 }, (_, index) => ({ ...channel, id: `UC${String.fromCharCode(65 + index).repeat(22)}` }));
  assert.equal(validateChannels(many.slice(0, 10)).length, 10);
  assert.equal(validateChannels([{ ...channel, id: `UC${'A'.repeat(20)}_-` }]).length, 1);
  for (const bad of [[], [channel, channel], many, [{ ...channel, topics: ['constructor'] }], [{ ...channel, id: 'https://other.example.test' }]]) assert.throws(() => validateChannels(bad));
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
test('one failed channel publishes healthy sources; all failures reject the batch', async () => {
  const other = { ...channel, id: `UC${'B'.repeat(22)}` };
  const feed = await collectChannels([channel, other], async url => url.includes(other.id) ? new Response('failed', { status: 404 }) : new Response(atom()));
  assert.equal(feed.items.length, 1);
  assert.deepEqual(feed.collection, { succeeded: [channel.id], failed: [other.id] });
  await assert.rejects(collectChannels([channel, other], async () => new Response('failed', { status: 404 })), /upstream_unavailable/);
  const empty = await collectChannels([channel], async () => new Response(atom('')));
  assert.deepEqual(empty.collection.succeeded, [channel.id]);
  assert.deepEqual(empty.items, []);
});

test('ten sources still publish when two fail', async () => {
  const channels = Array.from({ length: 10 }, (_, index) => ({ ...channel, id: `UC${String.fromCharCode(65 + index).repeat(22)}` }));
  const result = await collectChannels(channels, async url => {
    const source = channels.find(source => url.includes(source.id));
    if (channels.indexOf(source) < 2) return new Response('unavailable', { status: 404 });
    return new Response(atom(entry({ cid: source.id, id: `${source.id[2]}0000000000` }), source.id));
  });
  assert.equal(result.collection.succeeded.length, 8);
  assert.equal(result.collection.failed.length, 2);
  assert.equal(result.items.length, 8);
});

test('round-robin selection covers every active source and preserves single-source depth', async () => {
  const channels = Array.from({ length: 8 }, (_, index) => ({ ...channel, id: `UC${String.fromCharCode(65 + index).repeat(22)}` }));
  const fetcher = async url => {
    const source = channels.find(source => url.includes(source.id)), letter = source.id[2];
    const entries = Array.from({ length: 15 }, (_, index) => entry({ id: `${letter}${String(index).padStart(10, '0')}`, cid: source.id, title: 'Toddler play', published: stamp(-index * 3600000) })).join('');
    return new Response(atom(entries, source.id));
  };
  const feed = await collectChannels(channels, fetcher);
  assert.equal(feed.items.length, 40);
  for (const source of channels) assert.equal(feed.items.filter(item => item.channel_id === source.id).length, 5);
  assert.equal((await collectChannels([channels[0]], fetcher)).items.length, 15);
});

test('content rules cover the requested eight topics without treating titles as age verification', () => {
  for (const [title, topic] of [['Toddler language play','language'],['Walking and balance for toddlers','movement'],['Fine motor puzzles for toddlers','fine_motor'],['Toddler sensory bin','sensory'],['Toddler painting','art'],['Reading books with toddlers','reading'],['Toddler games','everyday'],['Serve and return development','theory']]) {
    assert.ok(screenContent({ title, description: '' }).topics.includes(topic));
  }
  for (const title of ['3 Cozy Ways to Do Tummy Time','Newborn sensory play','Games for 5 year olds','Black Friday toddler toy discount','Family weekend vlog']) assert.equal(screenContent({ title, description: '' }), null);
  for (const title of ['When Do Babies Sit On Their Own?','How to Help Your Baby Sit Up','Baby sitting up sensory play']) assert.equal(screenContent({ title, description: 'Motor skills activities' }), null);
  assert.ok(screenContent({ title: 'Sensory play for 18 months', description: '' }));
});

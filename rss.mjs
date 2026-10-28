import { SaxesParser } from 'saxes';
import { TOPICS, CLOCK_SKEW, parseFeed, validVideoId } from './feed.mjs';
import { screenContent } from './content.mjs';

const ATOM = 'http://www.w3.org/2005/Atom';
const YT = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA = 'http://search.yahoo.com/mrss/';
export class FeedError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function validateChannels(channels) {
  if (!Array.isArray(channels) || !channels.length || channels.length > 10) throw new FeedError('channels_not_configured');
  const ids = new Set();
  for (const channel of channels) {
    if (!channel || !/^UC[A-Za-z0-9_-]{22}$/.test(channel.id) || typeof channel.name !== 'string' || !channel.name || channel.name.length > 120 || !Array.isArray(channel.topics) || !channel.topics.length || channel.topics.some(t => !Object.hasOwn(TOPICS, t)) || ids.has(channel.id)) throw new FeedError('invalid_channel');
    ids.add(channel.id);
  }
  return channels;
}

export async function readTextLimited(body, limit) {
  if (!body) return '';
  const reader = body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new FeedError('payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function parseAtom(xml, channel, now = Date.now()) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new FeedError('upstream_format');
  const parser = new SaxesParser({ xmlns: true });
  const stack = [], entries = [];
  let rootChannel = '', entry = null, rootSeen = false;
  parser.on('doctype', () => { throw new FeedError('upstream_format'); });
  parser.on('opentag', tag => {
    stack.push(tag);
    if (stack.length > 16) throw new FeedError('upstream_format');
    if (stack.length === 1) {
      if (tag.uri !== ATOM || tag.local !== 'feed') throw new FeedError('upstream_format');
      rootSeen = true;
    }
    if (stack.length === 2 && tag.uri === ATOM && tag.local === 'entry') {
      if (entries.length >= 15) throw new FeedError('upstream_format');
      entry = { id: '', channel_id: '', title: '', channel: '', description: '', published_at: '' };
    }
  });
  const onText = value => {
    const tag = stack.at(-1), parent = stack.at(-2);
    if (!tag) return;
    if (!entry && stack.length === 2 && tag.uri === YT && tag.local === 'channelId') rootChannel += value;
    if (!entry) return;
    let field;
    if (stack.length === 3 && tag.uri === YT && ['videoId', 'channelId'].includes(tag.local)) field = tag.local === 'videoId' ? 'id' : 'channel_id';
    if (stack.length === 3 && tag.uri === ATOM && ['title', 'published'].includes(tag.local)) field = tag.local === 'title' ? 'title' : 'published_at';
    if (stack.length === 4 && parent.uri === ATOM && parent.local === 'author' && tag.uri === ATOM && tag.local === 'name') field = 'channel';
    if (stack.length === 4 && parent.uri === MEDIA && parent.local === 'group' && tag.uri === MEDIA && tag.local === 'description') field = 'description';
    if (field) {
      const limit = field === 'description' ? 800 : 300;
      entry[field] = (entry[field] + value).slice(0, limit);
    }
  };
  parser.on('text', onText); parser.on('cdata', onText);
  parser.on('closetag', tag => {
    if (stack.length === 2 && tag.uri === ATOM && tag.local === 'entry') { entries.push(entry); entry = null; }
    stack.pop();
  });
  try { parser.write(xml).close(); }
  catch { throw new FeedError('upstream_format'); }
  if (!rootSeen || ![channel.id, channel.id.slice(2)].includes(rootChannel.trim())) throw new FeedError('upstream_format');
  const fetched = new Date(now).toISOString(), items = [];
  for (const item of entries) {
    const published = Date.parse(item.published_at);
    if (!validVideoId(item.id) || item.channel_id !== channel.id || !item.title || !item.channel || !Number.isFinite(published) || published > now + CLOCK_SKEW) throw new FeedError('upstream_format');
    if (published < now - 14 * 86400000) continue;
    const candidate = screenContent({ ...item, published_at: new Date(published).toISOString(), fetched_at: fetched, topics: [...new Set(channel.topics)] });
    if (candidate) items.push(candidate);
  }
  return items;
}

async function fetchChannel(channel, now, deadline, fetcher) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FeedError('upstream_timeout');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(6000, remaining));
    let delay = 100;
    try {
      const response = await fetcher(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`, {
        redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/atom+xml, application/xml' },
      });
      if (response.ok) return parseAtom(await readTextLimited(response.body, 256 * 1024), channel, now);
      if (response.body) await response.body.cancel();
      if (response.status !== 429 && response.status < 500) throw new FeedError('upstream_unavailable');
      const retry = response.headers.get('Retry-After');
      if (retry !== null) {
        if (/^\d+$/.test(retry.trim())) delay = Number(retry.trim()) * 1000;
        else { const time = Date.parse(retry); if (Number.isFinite(time)) delay = Math.max(0, time - Date.now()); }
      }
    } catch (error) {
      if (error instanceof FeedError) throw error;
      if (attempt === 1) throw new FeedError(controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable');
    } finally { clearTimeout(timeout); }
    if (attempt === 1 || delay >= deadline - Date.now()) throw new FeedError('upstream_unavailable');
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export function assembleFeed(channels, results, now) {
  if (results.every(result => result.status === 'rejected')) throw results[0].reason;
  const collection = { succeeded: [], failed: [] }, groups = [];
  for (const [index, result] of results.entries()) {
    collection[result.status === 'fulfilled' ? 'succeeded' : 'failed'].push(channels[index].id);
    if (result.status === 'fulfilled') groups.push([...new Map(result.value.map(item => [item.id, item])).values()].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || a.id.localeCompare(b.id)));
  }
  const unique = new Map();
  for (let index = 0; index < 15 && unique.size < 40; index++) for (const group of groups) {
    const item = group[index];
    if (!item) continue;
    if (unique.has(item.id)) unique.get(item.id).topics = [...new Set([...unique.get(item.id).topics, ...item.topics])];
    else if (unique.size < 40) unique.set(item.id, item);
  }
  const items = [...unique.values()].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || a.id.localeCompare(b.id));
  const feed = { schema_version: 1, source: 'youtube', mode: 'channels', generated_at: new Date(now).toISOString(), collection, items };
  parseFeed(feed, now);
  return feed;
}

export async function collectChannels(channels, fetcher = fetch) {
  validateChannels(channels);
  const now = Date.now(), deadline = now + 15000;
  const results = await Promise.allSettled(channels.map(channel => fetchChannel(channel, now, deadline, fetcher)));
  return assembleFeed(channels, results, now);
}

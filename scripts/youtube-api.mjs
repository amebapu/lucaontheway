import { FeedError, readTextLimited } from '../rss.mjs';
import { TOPICS, CLOCK_SKEW, validVideoId, compareForDiscovery, isRecent } from '../feed.mjs';
import { screenContent } from '../content.mjs';

const TEMPORARY = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

async function requestJson(resource, parameters, apiKey, deadline, fetcher) {
  const url = new URL(resource, 'https://www.googleapis.com/youtube/v3/');
  url.search = new URLSearchParams(parameters).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FeedError('upstream_timeout');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(6000, remaining));
    let delay = 100;
    try {
      const response = await fetcher(url.href, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', 'x-goog-api-key': apiKey } });
      if (response.ok) {
        if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          if (response.body) await response.body.cancel();
          throw new FeedError('upstream_format');
        }
        let text;
        try { text = await readTextLimited(response.body, (resource === 'videos' ? 512 : 256) * 1024); }
        catch (error) {
          if (error instanceof FeedError || controller.signal.aborted || error?.name === 'AbortError' || error?.cause?.code || TEMPORARY.has(error?.code)) throw error;
          throw new FeedError('upstream_format');
        }
        if (Date.now() >= deadline) throw new FeedError('upstream_timeout');
        try { return JSON.parse(text); }
        catch { throw new FeedError('upstream_format'); }
      }
      console.info(JSON.stringify({ source: 'youtube_api', http_status: response.status }));
      if (response.body) await response.body.cancel();
      if (response.status !== 429 && response.status < 500) throw new FeedError('upstream_unavailable');
      const retry = response.headers.get('Retry-After');
      if (retry !== null) {
        if (/^\d+$/.test(retry.trim())) delay = Number(retry.trim()) * 1000;
        else { const time = Date.parse(retry); if (Number.isFinite(time)) delay = Math.max(0, time - Date.now()); }
      }
    } catch (error) {
      if (error instanceof FeedError) {
        if (['upstream_format', 'payload_too_large', 'upstream_timeout'].includes(error.code)) console.info(JSON.stringify({ source: 'youtube_api', network_error: error.code === 'upstream_timeout' ? 'timeout' : 'format' }));
        throw error;
      }
      const timedOut = controller.signal.aborted || error?.name === 'AbortError';
      console.info(JSON.stringify({ source: 'youtube_api', network_error: timedOut ? 'timeout' : 'network' }));
      if (attempt === 1 || (!timedOut && !TEMPORARY.has(error?.cause?.code || error?.code))) throw new FeedError(timedOut ? 'upstream_timeout' : 'upstream_unavailable');
    } finally { clearTimeout(timeout); }
    if (attempt === 1 || delay >= deadline - Date.now()) throw new FeedError('upstream_unavailable');
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export function rotatingQueries(queries, now = Date.now()) {
  if (!Array.isArray(queries) || queries.length !== 8 || new Set(queries.map(value => value?.topic)).size !== 8 || new Set(queries.map(value => value?.query)).size !== 8 || queries.some(value => !value || !Object.hasOwn(TOPICS, value.topic) || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 160 || /[\u0000-\u001f\u007f]/.test(value.query))) throw new FeedError('queries_not_configured');
  const day = Math.floor((now + 8 * 3600000) / 86400000);
  return [...queries.map(query => ({ ...query, order: 'date' })), ...queries.filter((_, index) => index % 2 === day % 2).map(query => ({ ...query, order: 'viewCount' }))];
}

function searchIds(raw) {
  if (raw?.kind !== 'youtube#searchListResponse' || Object.hasOwn(raw, 'error') || !Array.isArray(raw.items) || raw.items.length > 25) throw new FeedError('upstream_format');
  return raw.items.map(row => {
    if (row?.id?.kind !== 'youtube#video' || !validVideoId(row.id.videoId)) throw new FeedError('upstream_format');
    return row.id.videoId;
  });
}

export function parseVideos(raw, provenance, now = Date.now()) {
  if (raw?.kind !== 'youtube#videoListResponse' || Object.hasOwn(raw, 'error') || !Array.isArray(raw.items) || raw.items.length > provenance.size) throw new FeedError('upstream_format');
  const seen = new Set(), items = [], fetched = new Date(now).toISOString();
  for (const row of raw.items) {
    if (!provenance.has(row?.id) || seen.has(row.id)) throw new FeedError('upstream_format');
    seen.add(row.id);
    const privacy = row.status?.privacyStatus;
    if (privacy === 'private' || privacy === 'unlisted') continue;
    if (privacy !== 'public') throw new FeedError('upstream_format');
    const snippet = row.snippet, details = row.contentDetails;
    if (!['none', 'live', 'upcoming'].includes(snippet?.liveBroadcastContent)) throw new FeedError('upstream_format');
    if (snippet.liveBroadcastContent !== 'none') continue;
    const published = typeof snippet.publishedAt === 'string' ? Date.parse(snippet.publishedAt) : NaN;
    const duration = typeof details?.duration === 'string' && /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(details.duration);
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(snippet.channelId) || typeof snippet.channelTitle !== 'string' || !snippet.channelTitle.trim() || typeof snippet.title !== 'string' || !snippet.title.trim() || typeof snippet.description !== 'string' || !Number.isFinite(published) || !duration || !duration.slice(1).some(value => value !== undefined)) throw new FeedError('upstream_format');
    const seconds = Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0);
    if (!Number.isSafeInteger(seconds)) throw new FeedError('upstream_format');
    const match = provenance.get(row.id);
    if (seconds < 1 || seconds > 1200 || details.contentRating?.ytRating === 'ytAgeRestricted' || published > now + CLOCK_SKEW || (published < now - 90 * 86400000 && !match.popular)) continue;
    const popularity = {};
    for (const [field, name] of [['viewCount', 'view_count'], ['likeCount', 'like_count']]) {
      const value = row.statistics?.[field];
      if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) popularity[name] = Number(value);
    }
    const candidate = screenContent({ id: row.id, channel_id: snippet.channelId, channel: snippet.channelTitle.slice(0, 120), title: snippet.title.slice(0, 300), description: snippet.description.slice(0, 800), published_at: new Date(published).toISOString(), fetched_at: fetched, duration_seconds: seconds, ...(Object.keys(popularity).length ? { popularity } : {}) }, [...match.topics]);
    if (candidate) items.push(candidate);
  }
  return items;
}

export async function collectDiscovery(queries, apiKey, fetcher = fetch) {
  const now = Date.now(), searchDeadline = now + 13000, overallDeadline = now + 26000;
  const selected = rotatingQueries(queries, now);
  const results = await Promise.allSettled(selected.map(async query => {
    const parameters = { part: 'snippet', type: 'video', maxResults: '25', safeSearch: 'strict', relevanceLanguage: 'en', order: query.order, q: `${query.query} -autism -podcast -webinar -lecture -cartoon`, publishedBefore: new Date(now).toISOString(), fields: 'kind,items(id(kind,videoId))' };
    if (query.order === 'date') parameters.publishedAfter = new Date(now - 90 * 86400000).toISOString();
    return searchIds(await requestJson('search', parameters, apiKey, searchDeadline, fetcher));
  }));
  const succeeded = results.filter(result => result.status === 'fulfilled').length;
  if (!succeeded) throw results[0].reason;
  if (succeeded < 8) throw new FeedError('upstream_unavailable');
  const provenance = new Map();
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    const query = selected[index];
    for (const id of result.value) {
      if (!provenance.has(id)) provenance.set(id, { topics: new Set(), popular: false });
      const match = provenance.get(id); match.topics.add(query.topic); match.popular ||= query.order === 'viewCount';
    }
  });
  if (Date.now() >= searchDeadline) throw new FeedError('upstream_timeout');
  let candidates = [];
  if (provenance.size) {
    const deadline = Math.min(overallDeadline, Date.now() + 13000);
    const ids = [...provenance.keys()], batches = [];
    for (let offset = 0; offset < ids.length; offset += 25) batches.push(ids.slice(offset, offset + 25));
    const videos = await Promise.allSettled(batches.map(async batch => {
      const raw = await requestJson('videos', { part: 'snippet,contentDetails,status,statistics', id: batch.join(','), fields: 'kind,items(id,snippet(title,description,channelId,channelTitle,publishedAt,liveBroadcastContent),contentDetails(duration,contentRating(ytRating)),status(privacyStatus),statistics(viewCount,likeCount))' }, apiKey, deadline, fetcher);
      return parseVideos(raw, new Map(batch.map(id => [id, provenance.get(id)])), now);
    }));
    const failed = videos.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    candidates = videos.flatMap(result => result.value);
    if (Date.now() >= deadline) throw new FeedError('upstream_timeout');
  }
  const recentItems = candidates.filter(item => isRecent(item, now)).sort(compareForDiscovery), classics = candidates.filter(item => !isRecent(item, now)).sort(compareForDiscovery);
  const items = [], authors = new Map(), acceptedIds = new Set();
  for (const [pool, target] of [[recentItems, 24], [classics, 16], [recentItems, 40], [classics, 40]]) {
    let added = 0;
    for (const item of pool) {
      if (items.length >= 40 || added >= target) break;
      if (acceptedIds.has(item.id) || (!authors.has(item.channel_id) && authors.size >= 20)) continue;
      const author = authors.get(item.channel_id);
      if (author?.count >= 2) continue;
      if (!author) authors.set(item.channel_id, { id: item.channel_id, name: item.channel, topics: new Set(), count: 0 });
      const accepted = authors.get(item.channel_id); accepted.count++; item.topics.forEach(topic => accepted.topics.add(topic));
      items.push(item); acceptedIds.add(item.id); added++;
    }
  }
  if (items.length < 16) throw new FeedError('insufficient_candidates');
  const recent = results.filter((result, index) => result.status === 'fulfilled' && selected[index].order === 'date').length;
  return {
    feed: { schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: new Date(now).toISOString(), discovery: { total_queries: 12, successful_queries: succeeded, failed_queries: 12 - succeeded, recent_successful_queries: recent, popular_successful_queries: succeeded - recent, recent_window_days: 90, unique_videos: provenance.size, eligible_videos: candidates.length, selected_videos: items.length }, items },
    channels: [...authors.values()].map(({ id, name, topics }) => ({ id, name, topics: [...topics] })),
  };
}


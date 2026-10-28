import { assembleFeed, FeedError, readTextLimited, validateChannels } from '../rss.mjs';
import { CLOCK_SKEW, validVideoId } from '../feed.mjs';
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
        try { text = await readTextLimited(response.body, 256 * 1024); }
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

export function parseUploads(raw, channel, playlistId, now = Date.now()) {
  if (raw?.kind !== 'youtube#playlistItemListResponse' || Object.hasOwn(raw, 'error') || !Array.isArray(raw.items) || raw.items.length > 15) throw new FeedError('upstream_format');
  const items = [], fetched = new Date(now).toISOString();
  for (const row of raw.items) {
    const privacy = row?.status?.privacyStatus;
    if (privacy === 'private' || privacy === 'unlisted') continue;
    if (privacy !== 'public') throw new FeedError('upstream_format');
    const snippet = row.snippet, details = row.contentDetails;
    const published = typeof details?.videoPublishedAt === 'string' ? Date.parse(details.videoPublishedAt) : NaN;
    if (snippet?.playlistId !== playlistId || snippet.channelId !== channel.id || (snippet.videoOwnerChannelId !== undefined && snippet.videoOwnerChannelId !== channel.id) || snippet.resourceId?.kind !== 'youtube#video' || !validVideoId(details?.videoId) || snippet.resourceId.videoId !== details.videoId || typeof snippet.title !== 'string' || !snippet.title.trim() || typeof snippet.description !== 'string' || !Number.isFinite(published) || published > now + CLOCK_SKEW) throw new FeedError('upstream_format');
    if (published < now - 14 * 86400000) continue;
    const candidate = screenContent({ id: details.videoId, channel_id: channel.id, channel: channel.name, title: snippet.title.slice(0, 300), description: snippet.description.slice(0, 800), published_at: new Date(published).toISOString(), fetched_at: fetched, topics: [...channel.topics] });
    if (candidate) items.push(candidate);
  }
  return items;
}

export async function collectApiChannels(channels, apiKey, fetcher = fetch) {
  validateChannels(channels);
  const now = Date.now(), mappingDeadline = now + 13000, overallDeadline = now + 26000;
  const raw = await requestJson('channels', { part: 'contentDetails', id: channels.map(channel => channel.id).join(','), maxResults: '50' }, apiKey, mappingDeadline, fetcher);
  if (raw?.kind !== 'youtube#channelListResponse' || Object.hasOwn(raw, 'error') || !Array.isArray(raw.items) || raw.items.length > channels.length) throw new FeedError('upstream_format');
  const requested = new Set(channels.map(channel => channel.id)), seen = new Set(), uploads = new Map();
  for (const row of raw.items) {
    if (!requested.has(row?.id) || seen.has(row.id)) throw new FeedError('upstream_format');
    seen.add(row.id);
    const id = row.contentDetails?.relatedPlaylists?.uploads;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{10,80}$/.test(id)) uploads.set(row.id, id);
  }
  if (Date.now() >= mappingDeadline) throw new FeedError('upstream_timeout');
  const deadline = Math.min(overallDeadline, Date.now() + 13000);
  const results = await Promise.allSettled(channels.map(async channel => {
    if (!uploads.has(channel.id)) throw new FeedError('upstream_unavailable');
    const playlistId = uploads.get(channel.id);
    const body = await requestJson('playlistItems', { part: 'snippet,contentDetails,status', playlistId, maxResults: '15' }, apiKey, deadline, fetcher);
    return parseUploads(body, channel, playlistId, now);
  }));
  return assembleFeed(channels, results, now);
}

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../config.json' with { type: 'json' };
import { collectChannels, validateChannels, FeedError } from '../rss.mjs';
import { parseFeed } from '../feed.mjs';
import { collectApiChannels } from './youtube-api.mjs';

export async function fetchRss(url, options) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) console.info(JSON.stringify({ source: 'youtube_rss', http_status: response.status }));
    return response;
  } catch (error) {
    const known = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPROTO', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
    const code = error?.cause?.code || error?.code;
    console.info(JSON.stringify({ source: 'youtube_rss', network_error: known.includes(code) ? code : error?.name === 'AbortError' ? 'ABORTED' : 'OTHER' }));
    throw error;
  }
}

export async function collectToFile(destination, channels, collect = collectChannels) {
  validateChannels(channels);
  const feed = { schema_version: 1, source: 'youtube', ...parseFeed(await collect(channels)) };
  const state = { feed, channels: channels.map(({ id, name, topics }) => ({ id, name, topics })) };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(`${destination}.tmp`, JSON.stringify(state) + '\n');
  await rename(`${destination}.tmp`, destination);
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY?.trim() || '';
    console.log(JSON.stringify({ collection_source: apiKey ? 'youtube_api' : 'rss' }));
    const state = await collectToFile('data/feed.json', config.channels, channels => apiKey ? collectApiChannels(channels, apiKey) : collectChannels(channels, fetchRss));
    console.log(`Collected ${state.feed.items.length} candidates at ${state.feed.generated_at}`);
  } catch (error) {
    console.error(`Collection failed: ${error instanceof FeedError ? error.code : 'collection_failed'}`);
    process.exitCode = 1;
  }
}

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../config.json' with { type: 'json' };
import { collectChannels, validateChannels, FeedError } from '../rss.mjs';
import { parseFeed } from '../feed.mjs';

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
    const state = await collectToFile('data/feed.json', config.channels);
    console.log(`Collected ${state.feed.items.length} candidates at ${state.feed.generated_at}`);
  } catch (error) {
    console.error(`Collection failed: ${error instanceof FeedError ? error.code : 'collection_failed'}`);
    process.exitCode = 1;
  }
}

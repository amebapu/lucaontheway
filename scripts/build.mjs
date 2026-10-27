import { mkdir, readdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { parseFeed } from '../feed.mjs';
import { validateChannels } from '../rss.mjs';

const state = JSON.parse(await readFile('data/feed.json', 'utf8'));
const feed = { schema_version: 1, source: 'youtube', ...parseFeed(state.feed) };
const channels = validateChannels(state.channels).map(({ id, name, topics }) => ({ id, name, topics }));

await mkdir('dist', { recursive: true });
for (const name of await readdir('dist')) await rm(`dist/${name}`, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs']) await copyFile(name, `dist/${name}`);
await writeFile('dist/feed.json', JSON.stringify({ feed, channels }) + '\n');
console.log('Built 5 static files; source configuration and private runtime files excluded.');

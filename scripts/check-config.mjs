import { readFile } from 'node:fs/promises';
import { validateChannels } from '../rss.mjs';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const channels = JSON.parse(await readFile('config.json', 'utf8'));
try {
  validateChannels(channels.channels);
  const id = config.d1_databases?.[0]?.database_id;
  if (!id || id === '00000000-0000-0000-0000-000000000000' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error();
  if (config.assets?.directory !== './dist' || config.assets?.run_worker_first !== true || config.preview_urls !== false) throw new Error();
} catch {
  console.error('Deployment blocked: configure the real new D1 database ID first.');
  process.exitCode = 1;
}

import { execFile } from 'node:child_process';
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertFresh, parseFeed, parseCaptionProvenance, validVideoId, compareForDiscovery } from '../feed.mjs';

const CUE_BYTES = 12 * 1024;
const SAFE_ERRORS = ['input_limit', 'authentication', 'rate_limit', 'unavailable', 'pending', 'upstream_http', 'payload_too_large', 'response_format', 'timeout', 'network'];
export const normalizeText = value => value.replace(/\s+/gu, ' ').trim();

function cueGroups(cues) {
  const groups = [];
  for (const cue of cues) {
    const group = groups.at(-1);
    if (group && Number(cue.id.slice(1)) === Number(group.at(-1).id.slice(1)) + 1) group.push(cue);
    else groups.push([cue]);
  }
  return groups;
}

function rangesFor(cues) {
  const ranges = [];
  for (const group of cueGroups(cues)) {
    const range = { start: group[0].start, end: Math.max(...group.map(cue => cue.end)) };
    if (ranges.length && range.start <= ranges.at(-1).end) ranges.at(-1).end = Math.max(range.end, ranges.at(-1).end);
    else ranges.push(range);
  }
  return ranges;
}

export function selectCaptionCues(cues, byteLimit = CUE_BYTES) {
  if (cues.length <= 300 && Buffer.byteLength(JSON.stringify(cues)) <= byteLimit) return cues;
  let groups = cueGroups(cues);
  if (groups.length === 1) {
    const third = Math.floor(cues.length / 3);
    groups = [cues.slice(0, third), cues.slice(third, 2 * third), cues.slice(2 * third)].filter(group => group.length);
  }
  const orders = groups.map((group, index) => {
    if (index === groups.length - 1) return [...group].reverse();
    if (index !== 1) return group;
    const middle = Math.floor(group.length / 2), order = [group[middle]];
    for (let distance = 1; order.length < group.length; distance++) {
      if (middle + distance < group.length) order.push(group[middle + distance]);
      if (middle - distance >= 0) order.push(group[middle - distance]);
    }
    return order;
  });
  const selected = [], positions = orders.map(() => 0);
  let changed = true;
  while (changed && selected.length < 300) {
    changed = false;
    for (const [index, order] of orders.entries()) {
      const cue = order[positions[index]];
      if (!cue || selected.length >= 300) continue;
      if (Buffer.byteLength(JSON.stringify([...selected, cue])) > byteLimit) { positions[index] = order.length; continue; }
      selected.push(cue); positions[index]++; changed = true;
    }
  }
  return selected.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function resizeCaptions(record, byteLimit = CUE_BYTES) {
  const cues = selectCaptionCues(record.cues, byteLimit);
  if (!cues.length) throw new Error('response_format');
  return { ...record, cues, coverage: cues.length === record.total_cues ? 'full' : 'excerpt', ranges: rangesFor(cues) };
}

export function normalizeCaptions(value, videoId, now = Date.now()) {
  if (!validVideoId(videoId) || !value || !Array.isArray(value.content) || value.content.length > 10000) throw new Error('response_format');
  if (!value.content.length) throw new Error('unavailable');
  let previous = -1;
  const cues = value.content.map((row, index) => {
    if (!row || typeof row.text !== 'string' || row.text.length > 1000 || !Number.isFinite(row.offset) || !Number.isFinite(row.duration) || row.offset < previous || row.offset < 0 || row.duration < 0 || row.offset + row.duration > 14400000) throw new Error('response_format');
    const text = normalizeText(row.text);
    if (!text) throw new Error('response_format');
    previous = row.offset;
    return { id: `c${index}`, start: row.offset / 1000, end: (row.offset + row.duration) / 1000, text };
  });
  const record = resizeCaptions({ video_id: videoId, status: 'available', fetched_at: new Date(now).toISOString(), language: value.lang, total_cues: cues.length, total_end: Math.max(...cues.map(cue => cue.end)), cues });
  parseCaptionProvenance(record, now);
  return record;
}

export function parseCaptionRecord(raw, videoId, now = Date.now()) {
  if (!raw || raw.video_id !== videoId || !validVideoId(videoId)) throw new Error('response_format');
  const fetched = assertFresh(raw.fetched_at, now);
  if (['unavailable', 'pending'].includes(raw.status)) {
    if (now - fetched >= 86400000) throw new Error('response_format');
    return { video_id: videoId, status: raw.status, fetched_at: raw.fetched_at };
  }
  if (raw.status !== 'available' || !Array.isArray(raw.cues) || !raw.cues.length || raw.cues.length > 300 || !Number.isSafeInteger(raw.total_cues) || raw.total_cues < raw.cues.length || raw.total_cues > 10000 || !Number.isFinite(raw.total_end) || raw.total_end < 0 || raw.total_end > 14400) throw new Error('response_format');
  let previousIndex = -1, previousStart = -1;
  const cues = raw.cues.map(cue => {
    const index = /^c\d{1,5}$/.test(cue?.id) ? Number(cue.id.slice(1)) : -1;
    if (index <= previousIndex || index >= raw.total_cues || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < previousStart || cue.start < 0 || cue.end < cue.start || cue.end > raw.total_end || typeof cue.text !== 'string' || cue.text.length > 1000 || !cue.text.trim()) throw new Error('response_format');
    previousIndex = index; previousStart = cue.start;
    return { id: cue.id, start: cue.start, end: cue.end, text: normalizeText(cue.text) };
  });
  if (Buffer.byteLength(JSON.stringify(cues)) > CUE_BYTES) throw new Error('response_format');
  const record = { video_id: videoId, status: 'available', fetched_at: raw.fetched_at, language: raw.language, total_cues: raw.total_cues, total_end: raw.total_end, cues, coverage: cues.length === raw.total_cues ? 'full' : 'excerpt', ranges: rangesFor(cues) };
  parseCaptionProvenance(record, now);
  return record;
}

export async function captionFetch(videoId, { apiKey, signal }) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [fileURLToPath(new URL('captions-transport.py', import.meta.url))], {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, signal, killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, SUPADATA_API_KEY: apiKey, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout) => {
      if (error) { reject(new Error(signal.aborted ? 'timeout' : 'network')); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.error) { reject(new Error(SAFE_ERRORS.includes(result.error) ? result.error : 'network')); return; }
        resolve(result.data);
      } catch { reject(new Error('response_format')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ video_id: videoId }));
  });
}

export async function collectCaptions(raw, { apiKey = '', cache = {}, cacheOnly = false, fetcher = captionFetch, now = Date.now(), clock = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), requestMs = 23000 } = {}) {
  const feed = parseFeed(raw, now), entries = {}, statuses = {}, pending = [];
  const metrics = { requests: 0, cache_hits: 0, available: 0 }, deadline = clock() + 75000;
  let failure = null;
  for (const item of feed.items) {
    try {
      const record = parseCaptionRecord(cache?.version === 1 ? cache.entries?.[item.id] : null, item.id, now);
      entries[item.id] = record; statuses[item.id] = record.status; metrics.cache_hits++;
    } catch {
      statuses[item.id] = cacheOnly ? 'not_selected' : apiKey ? 'not_selected' : 'not_configured';
      pending.push(item);
    }
  }
  pending.sort(compareForDiscovery);
  if (!cacheOnly && apiKey) for (const item of pending.slice(0, 3)) {
    if (deadline - clock() < requestMs + 1000) break;
    if (metrics.requests) await wait(1000);
    const remaining = deadline - clock();
    if (remaining < requestMs) break;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), requestMs);
    try {
      metrics.requests++;
      const record = normalizeCaptions(await fetcher(item.id, { apiKey, signal: controller.signal }), item.id, now);
      if (controller.signal.aborted) throw new Error('timeout');
      entries[item.id] = record; statuses[item.id] = 'available';
    } catch (error) {
      const code = controller.signal.aborted ? 'timeout' : SAFE_ERRORS.includes(error.message) ? error.message : 'network';
      if (['unavailable', 'pending'].includes(code)) {
        entries[item.id] = { video_id: item.id, status: code, fetched_at: new Date(now).toISOString() }; statuses[item.id] = code;
      } else { statuses[item.id] = 'error'; failure = code; break; }
    } finally { clearTimeout(timeout); }
  }
  metrics.available = Object.values(statuses).filter(status => status === 'available').length;
  return { cache: { version: 1, generated_at: feed.generated_at, entries, statuses }, metrics, failure };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const state = JSON.parse(await readFile('data/feed.json', 'utf8'));
    let cache;
    try { if ((await stat('data/captions-cache.json')).size <= 1024 * 1024) cache = JSON.parse(await readFile('data/captions-cache.json', 'utf8')); } catch { /* An absent or oversized cache is a normal miss. */ }
    const result = await collectCaptions(state.feed, { apiKey: process.env.SUPADATA_API_KEY, cache, cacheOnly: process.argv.includes('--cache-only') });
    const path = 'data/captions-cache.json';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(result.cache) + '\n');
    await rename(`${path}.tmp`, path);
    console.log(JSON.stringify({ captions: result.metrics.available, ...result.metrics, failure: result.failure }));
  } catch {
    console.error('Caption retrieval unavailable; metadata collection is unchanged.');
  }
}

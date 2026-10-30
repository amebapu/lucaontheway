// Version 1 is a frozen public snapshot format, independent of the live feed rules.
import { MAX_ARCHIVE_BYTES, MAX_HISTORY_IDS } from './capacity.mjs';
export const ARCHIVE_TOPICS = { language: '语言互动', movement: '大运动', fine_motor: '精细动作', sensory: '感官盆', art: '美育', reading: '绘本', everyday: '亲子游戏', theory: '陪伴方式' };
export const ARCHIVE_LIMIT = MAX_ARCHIVE_BYTES;
const AGE = 28 * 86400000, SKEW = 5 * 60000;
const fail = () => { throw new Error('archive_invalid'); };
function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail();
  return Date.parse(value);
}
function text(value, limit) { if (typeof value !== 'string' || value.length > limit) fail(); return value; }
function fresh(value, reference) { const time = stamp(value); if (time > reference + SKEW || reference - time >= AGE) fail(); return time; }
function topics(value, limit = 8) {
  if (!Array.isArray(value) || !value.length || value.length > limit || value.some(t => !Object.hasOwn(ARCHIVE_TOPICS, t))) fail();
  return [...new Set(value)];
}
function release(raw, production) {
  if (typeof raw.release_run_id !== 'string' || !(/^[1-9]\d{0,15}$/.test(raw.release_run_id) || (!production && raw.release_run_id === 'preview')) || raw.release_run_attempt !== 1) fail();
  return { release_run_id: raw.release_run_id, release_run_attempt: 1 };
}
function dates(raw, now) {
  const start = stamp(raw.started_at), end = stamp(raw.updated_at);
  if (start > end || end > now + SKEW) fail();
  return { started_at: raw.started_at, updated_at: raw.updated_at };
}
function caption(raw, reference) {
  if (!raw || typeof raw.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(raw.language) || !['full', 'excerpt'].includes(raw.coverage) || !Array.isArray(raw.ranges) || !raw.ranges.length || raw.ranges.length > 3) fail();
  fresh(raw.fetched_at, reference); let end = -1;
  const ranges = raw.ranges.map(range => {
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end < range.start || range.end > 14400 || range.start < end) fail();
    end = range.end; return { start: range.start, end: range.end };
  });
  return { language: raw.language, coverage: raw.coverage, fetched_at: raw.fetched_at, ranges };
}
function point(raw, source, limit = 160) {
  if (!raw || !Number.isSafeInteger(raw.start) || !source.ranges.some(range => raw.start >= Math.floor(range.start) && raw.start <= Math.floor(range.end))) fail();
  const value = text(raw.text, limit); if (!value.trim() || !/[\u3400-\u9fff]/u.test(value)) fail();
  return { text: value, start: raw.start };
}
function analysis(raw, reference) {
  if (!raw || typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(raw.model) || !['metadata', 'captions'].includes(raw.basis) || !['relevant', 'unclear'].includes(raw.relevance) || !Array.isArray(raw.takeaways) || raw.takeaways.length > 2) fail();
  fresh(raw.generated_at, reference);
  const title_zh = text(raw.title_zh, 100), summary = text(raw.summary, 240);
  if (!/[\u3400-\u9fff]/u.test(title_zh) || !/[\u3400-\u9fff]/u.test(summary)) fail();
  const clean = { model: raw.model, basis: raw.basis, generated_at: raw.generated_at, title_zh, summary, takeaways: raw.takeaways.map(value => { const line = text(value, 80); if (!line.trim()) fail(); return line; }), topics: topics(raw.topics, 3), relevance: raw.relevance };
  if (raw.basis === 'captions') {
    clean.caption = caption(raw.caption, reference);
    if (raw.play !== undefined) {
      if (!raw.play) fail();
      const play = { age: raw.play.age === null ? null : point(raw.play.age, clean.caption, 120) };
      for (const [name, limit] of [['materials', 3], ['steps', 4], ['cautions', 3]]) {
        if (!Array.isArray(raw.play[name]) || raw.play[name].length > limit) fail();
        play[name] = raw.play[name].map(value => point(value, clean.caption));
      }
      clean.play = play;
    }
  }
  return clean;
}
function record(raw, start, end) {
  if (!raw || !['discovery', 'channels'].includes(raw.mode) || !['recommended', 'pending'].includes(raw.selection) || typeof raw.description_truncated !== 'boolean') fail();
  const first = stamp(raw.first_archived_at), last = stamp(raw.last_recommended_at), snapshot = stamp(raw.snapshot_at), collected = fresh(raw.collected_at, snapshot);
  if (first < start || first > end || snapshot > first || last < snapshot || last > end) fail();
  const item = raw.item;
  if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(item.id) || typeof item.channel_id !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(item.channel_id)) fail();
  const fetched = fresh(item.fetched_at, snapshot), published = stamp(item.published_at);
  if (fetched > collected + SKEW || published > collected + SKEW || (raw.mode === 'channels' && published < collected - 14 * 86400000 - SKEW)) fail();
  const description = text(item.description, 800), length = Array.from(description).length;
  if (length > 400 || (raw.description_truncated && length !== 400)) fail();
  const clean = { id: item.id, title: text(item.title, 300), description, channel: text(item.channel, 300), channel_id: item.channel_id, published_at: item.published_at, fetched_at: item.fetched_at, topics: topics(item.topics) };
  if (item.topic_basis !== undefined) { if (item.topic_basis !== 'query') fail(); clean.topic_basis = 'query'; }
  if (item.duration_seconds !== undefined) { if (!Number.isSafeInteger(item.duration_seconds) || item.duration_seconds < 1 || item.duration_seconds > 1200) fail(); clean.duration_seconds = item.duration_seconds; }
  if (item.popularity !== undefined) {
    if (!item.popularity || typeof item.popularity !== 'object') fail();
    const popularity = {};
    for (const name of ['view_count', 'like_count']) if (Object.hasOwn(item.popularity, name)) { if (!Number.isSafeInteger(item.popularity[name]) || item.popularity[name] < 0) fail(); popularity[name] = item.popularity[name]; }
    if (!Object.keys(popularity).length) fail(); clean.popularity = popularity;
  }
  if (item.caption_status !== undefined) { if (!['not_configured', 'available', 'unavailable', 'pending', 'error', 'not_selected'].includes(item.caption_status)) fail(); clean.caption_status = item.caption_status; }
  if (Object.hasOwn(item, 'analysis')) clean.analysis = analysis(item.analysis, snapshot);
  return { first_archived_at: raw.first_archived_at, last_recommended_at: raw.last_recommended_at, snapshot_at: raw.snapshot_at, collected_at: raw.collected_at, mode: raw.mode, selection: raw.selection, description_truncated: raw.description_truncated, item: clean };
}
export function parseArchive(raw, now = Date.now(), production = false) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_HISTORY_IDS) fail();
  const times = dates(raw, now), marker = release(raw, production), ids = new Set();
  const records = raw.records.map(value => {
    const clean = record(value, stamp(times.started_at), stamp(times.updated_at));
    if (ids.has(clean.item.id)) fail(); ids.add(clean.item.id); return clean;
  });
  return { version: 1, ...times, ...marker, records };
}
export function advanceArchive(previous, entries, at, runId = 'preview') {
  const now = stamp(at), old = previous === null ? null : parseArchive(previous, now);
  if (old && stamp(old.updated_at) > now) throw new Error('archive_clock');
  const records = new Map((old?.records || []).map(value => [value.item.id, value]));
  for (const entry of entries) {
    const saved = records.get(entry.item.id);
    if (saved) { if (stamp(entry.snapshot_at) > stamp(saved.last_recommended_at)) records.set(entry.item.id, { ...saved, last_recommended_at: entry.snapshot_at }); }
    else {
      const description = Array.from(entry.item.description);
      records.set(entry.item.id, { ...entry, first_archived_at: at, last_recommended_at: entry.snapshot_at, description_truncated: description.length > 400, item: { ...entry.item, description: description.slice(0, 400).join('') } });
    }
  }
  if (records.size > MAX_HISTORY_IDS) throw new Error('archive_capacity');
  return parseArchive({ version: 1, started_at: old?.started_at || at, updated_at: at, release_run_id: runId, release_run_attempt: 1, records: [...records.values()] }, now);
}
export function parseArchiveManifest(raw, now = Date.now(), production = false) {
  if (!raw || raw.version !== 1 || raw.path !== 'archive.json' || !Number.isSafeInteger(raw.item_count) || raw.item_count < 0 || raw.item_count > MAX_HISTORY_IDS || !Number.isSafeInteger(raw.byte_length) || raw.byte_length < 1 || raw.byte_length > ARCHIVE_LIMIT || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) fail();
  return { version: 1, path: 'archive.json', ...dates(raw, now), item_count: raw.item_count, byte_length: raw.byte_length, sha256: raw.sha256, ...release(raw, production) };
}
export async function sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
export async function encodeArchive(archive) {
  const body = JSON.stringify(archive) + '\n', bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > ARCHIVE_LIMIT) throw new Error('archive_capacity');
  return { body, manifest: { version: 1, path: 'archive.json', started_at: archive.started_at, updated_at: archive.updated_at, item_count: archive.records.length, byte_length: bytes.byteLength, sha256: await sha256(bytes), release_run_id: archive.release_run_id, release_run_attempt: 1 } };
}
export async function readArchiveResponse(response, manifest, now = Date.now(), production = false) {
  const header = parseArchiveManifest(manifest, now, production);
  if (!response.ok || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '') || !response.body) throw new Error('archive_http');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > ARCHIVE_LIMIT || length > header.byte_length) throw new Error('archive_size'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (length !== header.byte_length || await sha256(bytes) !== header.sha256) throw new Error('archive_digest');
  let raw; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  const archive = parseArchive(raw, now, production);
  if (archive.records.length !== header.item_count || ['started_at', 'updated_at', 'release_run_id', 'release_run_attempt'].some(key => archive[key] !== header[key])) throw new Error('archive_mismatch');
  return archive;
}
export function filterArchive(records, { topic = 'all', query = '', from = '', to = '' } = {}) {
  const validDay = day => /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if ((from && !validDay(from)) || (to && !validDay(to)) || (from && to && from > to)) throw new Error('archive_date_range');
  const needle = query.trim().toLocaleLowerCase();
  return records.filter(row => {
    const day = new Date(stamp(row.first_archived_at) + 8 * 3600000).toISOString().slice(0, 10), item = row.item, a = item.analysis, p = a?.play;
    const notes = p ? [p.age?.text || '', ...p.materials.map(v => v.text), ...p.steps.map(v => v.text), ...p.cautions.map(v => v.text)].join(' ') : '';
    return (!from || day >= from) && (!to || day <= to) && (topic === 'all' || item.topics.includes(topic)) && `${item.title} ${item.channel} ${item.description} ${a?.title_zh || ''} ${a?.summary || ''} ${a?.takeaways.join(' ') || ''} ${notes} ${item.topics.map(t => ARCHIVE_TOPICS[t]).join(' ')}`.toLocaleLowerCase().includes(needle);
  }).sort((a, b) => stamp(b.last_recommended_at) - stamp(a.last_recommended_at) || stamp(b.first_archived_at) - stamp(a.first_archived_at) || a.item.id.localeCompare(b.item.id));
}

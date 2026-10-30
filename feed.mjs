import { MAX_HISTORY_IDS } from './capacity.mjs';
import { parseArchiveManifest } from './archive.mjs';

export const TOPICS = {
  language: '语言互动', movement: '大运动', fine_motor: '精细动作', sensory: '感官盆',
  art: '美育', reading: '绘本', everyday: '亲子游戏', theory: '陪伴方式',
};
export const MAX_AGE = 28 * 86400000;
export const CLOCK_SKEW = 5 * 60000;
export const CONTENT_MODEL = 'deepseek/deepseek-flash';
export const isRecent = (item, reference) => Date.parse(item.published_at) >= reference - 90 * 86400000;
export const validVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const videoUrl = id => validVideoId(id) ? `https://www.youtube.com/watch?v=${id}` : '';
export const thumbnailUrl = id => validVideoId(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
export const captionUrl = (id, seconds) => validVideoId(id) && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 14400 ? `${videoUrl(id)}&t=${seconds}s` : '';

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) throw new Error('订阅时间格式不正确');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('订阅时间格式不正确');
  return time;
}

function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('订阅文本格式不正确');
  return value;
}

export function parseCaptionProvenance(raw, now = Date.now()) {
  if (!raw || typeof raw.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(raw.language) || !['full', 'excerpt'].includes(raw.coverage) || !Array.isArray(raw.ranges) || !raw.ranges.length || raw.ranges.length > 3) throw new Error('字幕来源格式不正确');
  assertFresh(raw.fetched_at, now);
  let end = -1;
  const ranges = raw.ranges.map(range => {
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end < range.start || range.end > 14400 || range.start < end) throw new Error('字幕时间范围不正确');
    end = range.end;
    return { start: range.start, end: range.end };
  });
  return { language: raw.language, coverage: raw.coverage, fetched_at: raw.fetched_at, ranges };
}

function playPoint(raw, caption, limit = 160) {
  if (!raw || !Number.isSafeInteger(raw.start) || !caption.ranges.some(range => raw.start >= Math.floor(range.start) && raw.start <= Math.floor(range.end))) throw new Error('玩法缺少字幕时间点');
  const value = text(raw.text, limit);
  if (!value.trim() || !/[\u3400-\u9fff]/u.test(value)) throw new Error('玩法缺少中文内容');
  return { text: value, start: raw.start };
}

export function parseAnalysis(raw, now = Date.now()) {
  if (!raw || raw.model !== CONTENT_MODEL || !['metadata', 'captions'].includes(raw.basis) || !['relevant', 'unclear', 'low'].includes(raw.relevance) || !Array.isArray(raw.topics) || !raw.topics.length || raw.topics.length > 3 || raw.topics.some(t => !Object.hasOwn(TOPICS, t)) || !Array.isArray(raw.takeaways) || raw.takeaways.length > 2) throw new Error('中文速览格式不正确');
  assertFresh(raw.generated_at, now);
  const title_zh = text(raw.title_zh, 100), summary = text(raw.summary, 240);
  if (!/[\u3400-\u9fff]/u.test(title_zh) || !/[\u3400-\u9fff]/u.test(summary)) throw new Error('中文速览缺少中文内容');
  const takeaways = raw.takeaways.map(point => { const value = text(point, 80); if (!value.trim()) throw new Error('中文速览要点为空'); return value; });
  const analysis = { model: CONTENT_MODEL, basis: raw.basis, generated_at: raw.generated_at, title_zh, summary, takeaways, topics: [...new Set(raw.topics)], relevance: raw.relevance };
  if (raw.basis === 'captions') {
    analysis.caption = parseCaptionProvenance(raw.caption, now);
    if (raw.play && raw.relevance !== 'low') {
      const play = { age: raw.play.age === null ? null : playPoint(raw.play.age, analysis.caption, 120) };
      for (const [name, limit] of [['materials', 3], ['steps', 4], ['cautions', 3]]) {
        if (!Array.isArray(raw.play[name]) || raw.play[name].length > limit) throw new Error('玩法内容格式不正确');
        play[name] = raw.play[name].map(point => playPoint(point, analysis.caption));
      }
      analysis.play = play;
    }
  }
  return analysis;
}

export function assertFresh(value, now = Date.now()) {
  const time = timestamp(value);
  if (time > now + CLOCK_SKEW) throw new Error('订阅时间超前，请检查设备时钟');
  if (now - time >= MAX_AGE) throw new Error('订阅已超过 28 天，请等待内容更新');
  return time;
}

export function parseFeed(raw, now = Date.now()) {
  if (!raw || raw.schema_version !== 1 || raw.source !== 'youtube' || !['discovery', 'channels'].includes(raw.mode) || !Array.isArray(raw.items) || raw.items.length > 40) {
    throw new Error('订阅数据格式不正确');
  }
  const generated = assertFresh(raw.generated_at, now);
  let discovery;
  if (raw.discovery !== undefined) {
    const value = raw.discovery, classicFirst = value?.strategy === 'classic_first';
    if (raw.mode !== 'discovery' || !value || (value.strategy !== undefined && (!classicFirst || value.total_queries !== 12)) || ![4, 12].includes(value.total_queries) || !Number.isInteger(value.successful_queries) || value.successful_queries < (value.total_queries === 12 ? 8 : 1) || value.successful_queries > value.total_queries || value.failed_queries !== value.total_queries - value.successful_queries || !Number.isInteger(value.recent_successful_queries) || value.recent_successful_queries < 0 || value.recent_successful_queries > (value.total_queries === 12 ? (classicFirst ? 4 : 8) : 2) || !Number.isInteger(value.popular_successful_queries) || value.popular_successful_queries < 0 || value.popular_successful_queries > (value.total_queries === 12 ? (classicFirst ? 8 : 4) : 2) || value.recent_successful_queries + value.popular_successful_queries !== value.successful_queries || value.recent_window_days !== 90) throw new Error('主题检索状态不正确');
    discovery = { total_queries: value.total_queries, successful_queries: value.successful_queries, failed_queries: value.failed_queries, recent_successful_queries: value.recent_successful_queries, popular_successful_queries: value.popular_successful_queries, recent_window_days: 90 };
    if (classicFirst) discovery.strategy = 'classic_first';
    if (value.total_queries === 12) {
      if (![value.unique_videos, value.eligible_videos, value.selected_videos].every(count => Number.isInteger(count) && count >= 0) || value.unique_videos > 300 || value.eligible_videos > value.unique_videos || value.selected_videos > value.eligible_videos || value.selected_videos !== raw.items.length) throw new Error('本批数量不正确');
      Object.assign(discovery, { unique_videos: value.unique_videos, eligible_videos: value.eligible_videos, selected_videos: value.selected_videos });
    }
  }
  let collection;
  if (raw.collection !== undefined) {
    const value = raw.collection;
    if (!value || !Array.isArray(value.succeeded) || !value.succeeded.length || !Array.isArray(value.failed)) throw new Error('来源更新状态不正确');
    const ids = [...value.succeeded, ...value.failed];
    if (ids.length > 10 || ids.some(id => typeof id !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('来源更新状态不正确');
    collection = { succeeded: [...value.succeeded], failed: [...value.failed] };
  }
  const unique = new Map();
  for (const item of raw.items) {
    if (!item || !validVideoId(item.id) || typeof item.channel_id !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(item.channel_id) || !Array.isArray(item.topics) || !item.topics.length || item.topics.some(t => !Object.hasOwn(TOPICS, t))) {
      throw new Error('订阅包含无效视频或主题');
    }
    const fetched = assertFresh(item.fetched_at, now);
    const published = timestamp(item.published_at);
    if (fetched > generated + CLOCK_SKEW || published > generated + CLOCK_SKEW || (raw.mode === 'channels' && published < generated - 14 * 86400000 - CLOCK_SKEW)) throw new Error('视频时间不在本次检索范围内');
    const clean = {
      id: item.id, title: text(item.title, 300), description: text(item.description, 5000),
      channel: text(item.channel, 300), channel_id: item.channel_id,
      published_at: item.published_at, fetched_at: item.fetched_at, topics: [...new Set(item.topics)],
    };
    if (collection && !collection.succeeded.includes(clean.channel_id)) throw new Error('视频来源本批未获取');
    if (item.topic_basis === 'query') clean.topic_basis = 'query';
    if (Number.isSafeInteger(item.duration_seconds) && item.duration_seconds >= 1 && item.duration_seconds <= 1200) clean.duration_seconds = item.duration_seconds;
    const popularity = {};
    for (const name of ['view_count', 'like_count']) if (Number.isSafeInteger(item.popularity?.[name]) && item.popularity[name] >= 0) popularity[name] = item.popularity[name];
    if (Object.keys(popularity).length) clean.popularity = popularity;
    if (['not_configured', 'available', 'unavailable', 'pending', 'error', 'not_selected'].includes(item.caption_status)) clean.caption_status = item.caption_status;
    if (item.analysis) {
      try {
        clean.analysis = parseAnalysis(item.analysis, now);
        clean.topics = [...new Set([...clean.topics, ...clean.analysis.topics])];
      } catch { /* Invalid optional analysis falls back to the original metadata. */ }
    }
    if (unique.has(item.id)) clean.topics = [...new Set([...unique.get(item.id).topics, ...clean.topics])];
    unique.set(item.id, clean);
  }
  const feed = { generated_at: raw.generated_at, mode: raw.mode, items: [...unique.values()].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)) };
  if (discovery?.total_queries === 12 && discovery.selected_videos !== unique.size) throw new Error('本批数量不正确');
  if (collection) feed.collection = collection;
  if (discovery) feed.discovery = discovery;
  if (['ready', 'partial', 'unavailable', 'not_configured', 'cache_only'].includes(raw.enrichment?.status)) feed.enrichment = { status: raw.enrichment.status };
  return feed;
}

export function filterItems(items, topic, query, period = 'all', reference = Date.now()) {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => {
    if (item.analysis?.relevance === 'low') return false;
    if (period !== 'all' && isRecent(item, reference) !== (period === 'recent')) return false;
    const play = item.analysis?.play;
    const notes = play ? [play.age?.text || '', ...play.materials.map(point => point.text), ...play.steps.map(point => point.text), ...play.cautions.map(point => point.text)].join(' ') : '';
    return (topic === 'all' || item.topics.includes(topic)) && `${item.title} ${item.channel} ${item.description} ${item.analysis?.title_zh || ''} ${item.analysis?.summary || ''} ${item.analysis?.takeaways.join(' ') || ''} ${notes} ${item.topics.map(t => TOPICS[t]).join(' ')}`.toLocaleLowerCase().includes(needle);
  });
}

export function curateItems(items, reference) {
  const visible = filterItems(items, 'all', '');
  const relevant = visible.filter(item => item.analysis?.relevance === 'relevant');
  const views = relevant.filter(item => !isRecent(item, reference)).map(item => item.popularity?.view_count).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const middle = Math.floor(views.length / 2);
  const referenceViews = views.length ? (views.length % 2 ? views[middle] : (views[middle - 1] + views[middle]) / 2) : null;
  const recommended = relevant.filter(item => !isRecent(item, reference) || referenceViews === null || (item.popularity?.view_count ?? -1) >= referenceViews);
  const ids = new Set(recommended.map(item => item.id));
  return { recommended, pending: visible.filter(item => !ids.has(item.id)), referenceViews };
}

export function compareForRecommendation(a, b) {
  return Number(b.analysis?.relevance === 'relevant') - Number(a.analysis?.relevance === 'relevant') || (b.popularity?.view_count ?? -1) - (a.popularity?.view_count ?? -1) || (b.popularity?.like_count ?? -1) - (a.popularity?.like_count ?? -1) || Date.parse(b.published_at) - Date.parse(a.published_at) || a.id.localeCompare(b.id);
}

export function compareForDiscovery(a, b) {
  const score = item => item.analysis?.relevance === 'low' ? -1 : Number(/\b(?:play|games?|activities|activity|DIY|sensory|painting|art|puzzle|obstacle|chores|turn[ -]taking|read[ -]aloud)\b/i.test(item.title)) * 2 + Number(/\b(?:one|two|1|2)[ -]year[ -]olds?\b|\b(?:1[2-9]|2[0-4])[ -]months?\b|1[—–-]2\s*岁|1[2-9]\s*个月|2[0-4]\s*个月/i.test(`${item.title} ${item.description.split('\n')[0].slice(0, 250)}`));
  return score(b) - score(a) || (b.popularity?.view_count ?? -1) - (a.popularity?.view_count ?? -1) || (b.popularity?.like_count ?? -1) - (a.popularity?.like_count ?? -1) || Date.parse(b.published_at) - Date.parse(a.published_at) || a.id.localeCompare(b.id);
}

export function beijingDay(value = Date.now()) {
  return new Date((typeof value === 'number' ? value : timestamp(value)) + 8 * 3600000).toISOString().slice(0, 10);
}

function weekDates(now) {
  const today = Date.parse(`${beijingDay(now)}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => new Date(today - (6 - index) * 86400000).toISOString().slice(0, 10));
}

export function parseUpdates(raw, now = Date.now(), production = false) {
  const fail = () => { throw new Error('updates_invalid'); };
  if (!raw || raw.version !== 1 || !Array.isArray(raw.seen_ids) || raw.seen_ids.length > MAX_HISTORY_IDS || raw.seen_ids.some(id => !validVideoId(id)) || new Set(raw.seen_ids).size !== raw.seen_ids.length) fail();
  const started = timestamp(raw.tracked_since), built = timestamp(raw.last_built_at);
  if (started > built || built > now + CLOCK_SKEW || !Number.isSafeInteger(raw.baseline_count) || raw.baseline_count < 0 || raw.baseline_count > raw.seen_ids.length) fail();
  if (typeof raw.release_run_id !== 'string' || !(/^[1-9]\d{0,15}$/.test(raw.release_run_id) || (!production && raw.release_run_id === 'preview')) || raw.release_run_attempt !== 1) fail();
  if (!Array.isArray(raw.days) || !raw.days.length || raw.days.length > 7) fail();
  const first = weekDates(built)[0], last = beijingDay(built), start = beijingDay(started), days = [];
  let total = 0;
  for (const row of raw.days) {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(row.date) || !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date || row.date < first || row.date < start || row.date > last || (days.length && row.date <= days.at(-1).date) || !Number.isSafeInteger(row.new_count) || row.new_count < 0 || row.new_count > MAX_HISTORY_IDS) fail();
    total += row.new_count; days.push({ date: row.date, new_count: row.new_count });
  }
  if (days.at(-1).date !== last || total > raw.seen_ids.length - raw.baseline_count) fail();
  return { version: 1, tracked_since: new Date(started).toISOString(), last_built_at: new Date(built).toISOString(), baseline_count: raw.baseline_count, seen_ids: [...raw.seen_ids], days, release_run_id: raw.release_run_id, release_run_attempt: 1 };
}

export function advanceUpdates(previous, items, at = new Date().toISOString(), runId = 'preview') {
  const now = timestamp(at), current = [...new Set(filterItems(items, 'all', '').map(item => item.id))];
  if (current.some(id => !validVideoId(id))) throw new Error('updates_invalid');
  const old = previous === null ? null : parseUpdates(previous, now);
  if (old && timestamp(old.last_built_at) > now) throw new Error('updates_clock');
  const seen = new Set(old?.seen_ids || current), counts = new Map(old?.days.map(day => [day.date, day.new_count]));
  let added = 0;
  for (const id of current) if (!seen.has(id)) { seen.add(id); added++; }
  if (seen.size > MAX_HISTORY_IDS) throw new Error('updates_capacity');
  const day = beijingDay(now); counts.set(day, (counts.get(day) || 0) + added);
  const first = weekDates(now)[0];
  return parseUpdates({ version: 1, tracked_since: old?.tracked_since || at, last_built_at: at, baseline_count: old?.baseline_count ?? current.length, seen_ids: [...seen].sort(), days: [...counts].filter(([date]) => date >= first).sort(([a], [b]) => a.localeCompare(b)).map(([date, new_count]) => ({ date, new_count })), release_run_id: runId, release_run_attempt: 1 }, now);
}

export function parsePublication(raw, now = Date.now(), production = false) {
  const fail = () => { throw new Error('updates_invalid'); };
  if (!raw || typeof raw !== 'object') fail();
  const generated = timestamp(raw.site_generated_at);
  if (generated > now + CLOCK_SKEW) fail();
  const updates = raw.updates === undefined ? null : parseUpdates(raw.updates, now, production);
  const archive = raw.archive === undefined ? null : parseArchiveManifest(raw.archive, now, production);
  if (!updates) { if (raw.publication !== undefined || archive) fail(); return { site_generated_at: raw.site_generated_at, updates: null, archive: null, publication: null, legacy: true }; }
  const value = raw.publication;
  let publication;
  if (value === undefined) publication = { version: 1, release_run_id: updates.release_run_id, release_run_attempt: 1, history_status: 'current' };
  else {
    if (!value || value.version !== 1 || typeof value.release_run_id !== 'string' || !(/^[1-9]\d{0,15}$/.test(value.release_run_id) || (!production && value.release_run_id === 'preview')) || value.release_run_attempt !== 1 || !['current', 'capacity_paused'].includes(value.history_status)) fail();
    publication = { version: 1, release_run_id: value.release_run_id, release_run_attempt: 1, history_status: value.history_status };
    if (value.history_status === 'capacity_paused') {
      if (!archive || !['archive_capacity', 'updates_capacity', 'publication_capacity'].includes(value.capacity_reason)) fail();
      publication.capacity_reason = value.capacity_reason;
    } else if (value.capacity_reason !== undefined) fail();
  }
  if (timestamp(updates.last_built_at) > generated) fail();
  if (publication.history_status === 'current' && (updates.last_built_at !== raw.site_generated_at || updates.release_run_id !== publication.release_run_id || updates.release_run_attempt !== publication.release_run_attempt)) fail();
  if (archive && (archive.updated_at !== updates.last_built_at || archive.release_run_id !== updates.release_run_id || archive.release_run_attempt !== updates.release_run_attempt)) fail();
  return { site_generated_at: raw.site_generated_at, updates, archive, publication, legacy: value === undefined };
}

export function calendarWeek(updates, now = Date.now(), context = null) {
  return weekDates(now).map((date, index) => {
    const record = updates?.days.find(day => day.date === date);
    if (updates && context?.publication?.history_status === 'capacity_paused') {
      const last = beijingDay(updates.last_built_at);
      if (date > last || (date === last && date === beijingDay(context.site_generated_at))) return { date, today: index === 6, count: null, recorded_count: record?.new_count ?? null, status: 'capacity_unknown' };
    }
    return { date, today: index === 6, count: record?.new_count ?? null, status: !updates ? 'unavailable' : record ? 'recorded' : date < beijingDay(updates.tracked_since) ? 'unrecorded' : index === 6 ? 'pending' : 'missed' };
  });
}


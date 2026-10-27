export const TOPICS = {
  language: '语言互动', movement: '大运动', fine_motor: '精细动作', sensory: '感官盆',
  art: '美育', reading: '绘本', everyday: '亲子游戏', theory: '早教理论',
};
export const MAX_AGE = 28 * 86400000;
export const CLOCK_SKEW = 5 * 60000;
export const CONTENT_MODEL = 'deepseek/deepseek-flash';
export const validVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const videoUrl = id => validVideoId(id) ? `https://www.youtube.com/watch?v=${id}` : '';
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
    if (fetched > generated + CLOCK_SKEW || published > generated + CLOCK_SKEW || published < generated - 14 * 86400000 - CLOCK_SKEW) throw new Error('视频时间不在本次检索范围内');
    const clean = {
      id: item.id, title: text(item.title, 300), description: text(item.description, 5000),
      channel: text(item.channel, 300), channel_id: item.channel_id,
      published_at: item.published_at, fetched_at: item.fetched_at, topics: [...new Set(item.topics)],
    };
    if (collection && !collection.succeeded.includes(clean.channel_id)) throw new Error('视频来源本批未获取');
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
  if (collection) feed.collection = collection;
  if (['ready', 'partial', 'unavailable', 'not_configured', 'cache_only'].includes(raw.enrichment?.status)) feed.enrichment = { status: raw.enrichment.status };
  return feed;
}

export function filterItems(items, topic, query) {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => {
    const play = item.analysis?.play;
    const notes = play ? [play.age?.text || '', ...play.materials.map(point => point.text), ...play.steps.map(point => point.text), ...play.cautions.map(point => point.text)].join(' ') : '';
    return (topic === 'all' || item.topics.includes(topic)) && `${item.title} ${item.channel} ${item.description} ${item.analysis?.title_zh || ''} ${item.analysis?.summary || ''} ${item.analysis?.takeaways.join(' ') || ''} ${notes} ${item.topics.map(t => TOPICS[t]).join(' ')}`.toLocaleLowerCase().includes(needle);
  });
}


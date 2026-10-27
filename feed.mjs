export const TOPICS = {
  language: '语言互动', movement: '大运动', fine_motor: '精细动作', sensory: '感官盆',
  art: '美育', reading: '绘本', everyday: '亲子游戏', theory: '早教理论',
};
export const MAX_AGE = 28 * 86400000;
export const CLOCK_SKEW = 5 * 60000;
export const validVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const videoUrl = id => validVideoId(id) ? `https://www.youtube.com/watch?v=${id}` : '';

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) throw new Error('日报时间格式不正确');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('日报时间格式不正确');
  return time;
}

function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('日报文本格式不正确');
  return value;
}

export function assertFresh(value, now = Date.now()) {
  const time = timestamp(value);
  if (time > now + CLOCK_SKEW) throw new Error('日报时间超前，请检查本机时钟');
  if (now - time >= MAX_AGE) throw new Error('日报已超过 28 天，请重新采集并清理旧下载文件');
  return time;
}

export function parseFeed(raw, now = Date.now()) {
  if (!raw || raw.schema_version !== 1 || raw.source !== 'youtube' || !['discovery', 'channels'].includes(raw.mode) || !Array.isArray(raw.items) || raw.items.length > 40) {
    throw new Error('请选择采集器生成的 feed.json；上传检查收据不是日报');
  }
  const generated = assertFresh(raw.generated_at, now);
  const unique = new Map();
  for (const item of raw.items) {
    if (!item || !validVideoId(item.id) || typeof item.channel_id !== 'string' || !/^UC[A-Za-z0-9_-]{22}$/.test(item.channel_id) || !Array.isArray(item.topics) || !item.topics.length || item.topics.some(t => !Object.hasOwn(TOPICS, t))) {
      throw new Error('日报包含无效视频或主题');
    }
    const fetched = assertFresh(item.fetched_at, now);
    const published = timestamp(item.published_at);
    if (fetched > generated + CLOCK_SKEW || published > generated + CLOCK_SKEW || published < generated - 14 * 86400000 - CLOCK_SKEW) throw new Error('视频时间不在本次检索范围内');
    const clean = {
      id: item.id, title: text(item.title, 300), description: text(item.description, 5000),
      channel: text(item.channel, 300), channel_id: item.channel_id,
      published_at: item.published_at, fetched_at: item.fetched_at, topics: [...new Set(item.topics)],
    };
    if (unique.has(item.id)) clean.topics = [...new Set([...unique.get(item.id).topics, ...clean.topics])];
    unique.set(item.id, clean);
  }
  return { generated_at: raw.generated_at, mode: raw.mode, items: [...unique.values()].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)) };
}

export function filterItems(items, topic, query) {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => (topic === 'all' || item.topics.includes(topic)) && `${item.title} ${item.channel} ${item.description} ${item.topics.map(t => TOPICS[t]).join(' ')}`.toLocaleLowerCase().includes(needle));
}


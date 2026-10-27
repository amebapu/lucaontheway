import { TOPICS, parseFeed, filterItems, assertFresh, videoUrl } from './feed.mjs';

const $ = selector => document.querySelector(selector);
let feed = null, topic = 'all', latestRequest = 0;
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function link(label, href) { const el = element('a', 'text-link', label); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; return el; }
function fresh() {
  if (!feed) return;
  try { assertFresh(feed.generated_at); }
  catch { feed = null; $('#status-text').textContent = '旧列表已过期'; $('#status-detail').textContent = '请等待订阅更新；专题来源仍可直接浏览。'; $('#status-dot').classList.remove('ready'); }
}
function switchView(view) {
  document.querySelectorAll('[data-view]').forEach(el => { const active = el.dataset.view === view; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#feed-view').hidden = view !== 'feed'; $('#sources-view').hidden = view !== 'sources';
  render();
}
function makeCard(item) {
  const card = element('article', 'card');
  const head = element('div', `card-top ${item.topics[0]}`);
  head.append(element('span', '', item.topics.map(t => TOPICS[t]).join(' · ')), element('small', '', 'YouTube'));
  const body = element('div', 'card-body');
  body.append(element('h3', '', item.title), element('p', 'byline', `${item.channel} · ${new Date(item.published_at).toLocaleDateString('zh-CN')}`), element('p', 'description', item.description || '此条没有简介，可直接打开原视频。'));
  body.append(element('p', 'card-flag', '关键词初筛 · 月龄与具体做法请看原片核对'));
  const actions = element('div', 'card-actions');
  actions.append(link('看原视频 ↗', videoUrl(item.id)), link('看这个频道 ↗', `https://www.youtube.com/channel/${item.channel_id}`));
  body.append(actions); card.append(head, body); return card;
}
function render() {
  fresh();
  $('#feed-count').textContent = feed?.items.length || 0;
  const items = filterItems(feed?.items || [], topic, $('#search').value);
  const cards = $('#cards'); cards.replaceChildren(...items.map(makeCard));
  $('#result-count').textContent = `${items.length} 条内容 · 原视频阅读入口`;
  $('#empty').hidden = items.length > 0;
  $('#empty-title').textContent = feed ? '这次还没有匹配的内容' : '内容的位置，已经留好了';
  $('#empty-copy').textContent = feed ? '换个主题或关键词试试。\n没有合适的新内容时不凑数，也可以从精选来源继续看。' : '订阅更新后会在这里展示真实内容。\n先从精选来源寻找1—2岁陪伴的灵感。';
}
async function loadFeed() {
  const serial = ++latestRequest;
  try {
    const response = await fetch('/api/feed', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('订阅暂时不可用，请稍后刷新；精选来源仍可浏览。');
    const state = await response.json();
    if (serial !== latestRequest) return;
    const sources = $('#subscribed-channels'); sources.replaceChildren();
    for (const channel of state.channels) { const li = element('li'); li.append(link(channel.name, `https://www.youtube.com/channel/${channel.id}`), element('small', '', ` · ${channel.topics.map(t => TOPICS[t]).join(' / ')}`)); sources.append(li); }
    feed = state.feed ? parseFeed(state.feed) : null;
    $('#status-dot').classList.toggle('ready', !!feed && state.refresh?.status === 'ok');
    $('#status-text').textContent = feed ? '已载入最新内容' : '尚无有效订阅列表';
    $('#status-detail').textContent = feed ? `上次更新：${new Date(feed.generated_at).toLocaleString('zh-CN', { hour12: false })} · 最近14天发布` : '尚未首次采集或旧列表已过期，可先浏览精选来源。';
    $('#collection-detail').textContent = '每天北京时间约06:17更新频道。标题和简介按主题关键词初筛，月龄与具体做法仍需回源核对。';
    if (state.refresh?.status === 'failed') { $('#status-text').textContent = feed ? '更新失败，保留上次有效列表' : '本次更新未成功'; $('#status-dot').classList.remove('ready'); $('#collection-detail').textContent = '上次更新未成功。持续失败请检查或替换频道；超过28天会停止展示旧列表。'; }
    if (state.refresh?.status === 'running') $('#status-text').textContent = '订阅正在更新';
    render();
  } catch (error) {
    if (serial !== latestRequest) return;
    $('#status-text').textContent = '订阅连接不可用'; $('#status-detail').textContent = error instanceof SyntaxError ? '订阅数据格式不正确，请稍后刷新。' : error.message;
    $('#status-dot').classList.remove('ready'); render();
  }
}
$('#refresh').addEventListener('click', async () => { $('#refresh').disabled = true; try { await loadFeed(); } finally { $('#refresh').disabled = false; } });
$('#setup').addEventListener('click', () => switchView('sources'));
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => switchView(el.dataset.view)));
document.querySelectorAll('[data-topic]').forEach(el => el.addEventListener('click', () => { topic = el.dataset.topic; document.querySelectorAll('[data-topic]').forEach(chip => { const selected = chip === el; chip.classList.toggle('selected', selected); chip.setAttribute('aria-pressed', String(selected)); }); render(); }));
$('#search').addEventListener('input', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void loadFeed(); } });
setInterval(() => { if (feed) { try { assertFresh(feed.generated_at); } catch { render(); } } }, 60000);
render(); await loadFeed();

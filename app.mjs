import { TOPICS, parseFeed, filterItems, assertFresh, videoUrl, captionUrl, thumbnailUrl, compareForDiscovery, isRecent } from './feed.mjs';

const $ = selector => document.querySelector(selector);
let feed = null, channels = [], topic = 'all', period = 'all', latestRequest = 0;
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function link(label, href) { const el = element('a', 'text-link', label); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; return el; }
function beijingTime(value) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function clockTime(seconds) { const value = Math.floor(seconds); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }
function playNote(item, play) {
  const details = element('details', 'original play-note'); details.append(element('summary', '', '字幕里的玩法笔记'));
  const point = (tag, value) => { const line = element(tag, '', `${value.text} `); line.append(link(`原片 ${clockTime(value.start)} ↗`, captionUrl(item.id, value.start))); return line; };
  details.append(element('h4', '', '字幕中的月龄说明'));
  details.append(play.age ? point('p', play.age) : element('p', '', '本次字幕未提供明确月龄，不能确认适合12—24个月。'));
  for (const [name, title, empty] of [
    ['materials', '本次字幕提到的材料', '本次读取的字幕未提供材料清单。'],
    ['steps', '本次字幕提到的步骤', '本次读取的字幕未提供可提炼的具体步骤。'],
    ['cautions', '本次字幕提到的注意事项', '本次读取的字幕未提供注意事项，不代表原片没有说明，也不代表没有风险。'],
  ]) {
    details.append(element('h4', '', title));
    if (play[name].length) { const list = element(name === 'steps' ? 'ol' : 'ul'); list.append(...play[name].map(value => point('li', value))); details.append(list); }
    else details.append(element('p', '', empty));
  }
  return details;
}
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
  const analysis = item.analysis, channelName = channels.find(channel => channel.id === item.channel_id)?.name || item.channel;
  const image = element('img', 'card-preview');
  image.alt = `${item.title} · 原视频预览图`; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.width = 480; image.height = 270;
  image.addEventListener('error', () => image.remove()); image.src = thumbnailUrl(item.id);
  body.append(element('h3', '', analysis?.title_zh || item.title), element('p', 'byline', channelName), element('p', 'byline', `作者发布：${beijingTime(item.published_at)}（北京时间）`));
  body.append(element('p', 'card-flag', isRecent(item, Date.parse(feed.generated_at)) ? '近期 · 采集时90天内发布' : '经典参考 · 采集时90天前发布'));
  const count = value => value === undefined ? '暂不可用' : value.toLocaleString('zh-CN');
  body.append(element('p', 'byline', `${item.duration_seconds ? `时长 ${clockTime(item.duration_seconds)} · ` : ''}播放 ${count(item.popularity?.view_count)} · 赞 ${count(item.popularity?.like_count)}（本批快照）`));
  if (item.topic_basis === 'query') body.append(element('p', 'card-flag', '主题按检索词推断，具体玩法与月龄待核对。'));
  if (analysis) {
    body.append(element('p', 'ai-summary', analysis.summary));
    if (analysis.takeaways.length) {
      const points = element('ul', 'ai-points'); points.append(...analysis.takeaways.map(point => element('li', '', point))); body.append(points);
    }
    const relevance = { relevant: '主题与1—2岁陪伴相关（AI初筛）', unclear: '月龄或相关性尚不明确', low: '相关度较低，请自行取舍' }[analysis.relevance];
    body.append(element('p', 'card-flag', `${analysis.basis === 'captions' ? '字幕速览（仅文本，未看画面）' : '标题与简介速览'} · ${relevance}`), element('p', 'byline', `概要生成：${beijingTime(analysis.generated_at)}（北京时间）`));
    if (analysis.caption) {
      const ranges = analysis.caption.ranges.map(range => `${clockTime(range.start)}–${clockTime(range.end)}`).join('、');
      body.append(element('p', 'byline', `${analysis.caption.language} · ${analysis.caption.coverage === 'full' ? '本次字幕轨全部读入' : '字幕片段'} · 已读 ${ranges}`));
      if (analysis.play && (analysis.play.age || analysis.play.materials.length || analysis.play.steps.length || analysis.play.cautions.length)) body.append(playNote(item, analysis.play));
    }
    const original = element('details', 'original');
    original.append(element('summary', '', '原文标题与简介'), element('p', '', item.title), element('p', '', item.description || '原片没有提供简介。')); body.append(original);
  } else {
    const pending = ['unavailable', 'partial'].includes(feed?.enrichment?.status) ? '中文速览暂不可用' : feed?.enrichment?.status === 'not_configured' ? '尚未启用中文速览' : '尚未生成速览';
    body.append(element('p', 'description', item.description || '此条没有简介，可直接打开原视频。'), element('p', 'card-flag', `${pending} · 当前显示原文 · 月龄与做法请看原片核对`));
  }
  if (analysis?.basis !== 'captions' && item.caption_status) {
    const message = { not_configured: '字幕尚未接通，当前依据标题与简介。', available: '字幕已获取，速览尚未使用字幕。', unavailable: '本次未获取到可用字幕。', pending: '字幕服务尚未返回可用文本。', error: '本次字幕获取暂不可用。', not_selected: '本次未读取字幕。' }[item.caption_status];
    body.append(element('p', 'card-flag', message));
  }
  const actions = element('div', 'card-actions');
  actions.append(link('看原视频 ↗', videoUrl(item.id)), link('看这个频道 ↗', `https://www.youtube.com/channel/${item.channel_id}`));
  body.append(actions); card.append(image, head, body); return card;
}
function render() {
  fresh();
  const visible = filterItems(feed?.items || [], 'all', '');
  $('#feed-count').textContent = visible.length;
  const reference = feed ? Date.parse(feed.generated_at) : Date.now();
  const items = filterItems(visible, topic, $('#search').value, period, reference).sort((a, b) => Number(isRecent(b, reference)) - Number(isRecent(a, reference)) || compareForDiscovery(a, b));
  const cards = $('#cards'); cards.replaceChildren(...items.map(makeCard));
  $('#result-count').textContent = `当前筛选 ${items.length} 条 · 近期优先，同档参考玩法与热度`;
  const analyzed = visible.filter(item => item.analysis).length;
  const subtitles = visible.filter(item => item.analysis?.basis === 'captions').length;
  const hidden = (feed?.items.length || 0) - visible.length;
  const recent = visible.filter(item => isRecent(item, reference)).length;
  const discovery = feed?.discovery;
  const funnel = discovery?.total_queries === 12 ? `检索去重 ${discovery.unique_videos} → 规则通过 ${discovery.eligible_videos} → 本批入选 ${discovery.selected_videos}。` : `本批入选 ${feed?.items.length || 0} 条。`;
  $('#batch-detail').textContent = feed ? `${funnel} AI低相关隐藏 ${hidden} 条，可见 ${visible.length} 条（采集时近90天 ${recent} / 经典 ${visible.length - recent}）。${recent ? '' : ' 本批未选到近期内容，可先看经典参考。'}` : '正在读取本批数量。';
  $('#analysis-detail').textContent = (analyzed ? `${analyzed}/${visible.length} 条已有中文速览 · 其中 ${subtitles} 条依据字幕，其余依据标题与简介。` : visible.length ? '可见内容尚未生成中文速览，当前显示原文；可先按主题筛选。' : feed ? '本批没有可见推荐。' : '中文速览尚未生成。') + (hidden ? ` 已隐藏 ${hidden} 条AI低相关候选。` : '') + (visible.some(item => item.caption_status === 'not_configured') ? ' 字幕尚未接通。' : '');
  $('#empty').hidden = items.length > 0;
  $('#empty-title').textContent = feed ? '这次还没有匹配的内容' : '内容的位置，已经留好了';
  $('#empty-copy').textContent = feed ? '换个主题或关键词试试。\n没有合适的新内容时不凑数，也可以从精选来源继续看。' : '订阅更新后会在这里展示真实内容。\n先从精选来源寻找1—2岁陪伴的灵感。';
}
async function loadFeed() {
  const serial = ++latestRequest;
  try {
    const response = await fetch('./feed.json', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('订阅暂时不可用，请稍后刷新；精选来源仍可浏览。');
    const state = await response.json();
    if (serial !== latestRequest) return;
    feed = state.feed ? parseFeed(state.feed) : null;
    let siteTime = '本站更新时间暂不可用';
    try { assertFresh(state.site_generated_at); siteTime = `本站更新：${beijingTime(state.site_generated_at)}（本批页面生成时间，北京时间）`; } catch { /* Older deployments may not include a page generation timestamp. */ }
    $('#site-updated-at').textContent = `${siteTime} · 自动更新：每天北京时间06:17，排程可能延迟`;
    channels = state.channels;
    const sources = $('#subscribed-channels'); sources.replaceChildren();
    $('#sources-heading').textContent = feed?.mode === 'discovery' ? '本批发现的作者' : '订阅频道';
    for (const channel of channels) { const li = element('li'), failed = feed?.collection?.failed.includes(channel.id); li.append(link(channel.name, `https://www.youtube.com/channel/${channel.id}`), element('small', '', ` · ${channel.topics.map(t => TOPICS[t]).join(' / ')}${failed ? ' · 本批未获取，旧条目暂不展示' : ''}`)); sources.append(li); }
    $('#status-dot').classList.toggle('ready', !!feed);
    $('#status-text').textContent = feed ? (feed.collection?.failed.length || feed.discovery?.failed_queries ? '部分检索已更新' : '已载入亲子灵感') : '尚无有效订阅列表';
    const coverage = feed?.discovery ? ` · 近期检索 ${feed.discovery.recent_successful_queries}/${feed.discovery.total_queries === 12 ? 8 : 2} · 热门检索 ${feed.discovery.popular_successful_queries}/${feed.discovery.total_queries === 12 ? 4 : 2}${feed.discovery.failed_queries ? ' · 本批查询不完整' : ''}` : feed?.collection ? ` · ${feed.collection.succeeded.length}/${channels.length} 个来源已获取` : '';
    $('#status-detail').textContent = feed ? `上次成功采集：${beijingTime(feed.generated_at)}（北京时间） · ${feed.mode === 'discovery' ? '采集前90天近期 + 热门经典' : '最近14天发布'}${coverage}` : '尚未首次采集或旧列表已过期，可先浏览精选来源。';
    $('#collection-detail').textContent = `计划每天北京时间06:17更新一次，GitHub 排程可能延迟或漏跑。${feed?.mode === 'discovery' ? '每天检索全部8个近期玩法方向与4个热门经典方向，经典方向两天轮换覆盖8个主题，每组最多25个结果。每批最多40条入选、20位作者，每位作者最多2条；优先分配近期24条、经典16条，不足时互相补位。经典可能重复，本批条数不等于今日新增。检索成功不足8组、入选或可见不足16条时保留上次网站和时刻；运行结果可在更新记录查看。' : '个别来源失败时更新其他来源，全部失败则保留上次网站。'} 超过28天停止展示旧列表。`;
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
document.querySelectorAll('[data-period]').forEach(el => el.addEventListener('click', () => { period = el.dataset.period; document.querySelectorAll('[data-period]').forEach(chip => { const selected = chip === el; chip.classList.toggle('selected', selected); chip.setAttribute('aria-pressed', String(selected)); }); render(); }));
$('#search').addEventListener('input', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void loadFeed(); } });
setInterval(() => { if (feed) { try { assertFresh(feed.generated_at); } catch { render(); } } }, 60000);
render(); await loadFeed();

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, assertFresh, filterItems, videoUrl, thumbnailUrl, compareForDiscovery, MAX_AGE, CLOCK_SKEW } from './feed.mjs';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const stamp = offset => new Date(NOW + offset).toISOString();
const item = (overrides = {}) => ({ id: 'SYNTHETIC01', title: '<script>Synthetic test only</script>', description: 'Language play', channel: 'Synthetic channel', channel_id: `UC${'A'.repeat(22)}`, topics: ['language'], published_at: stamp(-86400000), fetched_at: stamp(0), ...overrides });
const feed = (items = [item()]) => ({ schema_version: 1, source: 'youtube', mode: 'discovery', generated_at: stamp(0), items });

test('only constructed video links are used; HTML stays ordinary text', () => {
  const result = parseFeed(feed([item({ url: 'javascript:alert(1)' })]), NOW);
  assert.equal(result.items[0].title, '<script>Synthetic test only</script>');
  assert.equal(result.items[0].url, undefined);
  assert.equal(videoUrl(result.items[0].id), 'https://www.youtube.com/watch?v=SYNTHETIC01');
  assert.equal(videoUrl('javascript:alert(1)'), '');
});
test('duplicates merge topics without manufacturing more candidates', () => {
  const result = parseFeed(feed([item(), item({ topics: ['theory'] })]), NOW);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].topics, ['language', 'theory']);
});
test('28-day expiration and five-minute clock tolerance are enforced', () => {
  assert.throws(() => assertFresh(stamp(-MAX_AGE), NOW), /28/);
  assert.throws(() => assertFresh(stamp(CLOCK_SKEW + 1000), NOW), /超前/);
  assert.equal(assertFresh(stamp(CLOCK_SKEW), NOW), NOW + CLOCK_SKEW);
});
test('fresh envelope cannot hide expired metadata or future publication', () => {
  assert.throws(() => parseFeed(feed([item({ fetched_at: stamp(-MAX_AGE) })]), NOW), /28/);
  assert.throws(() => parseFeed(feed([item({ published_at: stamp(CLOCK_SKEW + 1000) })]), NOW), /范围/);
});
test('tampered schema, ids, topics, types and oversized feeds are rejected', () => {
  const bad = [null, { purpose: 'upload-check' }, feed([item({ id: '../secrets' })]), feed([item({ title: {} })]), feed([item({ topics: ['constructor'] })]), feed([item({ channel_id: 'wrong' })]), feed(Array.from({ length: 41 }, () => item()))];
  for (const data of bad) assert.throws(() => parseFeed(data, NOW));
});
test('zero results remain a valid empty feed', () => assert.equal(parseFeed(feed([]), NOW).items.length, 0));
test('topic and keyword filters combine and ignore case', () => {
  const items = [item(), item({ id: 'SYNTHETIC02', title: 'Book time', topics: ['reading'] })];
  assert.equal(filterItems(items, 'all', ' BOOK ').length, 1);
  assert.equal(filterItems(items, 'language', 'book').length, 0);
  assert.equal(filterItems(items, 'language', 'PLAY').length, 1);
  assert.equal(filterItems(items, 'all', '语言').length, 1);
});
test('freshly discovered classics retain author dates while RSS keeps its fourteen-day window', () => {
  const classic = item({ published_at: stamp(-365 * 86400000) });
  assert.equal(parseFeed(feed([classic]), NOW).items[0].published_at, classic.published_at);
  assert.throws(() => parseFeed({ ...feed([classic]), mode: 'channels' }, NOW), /范围/);
  assert.throws(() => parseFeed(feed([classic]), NOW + MAX_AGE), /28/);
});
test('public whitelist retains only safe optional popularity, duration and query provenance', () => {
  const source = item({ popularity: { view_count: 0, like_count: 123, private_note: 'SYNTHETIC_PRIVATE_MARKER' }, duration_seconds: 1200, topic_basis: 'query', thumbnail: 'https://untrusted.example.test/' });
  const clean = parseFeed(feed([source]), NOW).items[0];
  assert.deepEqual(clean.popularity, { view_count: 0, like_count: 123 }); assert.equal(clean.duration_seconds, 1200); assert.equal(clean.topic_basis, 'query'); assert.equal(clean.thumbnail, undefined);
  for (const bad of [-1, Infinity, '42', 1.5, 9007199254740992]) assert.equal(parseFeed(feed([item({ popularity: { view_count: bad }, duration_seconds: bad })]), NOW).items[0].popularity, undefined);
  assert.equal(parseFeed(feed([item({ duration_seconds: 1201 })]), NOW).items[0].duration_seconds, undefined);
  assert.equal(thumbnailUrl('SYNTHETIC01'), 'https://i.ytimg.com/vi/SYNTHETIC01/hqdefault.jpg');
  for (const id of ['invalid', '../unsafe', 'javascript:alert(1)']) assert.equal(thumbnailUrl(id), '');
});
test('query coverage is whitelisted and cannot pretend incomplete results were complete', () => {
  const discovery = { total_queries: 4, successful_queries: 3, failed_queries: 1, recent_successful_queries: 1, popular_successful_queries: 2, recent_window_days: 90 };
  assert.deepEqual(parseFeed({ ...feed(), discovery: { ...discovery, private_note: 'SYNTHETIC_PRIVATE_MARKER' } }, NOW).discovery, discovery);
  for (const patch of [{ successful_queries: 0 }, { failed_queries: 0 }, { recent_successful_queries: 2 }, { recent_window_days: 14 }, { popular_successful_queries: 3 }]) assert.throws(() => parseFeed({ ...feed(), discovery: { ...discovery, ...patch } }, NOW), /检索/);
});
test('browsing hides AI low candidates without treating unanalysed previews as low', () => {
  const low = item({ analysis: { relevance: 'low', takeaways: [] } });
  assert.deepEqual(filterItems([low, item({ id: 'SYNTHETIC02' })], 'all', '').map(value => value.id), ['SYNTHETIC02']);
});
test('play and explicit age precede popularity; missing counts differ from real zero and low stays last', () => {
  const ranked = [
    item({ id: 'SYNTHETIC01', title: 'An announcement', description: '', popularity: { view_count: 99999999 } }),
    item({ id: 'SYNTHETIC02', title: 'Toddler play', description: '', popularity: { view_count: 99999 } }),
    item({ id: 'SYNTHETIC03', title: 'Play for a 1-year-old', description: '' }),
    item({ id: 'SYNTHETIC04', title: 'Play for a 1-year-old', description: '', popularity: { view_count: 0, like_count: 0 } }),
    item({ id: 'SYNTHETIC05', title: 'Play for a 1-year-old', description: '', popularity: { view_count: 0, like_count: 1 } }),
    item({ id: 'SYNTHETIC06', title: 'Play for a 1-year-old', description: '', popularity: { view_count: 99999999 }, analysis: { relevance: 'low' } }),
  ];
  assert.deepEqual(ranked.sort(compareForDiscovery).map(value => value.id), ['SYNTHETIC05', 'SYNTHETIC04', 'SYNTHETIC03', 'SYNTHETIC02', 'SYNTHETIC01', 'SYNTHETIC06']);
});


test('publication period combines with topics and search against the fixed collection time', () => {
  const recent = item({ id: 'SYNTHETIC01', title: 'Tape game', published_at: stamp(-90 * 86400000) });
  const classic = item({ id: 'SYNTHETIC02', title: 'Tape game', published_at: stamp(-90 * 86400000 - 1), topics: ['art'] });
  assert.deepEqual(filterItems([recent, classic], 'all', 'tape', 'recent', NOW).map(value => value.id), [recent.id]);
  assert.deepEqual(filterItems([recent, classic], 'art', 'tape', 'classic', NOW).map(value => value.id), [classic.id]);
  assert.deepEqual(filterItems([recent, classic], 'language', '', 'classic', NOW), []);
});


test('expanded discovery counts are whitelisted and agree with selected unique items', () => {
  const items = Array.from({ length: 16 }, (_, index) => item({ id: `F${String(index).padStart(10, '0')}` }));
  const discovery = { total_queries: 12, successful_queries: 12, failed_queries: 0, recent_successful_queries: 8, popular_successful_queries: 4, recent_window_days: 90, unique_videos: 100, eligible_videos: 60, selected_videos: 16 };
  const raw = { ...feed(items), discovery: { ...discovery, private_note: 'SYNTHETIC_PRIVATE_MARKER' } };
  assert.deepEqual(parseFeed(raw, NOW).discovery, discovery);
  for (const patch of [{ unique_videos: 301 }, { unique_videos: 59 }, { eligible_videos: 15 }, { selected_videos: 15 }, { selected_videos: 16.5 }, { successful_queries: 7, failed_queries: 5, recent_successful_queries: 4, popular_successful_queries: 3 }, { recent_successful_queries: 9, popular_successful_queries: 3 }]) assert.throws(() => parseFeed({ ...raw, discovery: { ...discovery, ...patch } }, NOW));
  assert.throws(() => parseFeed({ ...raw, items: [...items.slice(0, 15), items[0]] }, NOW), /数量/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, assertFresh, filterItems, videoUrl, MAX_AGE, CLOCK_SKEW } from './feed.mjs';

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

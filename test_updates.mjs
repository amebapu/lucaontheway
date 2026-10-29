import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { advanceUpdates, parseUpdates, calendarWeek, beijingDay } from './feed.mjs';
import { restoreUpdates, publicationContext, bootstrapAllowed, BOOTSTRAP_PARENT_SHA, REPOSITORY, RUNS_URL, PAGE_FEED_URL } from './scripts/updates.mjs';

const NOW = Date.parse('2026-06-15T04:00:00.000Z'), at = offset => new Date(NOW + offset).toISOString();
const PRE_CALENDAR_SHA = '560e7657dc4bf8bc86da1eb36160bf9adf4ec27f';
const item = (index, relevance) => ({ id: `V${String(index).padStart(10, '0')}`, title: 'Synthetic play', description: '', topics: ['everyday'], ...(relevance ? { analysis: { relevance, takeaways: [] } } : {}) });
const ctx = { run_id: '300', sha: 'b'.repeat(40), event: 'push', ref: 'refs/heads/main', attempt: 1 };
const event = { before: PRE_CALENDAR_SHA, after: ctx.sha, ref: ctx.ref };
const run = (id = 100, patch = {}) => ({ id, run_attempt: 1, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', path: '.github/workflows/checks.yml', repository: { full_name: REPOSITORY }, head_sha: PRE_CALENDAR_SHA, created_at: at(-30000), updated_at: at(-10000), ...patch });
const history = (id = '100', time = at(-20000)) => advanceUpdates(null, [item(0)], time, id);
const reply = value => new Response(JSON.stringify(value));
const page = updates => ({ feed: { schema_version: 1, source: 'youtube', mode: 'channels', generated_at: at(-20000), items: [{ ...item(0), channel_id: `UC${'A'.repeat(22)}`, channel: 'Synthetic source', fetched_at: at(-20000), published_at: at(-20000) }] }, site_generated_at: updates?.last_built_at || at(-20000), ...(updates === undefined ? {} : { updates }) });
const restore = (fetcher, options = {}) => restoreUpdates(ctx, { token: 'SYNTHETIC_TOKEN', event, fetcher, now: NOW, wait: async () => {}, ...options });

test('first visible IDs form a zero-new baseline and low items stay excluded', () => {
  const value = advanceUpdates(null, [item(0), item(1, 'low'), item(0)], at(0), '100');
  assert.equal(value.baseline_count, 1); assert.deepEqual(value.seen_ids, [item(0).id]);
  assert.equal(value.days[0].new_count, 0); assert.equal(value.tracked_since, at(0));
  assert.equal(value.last_built_at, at(0));
  const later = advanceUpdates(value, [{ ...item(99), published_at: '2010-01-01T00:00:00.000Z' }], at(1000), '101');
  assert.equal(later.days.at(-1).new_count, 1);
});

test('same-day additions accumulate while repeats, promotion and reappearance are not new', () => {
  const base = advanceUpdates(null, [item(0)], at(0), '100');
  const first = advanceUpdates(base, [item(0, 'relevant'), item(1), item(2, 'low')], at(1000), '101');
  assert.equal(first.days.at(-1).new_count, 1);
  const second = advanceUpdates(first, [item(0), item(3)], at(2000), '102');
  const repeated = advanceUpdates(second, [item(1, 'relevant'), item(0), item(3)], at(3000), '103');
  assert.equal(repeated.days.at(-1).new_count, 2);
  assert.deepEqual(repeated.seen_ids, [item(0).id, item(1).id, item(3).id]);
  assert.equal(repeated.tracked_since, base.tracked_since);
});

test('Beijing midnight creates a new day and a repeat-only successful day records real zero', () => {
  const before = '2026-01-31T15:59:59.000Z', after = '2026-01-31T16:00:01.000Z';
  assert.equal(beijingDay(before), '2026-01-31'); assert.equal(beijingDay(after), '2026-02-01');
  const base = advanceUpdates(null, [item(0)], before, '100');
  const next = advanceUpdates(base, [item(0)], after, '101');
  assert.deepEqual(next.days, [{ date: '2026-01-31', new_count: 0 }, { date: '2026-02-01', new_count: 0 }]);
  assert.equal(calendarWeek(next, Date.parse(after)).at(-1).count, 0);
});

test('only seven natural dates are kept while old seen IDs remain remembered', () => {
  const start = '2026-01-01T00:00:00.000Z';
  const base = advanceUpdates(null, [item(0)], start, '100');
  const added = advanceUpdates(base, [item(1)], '2026-01-02T00:00:00.000Z', '101');
  const next = advanceUpdates(added, [item(0), item(1), item(2)], '2026-01-10T00:00:00.000Z', '102');
  assert.deepEqual(next.days, [{ date: '2026-01-10', new_count: 1 }]);
  assert.equal(next.seen_ids.length, 3);
  const days = calendarWeek(next, Date.parse('2026-01-11T00:00:00.000Z'));
  assert.equal(days.length, 7); assert.equal(days[0].date, '2026-01-05');
  assert.equal(days[0].status, 'missed'); assert.equal(days.at(-1).status, 'pending');
  assert.equal(days.at(-1).count, null);
});

test('pre-tracking and unavailable dates remain distinct from recorded zero', () => {
  const value = history('100', at(0)), days = calendarWeek(value, NOW);
  assert.ok(days.slice(0, 6).every(day => day.status === 'unrecorded' && day.count === null));
  assert.equal(days.at(-1).count, 0);
  assert.ok(calendarWeek(null, NOW).every(day => day.status === 'unavailable' && day.count === null));
});

test('history schema rejects invalid IDs, markers, dates, counts and backward time; extra fields are stripped', () => {
  const base = history();
  for (const patch of [{ seen_ids: ['bad'] }, { seen_ids: [item(0).id, item(0).id] }, { release_run_id: 'preview' }, { release_run_attempt: undefined }, { release_run_attempt: 2 }, { baseline_count: -1 }, { baseline_count: 2 }, { days: [{ date: '2026-02-31', new_count: 0 }] }, { days: [{ ...base.days[0], new_count: 1 }] }, { last_built_at: at(600000) }]) assert.throws(() => parseUpdates({ ...base, ...patch }, NOW, true));
  const clean = parseUpdates({ ...base, private_note: 'SYNTHETIC_PRIVATE_MARKER', days: base.days.map(row => ({ ...row, private_note: 'SYNTHETIC_PRIVATE_MARKER' })) }, NOW, true);
  assert.equal(JSON.stringify(clean).includes('SYNTHETIC_PRIVATE_MARKER'), false);
  assert.throws(() => advanceUpdates(base, [item(0)], at(-21000), '101'), /updates_clock/);
  const preview = advanceUpdates(null, [item(0)], at(0));
  assert.throws(() => parseUpdates(preview, NOW, true));
});

test('the permanent seen-ID limit fails rather than evicting old IDs', () => {
  const base = history(); base.seen_ids = Array.from({ length: 50000 }, (_, index) => item(index).id); base.baseline_count = 50000;
  assert.equal(parseUpdates(base, NOW, true).seen_ids.length, 50000);
  assert.throws(() => advanceUpdates(base, [item(50000)], at(0), '101'), /updates_capacity/);
});

test('unsupported production branch, event and rerun are rejected before I/O', async () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: ctx.ref, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: ctx.run_id, GITHUB_SHA: ctx.sha };
  assert.equal(publicationContext({}), null); assert.equal(publicationContext(env).run_id, '300');
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REPOSITORY: 'another/repository' }, { GITHUB_SHA: 'invalid' }]) assert.throws(() => publicationContext({ ...env, ...patch }), /updates_context/);
  await assert.rejects(restoreUpdates({ ...ctx, ref: 'refs/heads/feature' }, { token: 'SYNTHETIC_TOKEN', fetcher: () => assert.fail('No request expected') }), /updates_context/);
});

test('one-time bootstrap requires the exact initial main push and pre-calendar source SHA', () => {
  assert.equal(bootstrapAllowed(ctx, event, run()), true);
  for (const context of [{ ...ctx, event: 'schedule' }, { ...ctx, event: 'workflow_dispatch' }, { ...ctx, attempt: 2 }, { ...ctx, ref: 'refs/heads/feature' }]) assert.equal(bootstrapAllowed(context, event, run()), false);
  for (const patch of [{ before: 'a'.repeat(40) }, { after: 'a'.repeat(40) }, { ref: 'refs/heads/feature' }]) assert.equal(bootstrapAllowed(ctx, { ...event, ...patch }, run()), false);
  assert.equal(bootstrapAllowed(ctx, event, run(100, { head_sha: 'a'.repeat(40) })), false);
});

test('matching deployed history restores with authentication only on the fixed GitHub origin', async () => {
  const calls = [], value = history();
  const result = await restore(async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    if (url.startsWith(RUNS_URL)) { assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC_TOKEN'); return reply({ workflow_runs: [run()] }); }
    assert.ok(url.startsWith(PAGE_FEED_URL)); assert.equal(options.headers.Authorization, undefined);
    return reply(page({ ...value, private_note: 'SYNTHETIC_PRIVATE_MARKER' }));
  });
  assert.equal(calls.length, 2); assert.deepEqual(result.updates, value);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_TOKEN'), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_MARKER'), false);
});

test('documented main workflow path references restore while other files and refs are rejected', async () => {
  for (const path of ['.github/workflows/checks.yml', '.github/workflows/checks.yml@main', '.github/workflows/checks.yml@refs/heads/main', `.github/workflows/checks.yml@${PRE_CALENDAR_SHA}`]) {
    const result = await restore(async url => reply(url.startsWith(RUNS_URL) ? { workflow_runs: [run(100, { path })] } : page(history())));
    assert.equal(result.updates.release_run_id, '100');
  }
  for (const path of ['.github/workflows/other.yml@main', '.github/workflows/checks.yml@feature', '.github/workflows/checks.yml@refs/tags/main', `.github/workflows/checks.yml@${'c'.repeat(40)}`]) await assert.rejects(restore(async () => reply({ workflow_runs: [run(100, { path })] })), /updates_source_invalid/);
});

test('observed history is never discarded when the next response is legacy or conflicting', async () => {
  for (const second of [page(), page(history())]) {
    let pages = 0, calls = 0;
    await assert.rejects(restore(async url => {
      calls++;
      if (url.includes('/workflows/')) return reply({ workflow_runs: [run()] });
      if (url.startsWith(PAGE_FEED_URL)) return reply(++pages === 1 ? page(history('200', at(-5000))) : second);
      assert.fail('Conflicting reads must fail before a marker lookup or initialization');
    }), /updates_stale/);
    assert.equal(calls, 3); assert.equal(pages, 2);
  }
});

test('legacy is retried and can initialize only once; stale legacy after calendar never resets', async () => {
  let calls = 0; const waits = [];
  const result = await restore(async url => { calls++; return reply(url.startsWith(RUNS_URL) ? { workflow_runs: [run()] } : page()); }, { wait: async ms => waits.push(ms) });
  assert.equal(calls, 3); assert.deepEqual(waits, [2000]); assert.equal(result.bootstrap.before, BOOTSTRAP_PARENT_SHA);
  for (const source of [run(100, { head_sha: 'a'.repeat(40) }), run()]) {
    await assert.rejects(restore(async url => reply(url.startsWith(RUNS_URL) ? { workflow_runs: [source] } : page()), { event: { ...event, before: 'a'.repeat(40) } }), /updates_bootstrap/);
  }
  await assert.rejects(restore(async url => reply(url.startsWith(RUNS_URL) ? { workflow_runs: [run(100, { head_sha: 'a'.repeat(40) })] } : page())), /updates_bootstrap/);
});

test('a newer already-published failed or cancelled attempt survives, but older and unknown sources fail', async () => {
  for (const conclusion of ['failure', 'cancelled', 'success']) {
    const value = history('200', at(-5000));
    const result = await restore(async url => {
      if (url.includes('/workflows/')) return reply({ workflow_runs: [run(200, { run_attempt: 2 }), run()] });
      if (url.startsWith(PAGE_FEED_URL)) return reply(page(value));
      assert.equal(url, `${RUNS_URL}/runs/200/attempts/1`);
      return reply(run(200, { conclusion, created_at: at(-9000), updated_at: at(-1000) }));
    });
    assert.equal(result.updates.release_run_id, '200');
  }
  for (const candidate of [run(90, { conclusion: 'failure', updated_at: at(-20000) }), run(90, { head_branch: 'feature' }), run(90, { run_attempt: 2 })]) {
    await assert.rejects(restore(async url => reply(url.includes('/workflows/') ? { workflow_runs: [run()] } : url.startsWith(PAGE_FEED_URL) ? page(history('90')) : candidate)));
  }
});

test('published-source clock allowance is bounded to five seconds', async () => {
  for (const [built, accepted] of [[-1000 + 5000, true], [-1000 + 5001, false]]) {
    const promise = restore(async url => reply(url.includes('/workflows/') ? { workflow_runs: [run()] } : url.startsWith(PAGE_FEED_URL) ? page(history('200', at(built))) : run(200, { created_at: at(-9000), updated_at: at(-1000) })));
    if (accepted) assert.equal((await promise).updates.release_run_id, '200'); else await assert.rejects(promise, /updates_stale/);
  }
});

test('malformed/oversized/unavailable sources stop without raw error text or empty fallback', async () => {
  const cases = [
    [async () => new Response('SYNTHETIC_PRIVATE_MARKER', { status: 403 }), /updates_http/],
    [async () => { throw new Error('SYNTHETIC_PRIVATE_MARKER'); }, /updates_network/],
    [async () => new Response('x'.repeat(256 * 1024 + 1)), /updates_size/],
    [async () => reply({ workflow_runs: [] }), /updates_source_invalid/],
    [async url => reply(url.includes('/workflows/') ? { workflow_runs: [run()] } : page({ ...history(), release_run_attempt: undefined })), /updates_invalid/],
  ];
  for (const [fetcher, pattern] of cases) await assert.rejects(restore(fetcher), error => pattern.test(error.message) && !error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  let time = 0, calls = 0;
  await assert.rejects(restore(async (url, { signal }) => {
    calls++; if (url.includes('/workflows/')) { time = 27999; return reply({ workflow_runs: [run()] }); }
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SYNTHETIC_PRIVATE_MARKER')), { once: true }));
  }, { clock: () => time }), /updates_timeout/);
  assert.equal(calls, 2);
});

test('every deploy-capable workflow event restores first and failed gates cannot become green no-ops', async () => {
  const workflow = await readFile(new URL('.github/workflows/checks.yml', import.meta.url), 'utf8');
  const restore = workflow.slice(workflow.indexOf('- name: Restore update history'), workflow.indexOf('- run: npm run collect'));
  assert.match(restore, /if: github.event_name != 'pull_request'/); assert.doesNotMatch(restore, /continue-on-error|github.ref/);
  assert.ok(workflow.indexOf('npm run check') < workflow.indexOf('npm run updates') && workflow.indexOf('npm run updates') < workflow.indexOf('npm run collect'));
  assert.match(workflow, /build:\n    permissions:\n      contents: read\n      actions: read/);
  assert.match(workflow, /deploy:\n    if: github.event_name != 'pull_request'\n    needs: build/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  const collector = await readFile(new URL('scripts/collect.mjs', import.meta.url), 'utf8');
  assert.match(collector, /process.exitCode = 1/);
});

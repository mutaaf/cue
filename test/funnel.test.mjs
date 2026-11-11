import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, CONTRACTS, APP_SOURCES } from '../src/contracts.mjs';
import { funnel } from '../src/bus.mjs';
import { plan, MARK, LABEL } from '../scripts/cross-app-issues.mjs';

const err = (data, src = 'cold-gas') => validate({ type: 'app.error', data: { app: 'cold-gas', kind: 'render', fingerprint: 'a1b2c3d4', ...data } }, src);
const step = (s, src = 'cold-gas') => validate({ type: 'app.funnel', data: { app: 'cold-gas', step: s } }, src);

test('app.error and app.funnel are contracts, normal priority, from app producers only', () => {
  assert.equal(CONTRACTS['app.error'].priority, 'normal');
  assert.deepEqual(CONTRACTS['app.funnel'].sources, APP_SOURCES);
  assert.deepEqual(err({}), { ok: true, priority: 'normal' });
  for (const s of ['opened', 'started', 'finished']) assert.equal(step(s).ok, true);
});
test('a service, the operator or another source may not publish app events', () => {
  for (const src of ['operator', 'prompter', 'cast-list', 'github', 'lobby']) { assert.match(err({}, src).why, /may not publish/); assert.match(step('opened', src).why, /may not publish/); }
});
test('a funnel step outside opened, started, finished is refused', () => {
  for (const s of ['clicked', 'Opened', 'opened ', 'paid']) assert.match(step(s).why, /must match/);
});
test('an error carries no text a person could have typed', () => {
  assert.match(err({ fingerprint: 'TypeError: cannot read name of Alice' }).why, /must match/);
  assert.match(err({ fingerprint: 'abc' }).why, /must match/);
  assert.match(err({ kind: 'Could not save your note' }).why, /must match/);
  assert.match(err({ app: 'Cold Gas!' }).why, /must match/);
  assert.match(validate({ type: 'app.error', data: { app: 'cold-gas', kind: 'x', fingerprint: 'a1b2c3d4', message: 'hi' } }, 'cold-gas').why, /not in the/);
});

function fakeDB(rows) {
  const seen = [];
  return { seen, DB: { prepare: (sql) => ({ bind(...a) { seen.push({ sql, a }); return this; }, async all() { return { results: sql.includes("'app.funnel'") ? rows.funnel : rows.errors }; } }) } };
}
test('funnel counts per app per step and groups error fingerprints across apps', async () => {
  const env = fakeDB({
    funnel: [{ app: 'kin', step: 'opened', n: 9 }, { app: 'kin', step: 'finished', n: 2 }, { app: 'cold-gas', step: 'started', n: 4 }],
    errors: [{ fingerprint: 'fp000001', kind: 'net', app: 'kin', n: 3, last: '2026-11-10T01:00:00Z' }, { fingerprint: 'fp000001', kind: 'net', app: 'cold-gas', n: 2, last: '2026-11-11T01:00:00Z' }, { fingerprint: 'fp000002', kind: 'render', app: 'kin', n: 7, last: '2026-11-09T00:00:00Z' }],
  });
  const r = await funnel(env, 7, Date.parse('2026-11-11T12:00:00Z'));
  assert.equal(r.days, 7);
  assert.equal(r.since, '2026-11-04T12:00:00.000Z');
  assert.deepEqual(r.funnel, { kin: { opened: 9, started: 0, finished: 2 }, 'cold-gas': { opened: 0, started: 4, finished: 0 } });
  assert.deepEqual(r.errors[0], { fingerprint: 'fp000001', kind: 'net', apps: ['cold-gas', 'kin'], count: 5, last: '2026-11-11T01:00:00Z' });
  assert.equal(r.errors[1].fingerprint, 'fp000002');
  assert.ok(env.seen.every((q) => q.a[0] === r.since));
});
test('funnel clamps days to 1..90', async () => {
  for (const [given, want] of [[0, 7], [-3, 1], [500, 90], ['x', 7], ['30', 30]]) assert.equal((await funnel(fakeDB({ funnel: [], errors: [] }), given)).days, want);
});

const g = (fp, apps = ['kin'], last = '2026-11-11T00:00:00Z') => ({ fingerprint: fp, kind: 'net', apps, count: 3, last });
test('one issue per fingerprint: create when new, update when it changed, nothing when it did not', () => {
  const first = plan([g('fp000001'), g('fp000002', ['cold-gas', 'kin'])], []);
  assert.deepEqual(first.map((a) => a.op), ['create', 'create']);
  assert.ok(first[1].title.includes('fp000002') && first[1].title.includes('cold-gas, kin'));
  assert.ok(first[0].body.startsWith(MARK('fp000001')));
  const issues = first.map((a, n) => ({ number: n + 1, state: 'open', title: a.title, body: a.body }));
  assert.deepEqual(plan([g('fp000001'), g('fp000002', ['cold-gas', 'kin'])], issues), []);
  const again = plan([g('fp000001', ['kin', 'hinge-pop'])], issues);
  assert.deepEqual(again.map((a) => [a.op, a.number]), [['update', 1]]);
  assert.equal(LABEL, 'cross-app');
});
test('no error groups, no issues; a closed issue reopens only when the error came back after closing', () => {
  assert.deepEqual(plan([], [{ number: 1, state: 'open', title: 't', body: MARK('fp000001') }]), []);
  const closed = { number: 4, state: 'closed', closed_at: '2026-11-10T00:00:00Z', title: 'x', body: MARK('fp000001') };
  assert.deepEqual(plan([g('fp000001', ['kin'], '2026-11-09T00:00:00Z')], [closed]), []);
  assert.deepEqual(plan([g('fp000001', ['kin'], '2026-11-11T00:00:00Z')], [closed]).map((a) => [a.op, a.reopen]), [['update', true]]);
});

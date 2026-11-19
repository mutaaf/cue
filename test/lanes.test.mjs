import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, consume, dispatch, deliver, sweep, backoff, subscribersFor } from '../src/bus.mjs';
import { fakeEnv, msg } from './fake.mjs';

const ping = { type: 'ops.test.ping', data: { note: 'hi' } };
const ctx = () => { const c = { jobs: [], waitUntil(p) { c.jobs.push(p); } }; return c; };
const settle = (c) => Promise.all(c.jobs);
const sub = (name, run = async () => {}, extra = {}) => ({ name, wants: () => true, run, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('with a context, a publish is logged and delivered at once, with no queue hop', async () => {
  const e = fakeEnv(), c = ctx(); let ran = 0;
  const r = await publish(e, ping, 'x', Date.now(), c, [sub('s', async () => { ran++; })]);
  assert.equal(r.path, 'inline'); await settle(c);
  assert.equal(ran, 1); assert.equal(e.s.sent.length, 0); assert.equal(e.s.events.size, 1);
  const d = e.s.deliveries.get(`${r.id}|s`); assert.equal(d.status, 'ok'); assert.equal(d.path, 'inline'); assert.ok(d.ms < 1000);
});
test('subscribers run side by side, not one after another', async () => {
  const e = fakeEnv(), c = ctx(), t = Date.now();
  await publish(e, ping, 'x', t, c, [sub('a', () => wait(60)), sub('b', () => wait(60)), sub('c', () => wait(60))]); await settle(c);
  assert.ok(Date.now() - t < 150, `took ${Date.now() - t} ms`);
});
test('a subscriber that fails inline is queued for just itself, after a minute', async () => {
  const e = fakeEnv(), c = ctx(); let a = 0;
  await publish(e, ping, 'x', Date.now(), c, [sub('a', async () => { a++; }), sub('b', async () => { throw new Error('down'); })]); await settle(c);
  assert.equal(a, 1); assert.equal(e.s.sent.length, 1); assert.deepEqual(e.s.sent[0].only, ['b']); assert.equal(e.s.sent[0].via, 'retry'); assert.equal(e.s.opts.delaySeconds, 60);
});
test('a long job takes the queue lane at once and never runs inline', async () => {
  const e = fakeEnv(), c = ctx(); let n = 0;
  await publish(e, ping, 'x', Date.now(), c, [sub('slow', async () => { n++; }, { queue: true })]); await settle(c);
  assert.equal(n, 0); assert.deepEqual(e.s.sent[0].only, ['slow']); assert.equal(e.s.sent[0].via, 'deferred');
});
test('a contract delay still goes through the queue', async () => {
  const e = fakeEnv(), c = ctx();
  const r = await publish(e, { type: 'repo.pushed', data: { repo: 'r', branch: 'main' } }, 'github', Date.now(), c, [sub('s')]);
  assert.equal(r.path, 'queue'); assert.equal(e.s.opts.delaySeconds, 240); assert.equal(c.jobs.length, 0);
});
test('if the log cannot be written, the event falls back to the queue', async () => {
  const e = fakeEnv(), c = ctx(); e.DB.batch = async () => { throw new Error('D1 down'); };
  const r = await publish(e, ping, 'x', Date.now(), c, [sub('s')]);
  assert.equal(r.ok, true); assert.equal(r.path, 'queue'); assert.equal(e.s.sent.length, 1);
});
test('a subscriber that hangs is cut off and counted as failed', async () => {
  const e = fakeEnv(), ev = { id: 'h', type: 'ops.test.ping', time: new Date().toISOString(), data: {} };
  const r = await deliver(e, ev, [sub('hang', () => new Promise(() => {}))], 'inline', 30);
  assert.deepEqual(r.failed, ['hang']); assert.match(e.s.deliveries.get('h|hang').error, /took over/);
});
test('a queued message runs only the subscribers it names', async () => {
  const e = fakeEnv(); let a = 0, b = 0; const m = msg({ id: 'q', type: 'ops.test.ping', time: new Date().toISOString(), data: {}, only: ['b'], via: 'retry' });
  await consume({ messages: [m] }, e, [sub('a', async () => { a++; }), sub('b', async () => { b++; })]);
  assert.equal(a, 0); assert.equal(b, 1); assert.equal(m.acked, true); assert.equal(e.s.deliveries.get('q|b').path, 'retry');
});
test('the inline lane reaches D1 once before delivering a fresh event', async () => {
  const e = fakeEnv(), c = ctx(); let batches = 0, reads = 0; const batch = e.DB.batch, prepare = e.DB.prepare;
  e.DB.batch = (x) => { batches++; return batch(x); }; e.DB.prepare = (sql) => { const st = prepare(sql); if (sql.startsWith('SELECT')) reads++; return st; };
  await publish(e, ping, 'x', Date.now(), c, [sub('s')]);
  assert.equal(batches, 1); await settle(c); assert.equal(reads, 0); assert.equal(batches, 2);
});
test('a normal event past the daily limit is shed on the inline lane too, and leaves no log row', async () => {
  const e = fakeEnv({ count: 2400 }), c = ctx(); let n = 0;
  const r = await publish(e, ping, 'x', Date.now(), c, [sub('s', async () => { n++; })]); await settle(c);
  assert.equal(r.shed, true); assert.equal(n, 0); assert.equal(e.s.events.size, 0); assert.equal(e.s.shed, 1);
});
test('retries back off: one minute, four, then fifteen', () => { assert.equal(backoff(1), 60); assert.equal(backoff(2), 240); assert.equal(backoff(3), 900); assert.equal(backoff(9), 900); });
test('a failed queued message retries with that backoff', async () => {
  const e = fakeEnv(), m = msg({ id: 'f', type: 'ops.test.ping', time: 't', data: {} }, 2); let delay;
  m.retry = (o) => { m.retried = true; delay = o.delaySeconds; };
  await consume({ messages: [m] }, e, [sub('s', async () => { throw new Error('x'); })]);
  assert.equal(delay, 240);
});
test('the inline lane never runs a subscriber that already succeeded for that id', async () => {
  const e = fakeEnv(), c = ctx(); let n = 0; const subs = [sub('s', async () => { n++; })];
  const a = await publish(e, { ...ping, id: 'same' }, 'x', Date.now(), c, subs), b = await publish(e, { ...ping, id: 'same' }, 'x', Date.now(), c, subs); await settle(c);
  assert.equal(n, 1); assert.equal(a.path, 'inline'); assert.equal(b.path, 'duplicate');
});
test('two copies of one id in a batch deliver once', async () => {
  const e = fakeEnv(); let n = 0; const body = { id: 'd', type: 'ops.test.ping', time: new Date().toISOString(), data: {} };
  await consume({ messages: [msg(body), msg({ ...body })] }, e, [sub('s', async () => { await wait(10); n++; })]);
  assert.equal(n, 1);
});
test('`only` narrows the subscribers but never widens them', () => {
  const subs = [{ name: 'a', wants: () => true }, { name: 'b', wants: () => false }];
  assert.deepEqual(subscribersFor({ only: ['a', 'b'] }, subs).map((s) => s.name), ['a']);
});

// The sweep, against a D1 stand-in that answers its two reads.
function sweepEnv(events, oks) {
  const sent = [];
  const prepare = (sql) => ({ bind() { return this; }, async all() { return { results: sql.startsWith('SELECT * FROM events') ? events : oks }; } });
  return { sent, DB: { prepare }, EVENTS: { sendBatch: async (ms) => { for (const m of ms) sent.push(m.body); } } };
}
const row = (id, type = 'cue.clock.hourly') => ({ id, type, source: 'cue', time: 't', priority: 'normal', data: '{"hour":"01"}', received: 'r' });
test('the sweep resends an event only for the subscribers that never succeeded', async () => {
  const env = sweepEnv([row('c1'), row('c2')], [{ event_id: 'c1', subscriber: 'a' }, { event_id: 'c1', subscriber: 'b' }, { event_id: 'c2', subscriber: 'a' }]);
  const r = await sweep(env, [sub('a'), sub('b'), sub('sweep')]);
  assert.equal(r.swept, 1); assert.equal(env.sent[0].id, 'c2'); assert.deepEqual(env.sent[0].only, ['b']); assert.equal(env.sent[0].via, 'sweep'); assert.equal(env.sent[0].replay, undefined);
});
test('the sweep never resends to itself', async () => { const env = sweepEnv([row('c1')], [{ event_id: 'c1', subscriber: 'a' }]); assert.equal((await sweep(env, [sub('a'), sub('sweep')])).swept, 0); });
test('a dispatch with nothing to do sends nothing', async () => { const e = fakeEnv(); const r = await dispatch(e, { id: 'n', type: 'ops.test.ping', data: {} }, []); assert.deepEqual(r, { failed: [], deferred: [] }); assert.equal(e.s.sent.length, 0); });

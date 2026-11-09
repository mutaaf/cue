import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, consume, consumeDead, NORMAL_DAILY_LIMIT, sourceForToken, sha256, describe } from '../src/bus.mjs';

// A small D1 stand-in that knows only the statements the bus runs.
function fakeEnv({ count = 0 } = {}) {
  const s = { count, shed: 0, events: new Map(), deliveries: new Map(), dead: new Map(), sent: [] };
  const prepare = (sql) => {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (sql.startsWith('INSERT INTO budget')) { s.count++; return { count: s.count }; }
        if (sql.startsWith('SELECT 1 FROM deliveries')) { const d = s.deliveries.get(st.args.join('|')); return d?.status === 'ok' ? {} : null; }
        return null; },
      async run() {
        if (sql.startsWith('UPDATE budget')) s.shed++;
        if (sql.startsWith('INSERT OR IGNORE INTO events') && !s.events.has(st.args[0])) s.events.set(st.args[0], st.args);
        if (sql.startsWith('INSERT INTO deliveries')) s.deliveries.set(`${st.args[0]}|${st.args[1]}`, { status: st.args[2] });
        if (sql.startsWith('INSERT OR IGNORE INTO dead')) s.dead.set(st.args[0], st.args);
      } };
    return st;
  };
  return { s, DB: { prepare }, EVENTS: { send: async (m) => s.sent.push(m) } };
}
const msg = (body, attempts = 1) => { const m = { body, attempts, acked: false, retried: false, ack() { m.acked = true; }, retry() { m.retried = true; } }; return m; };
const ev = (id = 'e1') => ({ id, type: 'ops.test.ping', source: 'x', time: 't', priority: 'normal', data: { note: 'n' } });
const ping = { type: 'ops.test.ping', data: { note: 'hi' } };
const alert = { type: 'ops.test.alert', data: { note: 'hi' } };

test('publish sends a stamped event to the queue', async () => { const e = fakeEnv(); const r = await publish(e, ping, 'x'); assert.equal(r.ok, true); assert.equal(e.s.sent[0].source, 'x'); assert.ok(e.s.sent[0].time); });
test('the publisher cannot set its own source', async () => { const e = fakeEnv(); await publish(e, { ...ping, source: 'lobby' }, 'x'); assert.equal(e.s.sent[0].source, 'x'); });
test('an invalid event reaches nothing', async () => { const e = fakeEnv(); const r = await publish(e, { type: 'nope', data: {} }, 'x'); assert.equal(r.status, 400); assert.equal(e.s.sent.length, 0); assert.equal(e.s.count, 0); });
test('normal events are shed past the daily limit', async () => { const e = fakeEnv({ count: NORMAL_DAILY_LIMIT }); const r = await publish(e, ping, 'x'); assert.equal(r.shed, true); assert.equal(e.s.sent.length, 0); assert.equal(e.s.shed, 1); });
test('critical events are never shed', async () => { const e = fakeEnv({ count: NORMAL_DAILY_LIMIT + 500 }); const r = await publish(e, alert, 'operator'); assert.equal(r.shed, undefined); assert.equal(e.s.sent.length, 1); });
test('the limit leaves room inside the free plan', () => assert.ok(NORMAL_DAILY_LIMIT * 3 < 10000 * 0.75));

test('a clean event is logged, delivered and acked', async () => { const e = fakeEnv(), m = msg(ev()); let ran = 0; await consume({ messages: [m] }, e, [{ name: 's', wants: () => true, run: async () => { ran++; } }]); assert.equal(ran, 1); assert.equal(e.s.events.size, 1); assert.equal(m.acked, true); });
test('a failing subscriber retries the message and records why', async () => { const e = fakeEnv(), m = msg(ev()); await consume({ messages: [m] }, e, [{ name: 's', wants: () => true, run: async () => { throw new Error('down'); } }]); assert.equal(m.retried, true); assert.equal(m.acked, false); assert.equal(e.s.deliveries.get('e1|s').status, 'failed'); });
test('a retry reruns only the subscriber that failed', async () => {
  const e = fakeEnv(); let a = 0, b = 0, fail = true;
  const subs = [{ name: 'a', wants: () => true, run: async () => { a++; } }, { name: 'b', wants: () => true, run: async () => { b++; if (fail) throw new Error('x'); } }];
  await consume({ messages: [msg(ev())] }, e, subs); fail = false; const m2 = msg(ev(), 2); await consume({ messages: [m2] }, e, subs);
  assert.equal(a, 1); assert.equal(b, 2); assert.equal(m2.acked, true);
});
test('a redelivered event does not alert twice', async () => { const e = fakeEnv(); let n = 0; const subs = [{ name: 's', wants: () => true, run: async () => { n++; } }]; await consume({ messages: [msg(ev())] }, e, subs); await consume({ messages: [msg(ev())] }, e, subs); assert.equal(n, 1); assert.equal(e.s.events.size, 1); });
test('one bad message does not sink the batch', async () => { const e = fakeEnv(), bad = msg(ev('bad')), good = msg(ev('good')); await consume({ messages: [bad, good] }, e, [{ name: 's', wants: (x) => x.id === 'bad', run: async () => { throw new Error('x'); } }]); assert.equal(bad.retried, true); assert.equal(good.acked, true); });
test('only interested subscribers run', async () => { const e = fakeEnv(); let n = 0; await consume({ messages: [msg(ev())] }, e, [{ name: 's', wants: () => false, run: async () => { n++; } }]); assert.equal(n, 0); });
test('dead letters are kept and a person is told', async () => { const e = fakeEnv(), m = msg(ev()); const told = []; await consumeDead({ messages: [m] }, e, async (s) => told.push(s)); assert.equal(e.s.dead.size, 1); assert.equal(told.length, 1); assert.equal(m.acked, true); });
test('a failed alert does not lose the dead letter', async () => { const e = fakeEnv(), m = msg(ev()); await consumeDead({ messages: [m] }, e, async () => { throw new Error('mail down'); }); assert.equal(e.s.dead.size, 1); assert.equal(m.acked, true); });

test('tokens match by hash and name their source', async () => { const h = await sha256('abc'); const env = { TOKENS: JSON.stringify({ [h]: 'lobby' }) }; assert.equal(await sourceForToken(env, 'Bearer abc'), 'lobby'); assert.equal(await sourceForToken(env, 'Bearer nope'), null); assert.equal(await sourceForToken(env, null), null); });
test('a prototype name is not a token', async () => { assert.equal(await sourceForToken({ TOKENS: '{}' }, 'Bearer constructor'), null); });
test('a review change reads plainly', () => assert.match(describe({ type: 'app.review.changed', data: { app: 'Hearth', version: '1.0', from: 'REJECTED', to: 'IN_REVIEW' } }).subject, /Hearth 1.0 is now IN_REVIEW/));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreement, consume, RETIRE_DAYS } from '../src/bus.mjs';

const NOW = Date.parse('2026-12-01T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();
// rows: review changes as the agreement query returns them; ticks: { ok, failed }.
function env(rows, ticks = { ok: RETIRE_DAYS * 24 }, first = ago(RETIRE_DAYS * 24 + 5)) {
  const prepare = (sql) => ({ bind() { return this; },
    async all() { if (sql.includes('FROM events e')) return { results: rows }; return { results: Object.entries(ticks).map(([status, n]) => ({ status, n })) }; },
    async first() { return { at: first }; } });
  return { DB: { prepare } };
}
const row = (source, h, o = {}) => ({ id: `review:A:1.0_${o.to ?? 'X'}`, source, received: ago(h), app: 'A', version: '1.0', stageAt: null, ...o });

test('ready when every change came from Stage Manager first', async () => { const r = await agreement(env([row('stage-manager', 30)]), NOW); assert.equal(r.ready, true); assert.equal(r.missed, 0); });
test('Lobby winning the race does not block retirement when Stage Manager also saw it', async () => {
  const r = await agreement(env([row('lobby', 30, { stageAt: ago(29.5) })]), NOW); assert.equal(r.lobbyFirst, 1); assert.equal(r.caught, 1); assert.equal(r.ready, true); });
test('a later state of the same version within two hours counts as caught', async () => {
  const r = await agreement(env([row('lobby', 30, { to: 'IN_REVIEW' }), row('stage-manager', 29, { to: 'REJECTED' })]), NOW); assert.equal(r.caught, 1); assert.equal(r.ready, true); });
test('a change Stage Manager never saw blocks retirement', async () => { const r = await agreement(env([row('lobby', 30)]), NOW); assert.equal(r.missed, 1); assert.equal(r.ready, false); });
test('a sighting more than two hours late is a miss', async () => { const r = await agreement(env([row('lobby', 30, { stageAt: ago(27) })]), NOW); assert.equal(r.missed, 1); });
test('a change under two hours old is not judged yet', async () => { const r = await agreement(env([row('lobby', 1)]), NOW); assert.equal(r.missed, 0); assert.equal(r.ready, true); });
test('any failed tick blocks retirement', async () => { const r = await agreement(env([], { ok: 400, failed: 1 }), NOW); assert.equal(r.ready, false); });
test('fewer than fourteen days of ticks is not ready', async () => { const r = await agreement(env([], undefined, ago(24 * 3)), NOW); assert.equal(r.covered, 3); assert.equal(r.ready, false); });

test('every report of a review change is recorded, including the duplicate', async () => {
  const echoes = []; const DB = { prepare: (sql) => ({ bind(...a) { this.a = a; return this; }, async run() { if (sql.includes('INTO echoes')) echoes.push(this.a); }, async first() { return null; } }) };
  const m = (source) => ({ body: { id: 'review:A:1.0_X', type: 'app.review.changed', source, data: {} }, ack() {}, retry() {} });
  await consume({ messages: [m('lobby'), m('stage-manager')] }, { DB }, []);
  assert.deepEqual(echoes.map((a) => a[1]), ['lobby', 'stage-manager']);
});

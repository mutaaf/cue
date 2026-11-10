import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, CONTRACTS } from '../src/contracts.mjs';

const ok = { type: 'app.review.changed', data: { app: 'Hearth', version: '1.0', from: 'REJECTED', to: 'IN_REVIEW' } };
test('a valid event passes and carries its priority', () => assert.deepEqual(validate(ok, 'lobby'), { ok: true, priority: 'critical' }));
test('an unknown type is refused', () => assert.equal(validate({ type: 'nope', data: {} }, 'lobby').ok, false));
test('prototype names are not event types', () => assert.equal(validate({ type: 'constructor', data: {} }, 'lobby').ok, false));
test('a source cannot publish another source\'s event', () => assert.match(validate(ok, 'cold-gas').why, /may not publish/));
test('a missing field is refused', () => assert.match(validate({ type: ok.type, data: { app: 'x' } }, 'lobby').why, /required/));
test('a wrong type is refused', () => assert.match(validate({ type: 'coldgas.run.scored', data: { course: 's', total: '9' } }, 'cold-gas').why, /number/));
test('NaN is not a number here', () => assert.equal(validate({ type: 'coldgas.run.scored', data: { course: 's', total: NaN } }, 'cold-gas').ok, false));
test('an optional field can be absent', () => assert.equal(validate({ type: 'coldgas.run.scored', data: { course: 's', total: 9 } }, 'cold-gas').ok, true));
test('an extra field is refused', () => assert.match(validate({ type: 'ops.test.ping', data: { note: 'x', extra: 1 } }, 'any').why, /not in the/));
for (const key of ['email', 'user_id', 'ip', 'player_name', 'device-id', 'initials', 'lat']) {
  test(`personal field ${key} is refused`, () => assert.match(validate({ type: 'ops.test.ping', data: { note: 'x', [key]: 'y' } }, 'any').why, /personal/));
}
test('words that only contain those letters are fine in a contract', () => assert.equal(/(^|_|-)(ip)($|_|-)/.test('tip'), false));
test('oversized data is refused', () => assert.match(validate({ type: 'ops.test.ping', data: { note: 'x'.repeat(5000) } }, 'any').why, /over/));
test('a bad id is refused', () => assert.match(validate({ type: 'ops.test.ping', id: 'a b', data: { note: 'x' } }, 'any').why, /id must/));
test('no contract has a personal field', () => { for (const [t, c] of Object.entries(CONTRACTS)) for (const k of Object.keys(c.data)) assert.equal(/(^|_)(ip|email|user|initials|phone)($|_)/i.test(k), false, `${t}.${k}`); });
test('stage-manager may report review changes, cold-gas may not', () => { assert.equal(validate(ok, 'stage-manager').ok, true); assert.equal(validate(ok, 'cold-gas').ok, false); });
test('prompter may report a budget refusal, and it is critical', () => { const e = { type: 'prompter.budget.refused', data: { app: 'cold-gas', day: '2026-11-10', spent: 3000 } }; assert.deepEqual(validate(e, 'prompter'), { ok: true, priority: 'critical' }); assert.equal(validate(e, 'cold-gas').ok, false); });

// The bus: publish, consume, deliver. No Cloudflare imports here, so all of it runs under test.
import { validate } from './contracts.mjs';
import { bearer, sha256, log } from 'stagehand';

// The free plan allows 10,000 queue operations a day, and each message costs three (write, read, ack):
// about 3,300 events. Normal events stop at 2,400, which keeps room for every critical event.
export const NORMAL_DAILY_LIMIT = 2400;
export const RETAIN_DAYS = 90;
const day = (now) => new Date(now).toISOString().slice(0, 10);

// Delivery. A publish is written to the D1 log and delivered in the same invocation (ctx.waitUntil), every
// interested subscriber at once. The queue is the slow lane: contract delays, subscribers marked `queue`
// (long jobs), and retries with backoff. An hourly sweep finds anything an invocation dropped. The log line
// for every delivery is {service: 'cue', event: 'deliver', subscriber, type, path, ms, ok}.
export const INLINE_TIMEOUT_MS = 20_000; // waitUntil gets 30 s after the response; leave room to record
export const QUEUE_TIMEOUT_MS = 120_000;
export const RETRY_FIRST_S = 60;
// 60 s, 4 min, 15 min: a five-minute Apple or GitHub blip is absorbed before anything is dead-lettered.
export const backoff = (attempts = 1) => Math.min(900, RETRY_FIRST_S * 4 ** Math.max(0, attempts - 1));

const budgetStmt = (env, now) => env.DB.prepare('INSERT INTO budget (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count').bind(day(now));
const shedding = (v, count) => v.priority !== 'critical' && count > NORMAL_DAILY_LIMIT;

export async function publish(env, input, source, now = Date.now(), ctx = null, subs = null) {
  const v = validate(input, source);
  if (!v.ok) return { ok: false, status: 400, error: v.why };
  // A CloudEvents 1.0 envelope (cloudevents.io), so any tool that speaks the standard can read the log.
  // priority, delay and v are extension attributes.
  const event = { specversion: '1.0', id: input.id ? String(input.id) : crypto.randomUUID(), v: 1, type: input.type, source, time: new Date(now).toISOString(), datacontenttype: 'application/json', priority: v.priority, ...(v.delay ? { delay: v.delay } : {}), data: input.data };
  if (ctx?.waitUntil && subs && !v.delay) {
    try {
      // One round trip to D1 before delivery starts: count it against the day, log it (and its echo), in one
      // transaction. Crons and queues can run far from D1, where every extra round trip costs a few hundred ms.
      const [budget, ins] = await env.DB.batch([budgetStmt(env, now), ...storeStmts(env, event, now)]);
      const fresh = ins?.meta?.changes !== 0;
      if (shedding(v, budget?.results?.[0]?.count)) {
        await env.DB.batch([env.DB.prepare('UPDATE budget SET shed = shed + 1 WHERE day = ?').bind(day(now)), ...(fresh ? [env.DB.prepare('DELETE FROM events WHERE id = ?').bind(event.id)] : [])]);
        return { ok: true, shed: true };
      }
      // A second copy of an id (two watchers, one change) is logged as an echo but not delivered again: the
      // first copy owns delivery, and its retries and the sweep cover it if it fails.
      if (!fresh) return { ok: true, id: event.id, path: 'duplicate' };
      ctx.waitUntil(dispatch(env, event, subs, INLINE_TIMEOUT_MS, true).catch((e) => log('cue', 'dispatch', { type: event.type, ok: false, error: String(e?.message ?? e).slice(0, 200) })));
      return { ok: true, id: event.id, path: 'inline' };
    } catch (e) {
      // The log didn't take it (the batch is one transaction, so nothing was counted): use the queue lane.
      log('cue', 'store', { type: event.type, ok: false, fallback: 'queue', error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  const row = await budgetStmt(env, now).first();
  if (shedding(v, row.count)) {
    await env.DB.prepare('UPDATE budget SET shed = shed + 1 WHERE day = ?').bind(day(now)).run();
    return { ok: true, shed: true };
  }
  await env.EVENTS.send(event, v.delay ? { contentType: 'json', delaySeconds: v.delay } : { contentType: 'json' });
  return { ok: true, id: event.id, path: 'queue' };
}

// Who hears what. A consumer failing retries only that consumer, never the others.
export function subscribersFor(event, subs) {
  const want = subs.filter((s) => s.wants(event));
  return Array.isArray(event.only) ? want.filter((s) => event.only.includes(s.name)) : want;
}

function storeStmts(env, e, now) {
  const at = new Date(now).toISOString();
  const stmts = [env.DB.prepare('INSERT OR IGNORE INTO events (id, type, source, time, priority, data, received) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(e.id, e.type, e.source, e.time, e.priority, JSON.stringify(e.data), at)];
  if (e.type === 'app.review.changed') stmts.push(env.DB.prepare('INSERT OR IGNORE INTO echoes (id, source, at) VALUES (?, ?, ?)').bind(e.id, e.source, at));
  return stmts;
}
const store = (env, e, now) => env.DB.batch(storeStmts(env, e, now));

// The inline lane: deliver now; what failed goes to the queue with backoff, long jobs go to the queue at once.
export async function dispatch(env, e, subs, timeoutMs = INLINE_TIMEOUT_MS, fresh = false) {
  const want = subscribersFor(e, subs);
  const { failed } = await deliver(env, e, want.filter((s) => !s.queue), 'inline', timeoutMs, fresh);
  const slow = want.filter((s) => s.queue).map((s) => s.name);
  const sends = [];
  if (slow.length) sends.push(env.EVENTS.send({ ...e, via: 'deferred', only: slow }, { contentType: 'json' }));
  if (failed.length) sends.push(env.EVENTS.send({ ...e, via: 'retry', only: failed }, { contentType: 'json', delaySeconds: RETRY_FIRST_S }));
  await Promise.all(sends);
  return { failed, deferred: slow };
}

function timeout(p, ms, name) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${name} took over ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

// Run every subscriber that hasn't already succeeded for this id, in parallel, each under a time limit, and
// record all of them in one write.
// A fresh id (this invocation just logged it) can't have a delivery yet, so it skips the lookup.
export async function deliver(env, e, subs, path, timeoutMs, fresh = false) {
  if (!subs.length) return { failed: [] };
  const done = fresh ? new Set() : new Set(((await env.DB.prepare("SELECT subscriber FROM deliveries WHERE event_id = ? AND status = 'ok'").bind(e.id).all()).results ?? []).map((r) => r.subscriber));
  const todo = subs.filter((s) => !done.has(s.name));
  if (!todo.length) return { failed: [] };
  const results = await Promise.all(todo.map(async (s) => {
    const t = Date.now();
    try {
      await timeout(Promise.resolve().then(() => s.run(e, env, t)), timeoutMs, s.name);
      const end = Date.now();
      return { name: s.name, ok: true, at: end, ms: latency(e, end), run: end - t };
    } catch (err) {
      return { name: s.name, ok: false, at: Date.now(), error: String(err?.message ?? err).slice(0, 300), run: Date.now() - t };
    }
  }));
  await env.DB.batch(results.map((r) => recordStmt(env, e.id, r.name, r.ok ? 'ok' : 'failed', r.error ?? null, r.at, r.ok ? r.ms : null, path)));
  for (const r of results) log('cue', 'deliver', { subscriber: r.name, type: e.type, path, ms: r.run, latency: r.ok ? r.ms : null, ok: r.ok });
  return { failed: results.filter((r) => !r.ok).map((r) => r.name) };
}

// The slow lane. Messages in a batch run in parallel; one that fails waits longer each time, then the dead queue.
export async function consume(batch, env, subs, now = Date.now(), timeoutMs = QUEUE_TIMEOUT_MS) {
  // Copies of one id in a batch run one after another, so the second sees what the first delivered.
  const lanes = new Map();
  for (const m of batch.messages) { const k = m.body?.id ?? Symbol(); lanes.set(k, [...(lanes.get(k) ?? []), m]); }
  await Promise.all([...lanes.values()].map(async (ms) => { for (const m of ms) await one(m); }));
  async function one(msg) {
    const e = msg.body;
    try {
      await store(env, e, now);
      const { failed } = await deliver(env, e, subscribersFor(e, subs), e.replay ? 'replay' : e.via ?? 'queue', timeoutMs);
      if (failed.length) msg.retry({ delaySeconds: backoff(msg.attempts) }); else msg.ack();
    } catch {
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}

// The safety net, once an hour: an event logged 45 minutes to 26 hours ago that a subscriber never succeeded
// on, and that isn't dead-lettered, is sent again for just those subscribers. An invocation that ran out of
// time is the usual cause. The drill is left alone, since it tests replay itself.
export const SWEEP_AFTER_MS = 45 * 60e3;
export const SWEEP_WINDOW_MS = 26 * 3600e3;
export async function sweep(env, subs, now = Date.now()) {
  const from = new Date(now - SWEEP_WINDOW_MS).toISOString(), to = new Date(now - SWEEP_AFTER_MS).toISOString();
  const [evs, oks] = await Promise.all([
    env.DB.prepare("SELECT * FROM events WHERE received >= ? AND received < ? AND type != 'ops.drill' AND id NOT IN (SELECT id FROM dead) ORDER BY received LIMIT 500").bind(from, to).all(),
    env.DB.prepare("SELECT d.event_id, d.subscriber FROM deliveries d JOIN events e ON e.id = d.event_id WHERE e.received >= ? AND e.received < ? AND d.status = 'ok'").bind(from, to).all(),
  ]);
  const ok = new Set((oks.results ?? []).map((r) => `${r.event_id}|${r.subscriber}`));
  const msgs = [];
  for (const r of evs.results ?? []) {
    const e = { specversion: '1.0', id: r.id, v: 1, type: r.type, source: r.source, time: r.time, datacontenttype: 'application/json', priority: r.priority, data: JSON.parse(r.data) };
    const missing = subscribersFor(e, subs).filter((s) => s.name !== 'sweep' && !ok.has(`${e.id}|${s.name}`)).map((s) => s.name);
    if (missing.length) msgs.push({ body: { ...e, via: 'sweep', only: missing }, contentType: 'json' });
  }
  for (let i = 0; i < msgs.length; i += 100) await env.EVENTS.sendBatch(msgs.slice(i, i + 100));
  if (msgs.length) log('cue', 'sweep', { swept: msgs.length, ok: true });
  return { swept: msgs.length };
}

// Publish to delivered, less the delay the contract asked for. A replayed event isn't timed: its age is
// the replay window, not the bus.
export function latency(e, done) {
  const t = Date.parse(e.time);
  if (e.replay || !Number.isFinite(t)) return null;
  return Math.max(0, done - t - (e.delay ?? 0) * 1000);
}

function recordStmt(env, id, subscriber, status, error, at, ms = null, path = null) {
  return env.DB.prepare('INSERT INTO deliveries (event_id, subscriber, status, error, at, ms, path) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, subscriber) DO UPDATE SET status = excluded.status, error = excluded.error, at = excluded.at, ms = excluded.ms, path = excluded.path')
    .bind(id, subscriber, status, error, new Date(at).toISOString(), ms, path);
}

export const pct = (xs, p) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };

// Replay from the durable log. The queue keeps 24 hours on the free plan; D1 keeps 90 days. Replays reuse
// the event's id, so a subscriber that already succeeded is skipped and only what failed or is new runs.
export async function replay(env, { since, until = '9999', type = null, id = null } = {}) {
  if (!since && !id) return { ok: false, error: 'since or id is required' };
  const q = id ? env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id)
    : type ? env.DB.prepare('SELECT * FROM events WHERE received >= ? AND received < ? AND type = ? ORDER BY received LIMIT 500').bind(since, until, type)
      : env.DB.prepare('SELECT * FROM events WHERE received >= ? AND received < ? ORDER BY received LIMIT 500').bind(since, until);
  const rows = (await q.all()).results ?? [];
  const msgs = rows.map((r) => ({ body: { specversion: '1.0', id: r.id, v: 1, type: r.type, source: r.source, time: r.time, datacontenttype: 'application/json', priority: r.priority, replay: true, data: JSON.parse(r.data) }, contentType: 'json' }));
  for (let i = 0; i < msgs.length; i += 100) await env.EVENTS.sendBatch(msgs.slice(i, i + 100));
  return { ok: true, replayed: msgs.length };
}

// The weekly replay drill, one step per hour on Cue's clock:
//   start: publish ops.drill · replay: once delivered, forget the delivery and replay it from D1 ·
//   verify: the replay was delivered again → ok. Two hours without that → failed, and a person hears.
export const DRILL_EVERY_DAYS = 7;
export async function drillStep(env, now = Date.now(), alert = null) {
  const iso = new Date(now).toISOString();
  const open = await env.DB.prepare('SELECT * FROM drills WHERE ok IS NULL ORDER BY started DESC LIMIT 1').first();
  if (!open) {
    const last = await env.DB.prepare('SELECT started FROM drills ORDER BY started DESC LIMIT 1').first();
    if (last && now - Date.parse(last.started) < DRILL_EVERY_DAYS * 864e5 - 36e5) return { step: 'idle' };
    const id = `drill:${iso.slice(0, 13)}`;
    await env.DB.prepare('INSERT OR IGNORE INTO drills (id, started) VALUES (?, ?)').bind(id, iso).run();
    await publish(env, { type: 'ops.drill', id, data: { step: 'start' } }, 'cue', now);
    return { step: 'started', id };
  }
  const delivered = await env.DB.prepare("SELECT at FROM deliveries WHERE event_id = ? AND subscriber = 'drill' AND status = 'ok'").bind(open.id).first();
  if (!open.replayed) {
    if (!delivered) return finish(env, open, now, alert, 'the drill event was never delivered', 2);
    await env.DB.prepare("DELETE FROM deliveries WHERE event_id = ? AND subscriber = 'drill'").bind(open.id).run();
    await env.DB.prepare('UPDATE drills SET replayed = ? WHERE id = ?').bind(iso, open.id).run();
    const r = await replay(env, { id: open.id });
    return { step: 'replayed', id: open.id, replayed: r.replayed };
  }
  if (delivered && delivered.at >= open.replayed) {
    const ms = Date.parse(delivered.at) - Date.parse(open.replayed);
    await env.DB.prepare('UPDATE drills SET verified = ?, ok = 1, ms = ? WHERE id = ?').bind(iso, ms, open.id).run();
    return { step: 'verified', id: open.id, ms };
  }
  return finish(env, open, now, alert, 'the replayed event was not delivered again', 2);
}
async function finish(env, open, now, alert, why, hours) {
  const since = Date.parse(open.replayed ?? open.started);
  if (now - since < hours * 36e5) return { step: 'waiting', id: open.id };
  await env.DB.prepare('UPDATE drills SET ok = 0, note = ? WHERE id = ?').bind(why, open.id).run();
  if (alert) await alert('Cue replay drill failed', `${open.id}: ${why}. Events in D1 may not replay. See /cue/api/stats.`, env).catch(() => {});
  return { step: 'failed', id: open.id, why };
}

// Retiring Lobby's Mac watcher. Both watchers run hourly and publish the same review change under the same
// id; the log keeps whichever came first, and echoes records everyone who reported it. The watcher has nothing
// left to catch when, for 14 days, every change it reported Stage Manager also saw (that change, or a later state
// of the same version, within two hours) and Stage Manager's hourly tick never failed. Who came first is shown,
// but it's a race between two timers, so it doesn't decide anything.
export const RETIRE_DAYS = 14;
export const CATCH_UP_MS = 2 * 3600e3;
export async function agreement(env, now = Date.now()) {
  const since = new Date(now - RETIRE_DAYS * 864e5).toISOString();
  const [changes, ticks, first] = await Promise.all([
    env.DB.prepare("SELECT e.id, e.source, e.received, json_extract(e.data, '$.app') AS app, json_extract(e.data, '$.version') AS version, (SELECT MIN(x.at) FROM echoes x WHERE x.id = e.id AND x.source = 'stage-manager') AS stageAt FROM events e WHERE e.type = 'app.review.changed' AND e.received >= ?").bind(since).all(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE subscriber = 'stage-manager' AND at >= ? GROUP BY status").bind(since).all(),
    env.DB.prepare("SELECT MIN(at) AS at FROM deliveries WHERE subscriber = 'stage-manager'").first(),
  ]);
  const rows = changes.results ?? [];
  const seen = rows.map((r) => ({ key: `${r.app}|${r.version}`, at: Date.parse(r.source === 'stage-manager' ? r.received : r.stageAt ?? '') })).filter((s) => s.at);
  const lobby = rows.filter((r) => r.source === 'lobby');
  const settled = lobby.filter((r) => now - Date.parse(r.received) >= CATCH_UP_MS);
  const caught = settled.filter((r) => { const t = Date.parse(r.received); return seen.some((s) => s.key === `${r.app}|${r.version}` && s.at >= t && s.at - t <= CATCH_UP_MS); }).length;
  const t = Object.fromEntries((ticks.results ?? []).map((r) => [r.status, r.n]));
  const covered = first?.at ? Math.min(RETIRE_DAYS, Math.floor((now - Date.parse(first.at)) / 864e5)) : 0;
  const missed = settled.length - caught;
  const ready = covered >= RETIRE_DAYS && missed === 0 && !t.failed && (t.ok ?? 0) >= RETIRE_DAYS * 20;
  return { days: RETIRE_DAYS, covered, stageFirst: rows.filter((r) => r.source === 'stage-manager').length, lobbyFirst: lobby.length, caught, missed, ticksOk: t.ok ?? 0, ticksFailed: t.failed ?? 0, ready };
}

// What retries gave up on. It stays in the log, marked, and a person hears about it.
export async function consumeDead(batch, env, alert, now = Date.now()) {
  for (const msg of batch.messages) {
    const e = msg.body;
    await env.DB.prepare('INSERT OR IGNORE INTO dead (id, type, source, time, data, at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(e.id, e.type, e.source, e.time, JSON.stringify(e.data), new Date(now).toISOString()).run();
    if (e.type !== 'ops.dead') { try { await alert(`Cue gave up on ${e.type}`, `Event ${e.id} from ${e.source} failed every retry. See /cue/api/events.`, env); } catch { /* it's already in the dead table */ } }
    msg.ack();
  }
}

export async function stats(env, now = Date.now()) {
  const since = new Date(now - 864e5).toISOString();
  const week = new Date(now - 7 * 864e5).toISOString();
  const [types, totals, budget, dead, deadWeek, last, lat, drill, dmarc, pager, subs] = await Promise.all([
    env.DB.prepare('SELECT type, COUNT(*) AS n FROM events WHERE received >= ? GROUP BY type ORDER BY n DESC').bind(since).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM events').first(),
    env.DB.prepare('SELECT count, shed FROM budget WHERE day = ?').bind(day(now)).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dead').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dead WHERE at >= ?').bind(week).first(),
    env.DB.prepare('SELECT MAX(received) AS at FROM events').first(),
    env.DB.prepare("SELECT ms FROM deliveries WHERE status = 'ok' AND ms IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 2000").bind(week).all(),
    env.DB.prepare('SELECT id, started, verified, ok, ms, note FROM drills ORDER BY started DESC LIMIT 1').first(),
    env.DB.prepare('SELECT COUNT(*) AS reports, COALESCE(SUM(pass), 0) AS pass, COALESCE(SUM(fail), 0) AS fail, MAX(day) AS last FROM dmarc WHERE at >= ?').bind(new Date(now - 30 * 864e5).toISOString()).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM pager').first(),
    env.DB.prepare('SELECT subscriber, status, ms, path FROM deliveries WHERE at >= ? LIMIT 5000').bind(since).all(),
  ]);
  const ms = (lat.results ?? []).map((r) => r.ms);
  const rows = subs?.results ?? [];
  const summary = (rs) => { const xs = rs.map((r) => r.ms).filter((x) => typeof x === 'number'); return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null }; };
  const group = (key) => { const m = {}; for (const r of rows) (m[r[key] ?? 'queue'] ??= []).push(r); return m; };
  const byPath = Object.fromEntries(Object.entries(group('path')).map(([k, rs]) => [k, summary(rs.filter((r) => r.status === 'ok'))]));
  const subscribers = Object.entries(group('subscriber')).map(([name, rs]) => ({ name, ok: rs.filter((r) => r.status === 'ok').length, failed: rs.filter((r) => r.status === 'failed').length, ...summary(rs.filter((r) => r.status === 'ok')) })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    last24h: types.results ?? [], total: totals?.n ?? 0, today: { published: budget?.count ?? 0, shed: budget?.shed ?? 0, normalLimit: NORMAL_DAILY_LIMIT }, dead: dead?.n ?? 0, deadWeek: deadWeek?.n ?? 0, lastEventAt: last?.at ?? null,
    latency: { days: 7, deliveries: ms.length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null, last24h: summary(rows.filter((r) => r.status === 'ok')), byPath },
    // Per subscriber over 24 hours: how many succeeded and failed, and how long after publish they finished.
    subscribers,
    drill: drill ? { at: drill.started, ok: drill.ok === null ? null : Boolean(drill.ok), ms: drill.ms, note: drill.note } : null,
    dmarc: { days: 30, reports: dmarc?.reports ?? 0, pass: dmarc?.pass ?? 0, fail: dmarc?.fail ?? 0, last: dmarc?.last ?? null },
    retention: { queueHours: 24, logDays: RETAIN_DAYS },
    // How many phones would hear a critical event. A count only: endpoints and keys never leave D1.
    pager: { devices: pager?.n ?? 0 },
  };
}

export async function retain(env, now = Date.now()) {
  const cut = new Date(now - RETAIN_DAYS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE received < ?)').bind(cut),
    env.DB.prepare('DELETE FROM events WHERE received < ?').bind(cut),
    env.DB.prepare('DELETE FROM echoes WHERE at < ?').bind(cut),
    env.DB.prepare('DELETE FROM budget WHERE day < ?').bind(cut.slice(0, 10)),
  ]);
}

// Health, for people and deploys: the database answers, the clock is on time, and what is failing now.
// 503 only when the database doesn't answer; everything else is a warning in the body.
export async function health(env, now = Date.now()) {
  const t = Date.now(), day = new Date(now - 864e5).toISOString();
  const [clock, failing, dead, swept] = await Promise.all([
    env.DB.prepare("SELECT MAX(received) AS at FROM events WHERE type = 'cue.clock.hourly'").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed' AND at >= ?").bind(day).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dead WHERE at >= ?').bind(day).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE path = 'sweep' AND at >= ?").bind(day).first(),
  ]);
  const minutes = clock?.at ? Math.round((now - Date.parse(clock.at)) / 60e3) : null;
  const warnings = [];
  if (minutes === null || minutes > 75) warnings.push('the hourly clock is late');
  if (failing?.n) warnings.push(`${failing.n} deliveries failing in the last 24 hours`);
  if (dead?.n) warnings.push(`${dead.n} dead letters in the last 24 hours`);
  if (swept?.n) warnings.push(`${swept.n} deliveries recovered by the sweep in the last 24 hours`);
  return { ok: true, service: 'cue', db: { ms: Date.now() - t }, clock: { last: clock?.at ?? null, minutes }, failing24h: failing?.n ?? 0, dead24h: dead?.n ?? 0, swept24h: swept?.n ?? 0, warnings };
}

export { sha256 };

// TOKENS is a JSON map of sha-256 hash to source name; the check itself is stagehand's.
export async function sourceForToken(env, header) {
  const tokens = String(env.TOKENS || '{}').trim();
  if (!tokens.startsWith('{')) return null;
  return bearer({ headers: new Headers({ authorization: header || '' }) }, tokens);
}

// Plain words for a person reading it on a phone.
export function describe(e) {
  if (e.type === 'app.review.changed') return { subject: `App Store: ${e.data.app} ${e.data.version} is now ${e.data.to}`, body: `${e.data.app} ${e.data.version} moved from ${e.data.from} to ${e.data.to}.`, link: 'https://appstoreconnect.apple.com/apps' };
  if (e.type === 'prompter.budget.refused') return { subject: `AI allowance: ${e.data.app} used its share for ${e.data.day}`, body: `${e.data.app} has spent ${e.data.spent} neurons today and was refused more. The free Workers AI allowance is 10,000 neurons a day for the whole account; it resets at 00:00 UTC.\n\nIf this happens most days, it's time for Workers Paid ($5 a month). Today's split is on the link.`, link: 'https://mutaafaziz.com/prompter/api/health' };
  if (e.type === 'ops.decision.needed') return { subject: e.data.question, body: e.data.why, link: e.data.link };
  return { subject: `Cue: ${e.type}`, body: JSON.stringify(e.data, null, 2) };
}

// Cross-app counts, straight from the log: an event is stored once by id (INSERT OR IGNORE), so a retry or a
// replay never counts twice and there's no counter to drift. Counts only; nothing per person exists to count.
export const FUNNEL_MAX_DAYS = RETAIN_DAYS;
export async function funnel(env, days = 7, now = Date.now()) {
  days = Math.min(FUNNEL_MAX_DAYS, Math.max(1, Math.floor(Number(days)) || 7));
  const since = new Date(now - days * 864e5).toISOString();
  const [steps, errs] = await Promise.all([
    env.DB.prepare("SELECT json_extract(data, '$.app') AS app, json_extract(data, '$.step') AS step, COUNT(*) AS n FROM events WHERE type = 'app.funnel' AND received >= ? GROUP BY app, step").bind(since).all(),
    env.DB.prepare("SELECT json_extract(data, '$.fingerprint') AS fingerprint, json_extract(data, '$.kind') AS kind, json_extract(data, '$.app') AS app, COUNT(*) AS n, MAX(received) AS last FROM events WHERE type = 'app.error' AND received >= ? GROUP BY fingerprint, kind, app").bind(since).all(),
  ]);
  const byApp = {};
  for (const r of steps.results ?? []) (byApp[r.app] ??= { opened: 0, started: 0, finished: 0 })[r.step] = r.n;
  const groups = new Map();
  for (const r of errs.results ?? []) {
    const g = groups.get(r.fingerprint) ?? { fingerprint: r.fingerprint, kind: r.kind, apps: [], count: 0, last: null };
    if (!g.apps.includes(r.app)) g.apps.push(r.app);
    g.count += r.n;
    if (!g.last || r.last > g.last) g.last = r.last;
    groups.set(r.fingerprint, g);
  }
  const errors = [...groups.values()].map((g) => ({ ...g, apps: g.apps.sort() })).sort((a, b) => b.apps.length - a.apps.length || b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
  return { days, since, funnel: byApp, errors };
}

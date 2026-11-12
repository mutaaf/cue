// The bus: publish, consume, deliver. No Cloudflare imports here, so all of it runs under test.
import { validate } from './contracts.mjs';
import { bearer, sha256 } from 'stagehand';

// The free plan allows 10,000 queue operations a day, and each message costs three (write, read, ack):
// about 3,300 events. Normal events stop at 2,400, which keeps room for every critical event.
export const NORMAL_DAILY_LIMIT = 2400;
export const RETAIN_DAYS = 90;
const day = (now) => new Date(now).toISOString().slice(0, 10);

export async function publish(env, input, source, now = Date.now()) {
  const v = validate(input, source);
  if (!v.ok) return { ok: false, status: 400, error: v.why };
  const row = await env.DB.prepare('INSERT INTO budget (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count').bind(day(now)).first();
  if (v.priority !== 'critical' && row.count > NORMAL_DAILY_LIMIT) {
    await env.DB.prepare('UPDATE budget SET shed = shed + 1 WHERE day = ?').bind(day(now)).run();
    return { ok: true, shed: true };
  }
  // A CloudEvents 1.0 envelope (cloudevents.io), so any tool that speaks the standard can read the log.
  // priority, delay and v are extension attributes.
  const event = { specversion: '1.0', id: input.id ? String(input.id) : crypto.randomUUID(), v: 1, type: input.type, source, time: new Date(now).toISOString(), datacontenttype: 'application/json', priority: v.priority, ...(v.delay ? { delay: v.delay } : {}), data: input.data };
  await env.EVENTS.send(event, v.delay ? { contentType: 'json', delaySeconds: v.delay } : { contentType: 'json' });
  return { ok: true, id: event.id };
}

// Who hears what. A consumer failing retries only that consumer, never the others.
export function subscribersFor(event, subs) {
  return subs.filter((s) => s.wants(event));
}

export async function consume(batch, env, subs, now = Date.now()) {
  for (const msg of batch.messages) {
    const e = msg.body;
    try {
      await env.DB.prepare('INSERT OR IGNORE INTO events (id, type, source, time, priority, data, received) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(e.id, e.type, e.source, e.time, e.priority, JSON.stringify(e.data), new Date(now).toISOString()).run();
      let failed = false;
      for (const s of subscribersFor(e, subs)) {
        const done = await env.DB.prepare("SELECT 1 FROM deliveries WHERE event_id = ? AND subscriber = ? AND status = 'ok'").bind(e.id, s.name).first();
        if (done) continue;
        try {
          await s.run(e, env, now);
          await record(env, e.id, s.name, 'ok', null, now, latency(e, Date.now()));
        } catch (err) {
          failed = true;
          await record(env, e.id, s.name, 'failed', String(err?.message ?? err).slice(0, 300), now);
        }
      }
      if (failed) msg.retry({ delaySeconds: 30 * Math.max(1, msg.attempts ?? 1) }); else msg.ack();
    } catch {
      msg.retry({ delaySeconds: 60 });
    }
  }
}

// Publish to delivered, less the delay the contract asked for. A replayed event isn't timed: its age is
// the replay window, not the bus.
export function latency(e, done) {
  const t = Date.parse(e.time);
  if (e.replay || !Number.isFinite(t)) return null;
  return Math.max(0, done - t - (e.delay ?? 0) * 1000);
}

function record(env, id, subscriber, status, error, now, ms = null) {
  return env.DB.prepare('INSERT INTO deliveries (event_id, subscriber, status, error, at, ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, subscriber) DO UPDATE SET status = excluded.status, error = excluded.error, at = excluded.at, ms = excluded.ms')
    .bind(id, subscriber, status, error, new Date(now).toISOString(), ms).run();
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

// Retiring Lobby's Mac watcher: Stage Manager and the watcher publish the same review change under the same
// id, and the log keeps whichever came first. When Stage Manager came first every time for 14 days (or nothing
// changed) and its hourly tick never failed, the watcher has nothing left to catch.
export const RETIRE_DAYS = 14;
export async function agreement(env, now = Date.now()) {
  const since = new Date(now - RETIRE_DAYS * 864e5).toISOString();
  const [bySource, ticks, first] = await Promise.all([
    env.DB.prepare("SELECT source, COUNT(*) AS n FROM events WHERE type = 'app.review.changed' AND received >= ? GROUP BY source").bind(since).all(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE subscriber = 'stage-manager' AND at >= ? GROUP BY status").bind(since).all(),
    env.DB.prepare("SELECT MIN(at) AS at FROM deliveries WHERE subscriber = 'stage-manager'").first(),
  ]);
  const src = Object.fromEntries((bySource.results ?? []).map((r) => [r.source, r.n]));
  const t = Object.fromEntries((ticks.results ?? []).map((r) => [r.status, r.n]));
  const covered = first?.at ? Math.min(RETIRE_DAYS, Math.floor((now - Date.parse(first.at)) / 864e5)) : 0;
  const ready = covered >= RETIRE_DAYS && !src.lobby && !t.failed && (t.ok ?? 0) >= RETIRE_DAYS * 20;
  return { days: RETIRE_DAYS, covered, stageFirst: src['stage-manager'] ?? 0, lobbyFirst: src.lobby ?? 0, ticksOk: t.ok ?? 0, ticksFailed: t.failed ?? 0, ready };
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
  const [types, totals, budget, dead, last, lat, drill, dmarc, pager] = await Promise.all([
    env.DB.prepare('SELECT type, COUNT(*) AS n FROM events WHERE received >= ? GROUP BY type ORDER BY n DESC').bind(since).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM events').first(),
    env.DB.prepare('SELECT count, shed FROM budget WHERE day = ?').bind(day(now)).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dead').first(),
    env.DB.prepare('SELECT MAX(received) AS at FROM events').first(),
    env.DB.prepare("SELECT ms FROM deliveries WHERE status = 'ok' AND ms IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 2000").bind(week).all(),
    env.DB.prepare('SELECT id, started, verified, ok, ms, note FROM drills ORDER BY started DESC LIMIT 1').first(),
    env.DB.prepare('SELECT COUNT(*) AS reports, COALESCE(SUM(pass), 0) AS pass, COALESCE(SUM(fail), 0) AS fail, MAX(day) AS last FROM dmarc WHERE at >= ?').bind(new Date(now - 30 * 864e5).toISOString()).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM pager').first(),
  ]);
  const ms = (lat.results ?? []).map((r) => r.ms);
  return {
    last24h: types.results ?? [], total: totals?.n ?? 0, today: { published: budget?.count ?? 0, shed: budget?.shed ?? 0, normalLimit: NORMAL_DAILY_LIMIT }, dead: dead?.n ?? 0, lastEventAt: last?.at ?? null,
    latency: { days: 7, deliveries: ms.length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null },
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
    env.DB.prepare('DELETE FROM budget WHERE day < ?').bind(cut.slice(0, 10)),
  ]);
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

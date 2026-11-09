// The bus: publish, consume, deliver. No Cloudflare imports here, so all of it runs under test.
import { validate } from './contracts.mjs';

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
  const event = { id: input.id ? String(input.id) : crypto.randomUUID(), v: 1, type: input.type, source, time: new Date(now).toISOString(), priority: v.priority, data: input.data };
  await env.EVENTS.send(event, { contentType: 'json' });
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
          await record(env, e.id, s.name, 'ok', null, now);
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

function record(env, id, subscriber, status, error, now) {
  return env.DB.prepare('INSERT INTO deliveries (event_id, subscriber, status, error, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, subscriber) DO UPDATE SET status = excluded.status, error = excluded.error, at = excluded.at')
    .bind(id, subscriber, status, error, new Date(now).toISOString()).run();
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
  const [types, totals, budget, dead, last] = await Promise.all([
    env.DB.prepare('SELECT type, COUNT(*) AS n FROM events WHERE received >= ? GROUP BY type ORDER BY n DESC').bind(since).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM events').first(),
    env.DB.prepare('SELECT count, shed FROM budget WHERE day = ?').bind(day(now)).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM dead').first(),
    env.DB.prepare('SELECT MAX(received) AS at FROM events').first(),
  ]);
  return { last24h: types.results ?? [], total: totals?.n ?? 0, today: { published: budget?.count ?? 0, shed: budget?.shed ?? 0, normalLimit: NORMAL_DAILY_LIMIT }, dead: dead?.n ?? 0, lastEventAt: last?.at ?? null };
}

export async function retain(env, now = Date.now()) {
  const cut = new Date(now - RETAIN_DAYS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE received < ?)').bind(cut),
    env.DB.prepare('DELETE FROM events WHERE received < ?').bind(cut),
    env.DB.prepare('DELETE FROM budget WHERE day < ?').bind(cut.slice(0, 10)),
  ]);
}

export async function sha256(text) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sourceForToken(env, header) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m) return null;
  let tokens; try { tokens = JSON.parse(env.TOKENS || '{}'); } catch { return null; }
  return Object.hasOwn(tokens, await sha256(m[1])) ? tokens[await sha256(m[1])] : null;
}

// Plain words for a person reading it on a phone.
export function describe(e) {
  if (e.type === 'app.review.changed') return { subject: `App Store: ${e.data.app} ${e.data.version} is now ${e.data.to}`, body: `${e.data.app} ${e.data.version} moved from ${e.data.from} to ${e.data.to}.\n\nhttps://appstoreconnect.apple.com/apps` };
  return { subject: `Cue: ${e.type}`, body: JSON.stringify(e.data, null, 2) };
}

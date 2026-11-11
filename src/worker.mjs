// Cue: the portfolio's event backbone. Producers publish over a service binding (Workers) or HTTP with a
// token (anything else). A Queue carries the event, D1 keeps the log, and subscribers react.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import { publish, consume, consumeDead, stats, retain, sourceForToken, describe, replay, drillStep, agreement } from './bus.mjs';
import { readReport } from './dmarc.mjs';
import { push, paired, publicKeyOf } from './webpush.mjs';
import { SW, MANIFEST, ICON, SCRIPT, pagerPage } from './pager.mjs';
import { CONTRACTS } from './contracts.mjs';
import { statusPage } from './page.mjs';
import { log, timed } from 'stagehand';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 200);

async function sendAlert(subject, body, env, link = null) {
  if (link) body = `${body}\n\n${link}`;
  const raw = [`From: Cue <${env.MAIL_FROM}>`, `To: ${env.ALERT_TO}`, `Subject: ${clean(subject)}`, `Message-ID: <${crypto.randomUUID()}@mutaafaziz.com>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  await env.MAIL.send(new EmailMessage(env.MAIL_FROM, env.ALERT_TO, raw));
}

// The second channel: Web Push (RFC 8030/8291/8292) straight to the paired phone's own push service. Only
// critical events page: an outage or a decision, never a fact. A phone that unsubscribed (404/410) is dropped.
async function page(env, d, tag) {
  if (!env.VAPID_JWK) throw new Error('VAPID_JWK is not set');
  const jwk = JSON.parse(env.VAPID_JWK);
  const subs = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM pager').all()).results ?? [];
  let sent = 0;
  for (const sub of subs) {
    const status = await push(sub, { title: clean(d.subject), body: String(d.body).slice(0, 600), link: d.link ?? 'https://mutaafaziz.com/cue', tag }, jwk);
    if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM pager WHERE endpoint = ?').bind(sub.endpoint).run();
    else if (status >= 300) throw new Error(`push service answered ${status}`);
    else sent++;
  }
  return sent;
}

const SUBSCRIBERS = [
  { name: 'alert-email', wants: (e) => e.priority === 'critical' && !e.replay, run: (e, env) => { const d = describe(e); return sendAlert(d.subject, d.body, env, d.link); } },
  { name: 'pager', wants: (e) => e.priority === 'critical' && !e.replay, run: (e, env) => page(env, describe(e), e.id).then(() => {}) },
  // Cast List audits every listing surface when one of their repos changes (the push is delayed until the
  // deploy is live), and once a day as a safety net. Nothing polls GitHub.
  { name: 'cast-audit', wants: (e) => e.type === 'repo.pushed' || (e.type === 'cue.clock.hourly' && e.data.hour === '06'), run: (e, env) => env.CAST?.audit() },
  { name: 'drill-clock', wants: (e) => e.type === 'cue.clock.hourly', run: (e, env) => drillStep(env, Date.now(), sendAlert) },
  { name: 'drill', wants: (e) => e.type === 'ops.drill', run: () => {} },
  // Stage Manager has no cron of its own: the clock reaches it as an event. It throws when Apple refuses,
  // so a revoked key is retried, dead-lettered and emailed.
  { name: 'stage-manager', wants: (e) => e.type === 'cue.clock.hourly', run: (e, env) => env.STAGE?.tick() },
  { name: 'retention', wants: (e) => e.type === 'cue.clock.hourly' && e.data.hour === '04', run: (e, env) => retain(env) },
];

async function signed(secret, body, header) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const sig = Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(body));
}

export default class Cue extends WorkerEntrypoint {
  // Service binding: await env.CUE.publish({ type, id?, data }). The binding's props name the source, so a
  // Worker can't claim to be another one. Never throws: an event must not break the request that caused it.
  async publish(event) {
    const source = this.ctx.props?.source;
    if (!source) return { ok: false, error: 'this binding has no props.source' };
    try { return await publish(this.env, event, source); } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
  }

  // One log line per request, cron and batch: {service: 'cue', event, ms, ok}. Paths are fixed routes; anything
  // unmatched is logged as such, never as the path someone typed.
  async fetch(req) {
    const t = Date.now();
    let res;
    try { res = await this.route(req); } catch (e) { log('cue', 'request', { method: req.method, ms: Date.now() - t, ok: false, error: String(e?.message ?? e).slice(0, 200) }); throw e; }
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/cue';
    log('cue', 'request', { method: req.method, route: res.status === 404 ? 'unmatched' : path, status: res.status, ms: Date.now() - t, ok: res.status < 500 });
    return res;
  }

  async route(req) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/cue';
    if (path === '/cue') return new Response(statusPage(await stats(this.env), Object.keys(CONTRACTS)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    if (path === '/cue/api/health') return json({ ok: true, service: 'cue' });
    if (path === '/cue/api/stats') return json(await stats(this.env));
    if (path === '/cue/api/contracts') return json(CONTRACTS);
    if (path === '/cue/pager') { const n = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM pager').first(); return new Response(pagerPage(publicKeyOf(JSON.parse(this.env.VAPID_JWK)), n?.n ?? 0), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } }); }
    if (path === '/cue/sw.js') return new Response(SW, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache', 'service-worker-allowed': '/cue/' } });
    if (path === '/cue/pager.js') return new Response(SCRIPT, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } });
    if (path === '/cue/pager.webmanifest') return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } });
    if (path === '/cue/pager.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    if (path === '/cue/api/pager' && req.method === 'POST') return this.pair(req);
    if (path === '/cue/api/agreement') return json(await agreement(this.env));
    if (path === '/cue/hooks/github' && req.method === 'POST') return this.github(req);
    const source = await sourceForToken(this.env, req.headers.get('authorization'));
    if (path === '/cue/api/replay' && req.method === 'POST') {
      if (source !== 'operator') return json({ ok: false, error: 'an operator token is required' }, 401);
      let body; try { body = await req.json(); } catch { return json({ ok: false, error: 'the body must be JSON' }, 400); }
      return json(await replay(this.env, body ?? {}));
    }
    if (path === '/cue/api/drill' && req.method === 'POST') {
      if (source !== 'operator') return json({ ok: false, error: 'an operator token is required' }, 401);
      return json(await drillStep(this.env, Date.now(), sendAlert));
    }
    if (path === '/cue/api/publish' && req.method === 'POST') {
      if (!source) return json({ ok: false, error: 'a valid token is required' }, 401);
      let body; try { body = await req.json(); } catch { return json({ ok: false, error: 'the body must be JSON' }, 400); }
      const r = await publish(this.env, body, source);
      return json(r, r.ok ? 202 : (r.status ?? 500));
    }
    if (path === '/cue/api/events' && req.method === 'GET') {
      if (source !== 'operator') return json({ ok: false, error: 'an operator token is required' }, 401);
      const since = url.searchParams.get('since') || '1970-01-01', type = url.searchParams.get('type');
      const q = type ? this.env.DB.prepare('SELECT * FROM events WHERE received > ? AND type = ? ORDER BY received LIMIT 200').bind(since, type) : this.env.DB.prepare('SELECT * FROM events WHERE received > ? ORDER BY received LIMIT 200').bind(since);
      return json({ events: (await q.all()).results });
    }
    return json({ ok: false, error: 'not found' }, 404);
  }

  // Pair a phone: only with a pairing link the operator made (PAIR_SECRET), and it gets a test page at once.
  async pair(req) {
    let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'the body must be JSON' }, 400); }
    if (!(await paired(this.env.PAIR_SECRET, b?.k))) return json({ ok: false, error: 'This pairing link has expired or is not valid.' }, 403);
    const sub = b.sub ?? {}, p256dh = sub.keys?.p256dh, auth = sub.keys?.auth;
    if (!/^https:\/\//.test(sub.endpoint ?? '') || !p256dh || !auth || sub.endpoint.length > 1000) return json({ ok: false, error: 'not a push subscription' }, 400);
    await this.env.DB.prepare('INSERT INTO pager (endpoint, p256dh, auth, at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, at = excluded.at').bind(sub.endpoint, p256dh, auth, new Date().toISOString()).run();
    const status = await push({ endpoint: sub.endpoint, p256dh, auth }, { title: 'Cue pager is on', body: 'This phone will hear about outages and decisions. Facts stay in the log.', link: 'https://mutaafaziz.com/cue', tag: 'paired' }, JSON.parse(this.env.VAPID_JWK));
    return json({ ok: status < 300, status });
  }

  // GitHub push webhooks from the repos behind the listing surfaces, signed with GITHUB_HOOK_SECRET.
  async github(req) {
    const body = await req.text();
    if (!this.env.GITHUB_HOOK_SECRET || !(await signed(this.env.GITHUB_HOOK_SECRET, body, req.headers.get('x-hub-signature-256')))) return json({ ok: false, error: 'bad signature' }, 401);
    const kind = req.headers.get('x-github-event');
    if (kind === 'ping') return json({ ok: true, pong: true });
    if (kind !== 'push') return json({ ok: true, ignored: kind });
    let p; try { p = JSON.parse(body); } catch { return json({ ok: false, error: 'the body must be JSON' }, 400); }
    const branch = String(p.ref ?? '').replace('refs/heads/', ''), repo = String(p.repository?.name ?? '');
    if (!repo || branch !== p.repository?.default_branch || p.deleted) return json({ ok: true, ignored: 'not the default branch' });
    const r = await publish(this.env, { type: 'repo.pushed', id: `push:${repo}:${String(p.after ?? '').slice(0, 12)}`.replace(/[^\w.:-]/g, '_'), data: { repo, branch } }, 'github');
    return json(r, r.ok ? 202 : (r.status ?? 500));
  }

  // dmarc@mutaafaziz.com is routed here. Counts are kept; the report itself is dropped.
  async email(message) {
    if (!/^dmarc@/i.test(message.to)) { message.setReject('no such mailbox'); return; }
    if (message.rawSize > 5_000_000) return;
    const r = await readReport(await new Response(message.raw).arrayBuffer()).catch(() => null);
    if (!r) return;
    const now = new Date().toISOString();
    const res = await this.env.DB.prepare('INSERT OR IGNORE INTO dmarc (id, org, day, pass, fail, at) VALUES (?, ?, ?, ?, ?, ?)').bind(r.id, r.org, r.day ?? now.slice(0, 10), r.pass, r.fail, now).run();
    if (res.meta?.changes) await publish(this.env, { type: 'email.dmarc.report', id: `dmarc:${r.id}`.slice(0, 120), data: { org: r.org, pass: r.pass, fail: r.fail } }, 'cue');
  }

  async queue(batch) {
    return timed('cue', 'queue', () => (batch.queue === 'cue-dead' ? consumeDead(batch, this.env, sendAlert) : consume(batch, this.env, SUBSCRIBERS)), { queue: batch.queue, size: batch.messages.length });
  }

  async scheduled(controller) {
    const hour = new Date(controller.scheduledTime).toISOString().slice(11, 13);
    await timed('cue', 'scheduled', () => publish(this.env, { type: 'cue.clock.hourly', id: `clock:${new Date(controller.scheduledTime).toISOString().slice(0, 13)}`, data: { hour } }, 'cue'), { cron: controller.cron });
  }
}

// Cue: the portfolio's event backbone. Producers publish over a service binding (Workers) or HTTP with a
// token (anything else). A Queue carries the event, D1 keeps the log, and subscribers react.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import { publish, consume, consumeDead, stats, retain, sourceForToken, describe } from './bus.mjs';
import { CONTRACTS } from './contracts.mjs';
import { statusPage } from './page.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 200);

async function sendAlert(subject, body, env) {
  const raw = [`From: Cue <${env.MAIL_FROM}>`, `To: ${env.ALERT_TO}`, `Subject: ${clean(subject)}`, `Message-ID: <${crypto.randomUUID()}@mutaafaziz.com>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  await env.MAIL.send(new EmailMessage(env.MAIL_FROM, env.ALERT_TO, raw));
}

const SUBSCRIBERS = [
  { name: 'alert-email', wants: (e) => e.priority === 'critical', run: (e, env) => { const d = describe(e); return sendAlert(d.subject, d.body, env); } },
  // Stage Manager has no cron of its own: the clock reaches it as an event. It throws when Apple refuses,
  // so a revoked key is retried, dead-lettered and emailed.
  { name: 'stage-manager', wants: (e) => e.type === 'cue.clock.hourly', run: (e, env) => env.STAGE?.tick() },
  { name: 'retention', wants: (e) => e.type === 'cue.clock.hourly' && e.data.hour === '04', run: (e, env) => retain(env) },
];

export default class Cue extends WorkerEntrypoint {
  // Service binding: await env.CUE.publish({ type, id?, data }). The binding's props name the source, so a
  // Worker can't claim to be another one. Never throws: an event must not break the request that caused it.
  async publish(event) {
    const source = this.ctx.props?.source;
    if (!source) return { ok: false, error: 'this binding has no props.source' };
    try { return await publish(this.env, event, source); } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/cue';
    if (path === '/cue') return new Response(statusPage(await stats(this.env), Object.keys(CONTRACTS)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    if (path === '/cue/api/health') return json({ ok: true, service: 'cue' });
    if (path === '/cue/api/stats') return json(await stats(this.env));
    if (path === '/cue/api/contracts') return json(CONTRACTS);
    const source = await sourceForToken(this.env, req.headers.get('authorization'));
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

  async queue(batch) {
    if (batch.queue === 'cue-dead') return consumeDead(batch, this.env, sendAlert);
    return consume(batch, this.env, SUBSCRIBERS);
  }

  async scheduled(controller) {
    const hour = new Date(controller.scheduledTime).toISOString().slice(11, 13);
    await publish(this.env, { type: 'cue.clock.hourly', id: `clock:${new Date(controller.scheduledTime).toISOString().slice(0, 13)}`, data: { hour } }, 'cue');
  }
}

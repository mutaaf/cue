#!/usr/bin/env node
// One GitHub issue per error fingerprint, across every app that reports it. Reads Cue's public counts
// (/cue/api/funnel) and opens or updates issues labelled `cross-app` in this repo. Run daily by
// .github/workflows/cross-app-issues.yml with the repo's own GITHUB_TOKEN; nothing else needs a secret.
//
//   node scripts/cross-app-issues.mjs            plan and apply (needs GITHUB_TOKEN, GITHUB_REPOSITORY)
//   node scripts/cross-app-issues.mjs --dry-run  print the plan only
import { pathToFileURL } from 'node:url';

export const LABEL = 'cross-app';
export const MARK = (fp) => `<!-- cue:fingerprint:${fp} -->`;
const FP = /<!-- cue:fingerprint:([A-Za-z0-9_-]{6,64}) -->/;
export const title = (g) => `Cross-app error ${g.fingerprint} (${g.kind}) in ${g.apps.join(', ')}`;

export function body(g, days) {
  return [
    MARK(g.fingerprint),
    `Cue saw error fingerprint \`${g.fingerprint}\` (kind \`${g.kind}\`) ${g.count} time${g.count === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}.`,
    '',
    '| App | |', '|---|---|', ...g.apps.map((a) => `| ${a} | reports it |`),
    '',
    `Last seen: ${g.last ?? 'unknown'}.`,
    '',
    'Counts only: events carry a kind and an opaque fingerprint, never a message. Source: https://mutaafaziz.com/cue/api/funnel',
    'Updated daily by `.github/workflows/cross-app-issues.yml`; the fix is a PR in the app that owns the code.',
  ].join('\n');
}

/** Groups from Cue plus this repo's issues labelled cross-app → what to do. Pure, so it's tested. */
export function plan(groups, issues, days = 7) {
  const open = new Map();
  for (const i of issues) { const m = FP.exec(i.body ?? ''); if (m && !open.has(m[1])) open.set(m[1], i); }
  const out = [];
  for (const g of groups) {
    const want = { title: title(g), body: body(g, days) };
    const i = open.get(g.fingerprint);
    if (!i) out.push({ op: 'create', fingerprint: g.fingerprint, ...want });
    // A closed issue stays closed unless the error came back after it was closed (a fix that didn't hold).
    else if (i.state === 'closed') { if (g.last && i.closed_at && g.last > i.closed_at) out.push({ op: 'update', number: i.number, fingerprint: g.fingerprint, reopen: true, ...want }); }
    else if (i.title !== want.title || i.body !== want.body) out.push({ op: 'update', number: i.number, fingerprint: g.fingerprint, reopen: false, ...want });
  }
  return out;
}

async function gh(path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, { ...init, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'cue-cross-app-issues' } });
  if (!r.ok && r.status !== 422) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const days = Number(process.env.DAYS ?? 7);
  const res = await fetch(`${process.env.CUE_URL ?? 'https://mutaafaziz.com/cue'}/api/funnel?days=${days}`);
  if (!res.ok) throw new Error(`Cue answered ${res.status}`);
  const { errors = [] } = await res.json();
  if (!errors.length) { console.log('cross-app: no error groups, nothing to do'); return; }
  const issues = dry ? [] : (await gh(`/issues?labels=${LABEL}&state=all&per_page=100`)).filter((i) => !i.pull_request);
  const actions = plan(errors, issues, days);
  if (dry) { console.log(JSON.stringify(actions, null, 2)); return; }
  if (actions.some((a) => a.op === 'create')) await gh('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'B60205', description: 'An error fingerprint Cue saw, grouped across apps' }) }); // 422 when it exists
  for (const a of actions) {
    if (a.op === 'create') { const i = await gh('/issues', { method: 'POST', body: JSON.stringify({ title: a.title, body: a.body, labels: [LABEL] }) }); console.log(`created #${i.number} for ${a.fingerprint}`); }
    else { await gh(`/issues/${a.number}`, { method: 'PATCH', body: JSON.stringify({ title: a.title, body: a.body, ...(a.reopen ? { state: 'open' } : {}) }) }); console.log(`updated #${a.number} for ${a.fingerprint}`); }
  }
  console.log(`cross-app: ${errors.length} group(s), ${actions.length} change(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`cross-app: ${e.message}`); process.exit(1); });

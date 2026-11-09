// A public status page: aggregates only, never event contents.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function statusPage(s, types) {
  const rows = s.last24h.map((t) => `<tr><td>${esc(t.type)}</td><td>${t.n}</td></tr>`).join('') || '<tr><td colspan="2">Nothing in the last 24 hours.</td></tr>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cue · event backbone</title><style>
:root{color-scheme:dark}body{margin:0 auto;max-width:760px;padding:40px 16px;background:#0a0f26;color:#eef1ff;font:16px/1.5 ui-monospace,Menlo,monospace}h1{font-size:44px;margin:0;color:#6ff2c8}p{color:#b9c1e2}table{width:100%;border-collapse:collapse;margin:8px 0 28px}td,th{padding:8px 0;border-bottom:1px solid #2a3158;text-align:left}td:last-child,th:last-child{text-align:right}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.g div{border:1px solid #2a3158;padding:12px;border-radius:8px}.g b{display:block;font-size:26px}a{color:#6ff2c8}</style>
<h1>Cue</h1><p>The event backbone behind <a href="https://mutaafaziz.com/manifest/">these apps</a>. Typed events go in, a durable log and subscribers come out. Events carry no personal data.</p>
<div class="g"><div><b>${s.total}</b>events logged</div><div><b>${s.today.published}</b>published today</div><div><b>${s.today.shed}</b>shed today</div><div><b>${s.dead}</b>dead-lettered</div></div>
<h2>Last 24 hours</h2><table><tr><th>Event</th><th>Count</th></tr>${rows}</table>
<h2>Contracts</h2><p>${types.map(esc).join('<br>')}</p><p>Last event: ${esc(s.lastEventAt ?? 'none yet')}</p></html>`;
}

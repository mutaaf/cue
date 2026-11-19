// A small D1 stand-in that knows only the statements the bus runs.
export function fakeEnv({ count = 0 } = {}) {
  const s = { count, shed: 0, events: new Map(), deliveries: new Map(), dead: new Map(), sent: [] };
  const prepare = (sql) => {
    const st = { args: [], bind(...a) { st.args = a; return st; },
      async first() {
        if (sql.startsWith('INSERT INTO budget')) { s.count++; return { count: s.count }; }
        if (sql.startsWith('SELECT 1 FROM deliveries')) { const d = s.deliveries.get(st.args.join('|')); return d?.status === 'ok' ? {} : null; }
        return null; },
      async run() {
        if (sql.startsWith('UPDATE budget')) s.shed++;
        if (sql.startsWith('INSERT OR IGNORE INTO events')) { if (s.events.has(st.args[0])) return { meta: { changes: 0 } }; s.events.set(st.args[0], st.args); return { meta: { changes: 1 } }; }
        if (sql.startsWith('INSERT INTO deliveries')) s.deliveries.set(`${st.args[0]}|${st.args[1]}`, { status: st.args[2], ms: st.args[5], path: st.args[6], error: st.args[3] });
        if (sql.startsWith('INSERT OR IGNORE INTO dead')) s.dead.set(st.args[0], st.args);
      },
      async all() {
        if (sql.startsWith('SELECT subscriber FROM deliveries')) return { results: [...s.deliveries.entries()].filter(([k, d]) => k.startsWith(`${st.args[0]}|`) && d.status === 'ok').map(([k]) => ({ subscriber: k.slice(k.indexOf('|') + 1) })) };
        if (sql.startsWith('SELECT * FROM events')) return { results: [...s.events.values()].map((a) => ({ id: a[0], type: a[1], source: a[2], time: a[3], priority: a[4], data: a[5], received: a[6] })) }; return { results: [] }; } };
    return st;
  };
  return { s, DB: { prepare, batch: async (stmts) => { const out = []; for (const x of stmts) out.push(await x.run()); return out; } }, EVENTS: { send: async (m, o) => { s.sent.push(m); s.opts = o; }, sendBatch: async (ms) => { s.batches = (s.batches ?? 0) + 1; for (const m of ms) s.sent.push(m.body); } } };
}
export const msg = (body, attempts = 1) => { const m = { body, attempts, acked: false, retried: false, ack() { m.acked = true; }, retry() { m.retried = true; } }; return m; };

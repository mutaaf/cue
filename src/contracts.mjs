// The event catalog. A type that isn't here can't be published, and a payload that doesn't match is
// refused at the door, so a bad producer fails loudly and consumers can trust what they read.
//   priority: critical events skip the budget and alert a human. normal events are shed first.
export const CONTRACTS = {
  'cue.clock.hourly': { sources: ['cue'], priority: 'normal', data: { hour: 'string' } },
  'ops.test.ping': { sources: ['*'], priority: 'normal', data: { note: 'string' } },
  'ops.test.alert': { sources: ['operator'], priority: 'critical', data: { note: 'string' } },
  'app.review.changed': { sources: ['lobby'], priority: 'critical', data: { app: 'string', version: 'string', from: 'string', to: 'string' } },
  'coldgas.run.scored': { sources: ['cold-gas'], priority: 'normal', data: { course: 'string', total: 'number', tier: '?string' } },
};

// Events describe what the system did, never who did it. Some of these apps promise kids and parents
// exactly that, so a field that looks personal is refused whatever the contract says.
const PERSONAL = /(^|_|-)(ip|email|e-?mail|phone|user|username|name|initials|device|token|password|secret|address|location|lat|lng|lon)($|_|-)/i;
const MAX_DATA_BYTES = 4096;
const ID = /^[\w.:-]{1,120}$/;

export function validate(input, source) {
  const fail = (why) => ({ ok: false, why });
  if (!input || typeof input !== 'object') return fail('an event must be an object');
  const c = Object.hasOwn(CONTRACTS, input.type) ? CONTRACTS[input.type] : null;
  if (!c) return fail(`unknown event type: ${String(input.type)}`);
  if (!c.sources.includes('*') && !c.sources.includes(source)) return fail(`${source} may not publish ${input.type}`);
  if (input.id !== undefined && !ID.test(String(input.id))) return fail('id must be 1 to 120 letters, digits or . : _ -');
  const data = input.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('data must be an object');
  if (JSON.stringify(data).length > MAX_DATA_BYTES) return fail(`data is over ${MAX_DATA_BYTES} bytes`);
  for (const key of Object.keys(data)) {
    if (PERSONAL.test(key)) return fail(`data.${key} looks personal, and events carry no personal data`);
    if (!Object.hasOwn(c.data, key)) return fail(`data.${key} is not in the ${input.type} contract`);
  }
  for (const [key, want] of Object.entries(c.data)) {
    const optional = want.startsWith('?'), type = want.replace('?', '');
    if (data[key] === undefined) { if (optional) continue; return fail(`data.${key} is required`); }
    if (typeof data[key] !== type || (type === 'number' && !Number.isFinite(data[key]))) return fail(`data.${key} must be a ${type}`);
  }
  return { ok: true, priority: c.priority };
}

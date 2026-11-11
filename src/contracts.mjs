// The event catalog. A type that isn't here can't be published, and a payload that doesn't match is
// refused at the door, so a bad producer fails loudly and consumers can trust what they read.
//   priority: critical events skip the budget and alert a human. normal events are shed first.
export const CONTRACTS = {
  'cue.clock.hourly': { sources: ['cue'], priority: 'normal', data: { hour: 'string' } },
  'ops.test.ping': { sources: ['*'], priority: 'normal', data: { note: 'string' } },
  'ops.test.alert': { sources: ['operator'], priority: 'critical', data: { note: 'string' } },
  'app.review.changed': { sources: ['lobby', 'stage-manager'], priority: 'critical', data: { app: 'string', version: 'string', from: 'string', to: 'string' } },
  // Prompter (the AI gateway). A refusal is once per app per day and is the signal to consider Workers Paid.
  'prompter.budget.refused': { sources: ['prompter'], priority: 'critical', data: { app: 'string', day: 'string', spent: 'number' } },
  'prompter.model.failed': { sources: ['prompter'], priority: 'normal', data: { model: 'string', app: 'string', error: 'string' } },
  // Cast List (the app catalog): the set of places that disagree with it changed. Counts only.
  'cast.drift.changed': { sources: ['cast-list'], priority: 'normal', data: { surfaces: 'number', agree: 'number', high: 'number', medium: 'number' } },
  // Email: Cue reads the DMARC aggregate reports sent to dmarc@ (counts only, never addresses).
  'email.dmarc.report': { sources: ['cue'], priority: 'normal', data: { org: 'string', pass: 'number', fail: 'number' } },
  // GitHub: a push to a default branch, signed with the hook secret. Delayed four minutes so the deploy it
  // starts (Workers Builds) is live before anyone reacts to it.
  'repo.pushed': { sources: ['github'], priority: 'normal', delay: 240, data: { repo: 'string', branch: 'string' } },
  // The replay drill: Cue proves weekly that an event can be replayed from the D1 log.
  'ops.drill': { sources: ['cue'], priority: 'normal', data: { step: 'string' } },
  // The only kind of page that isn't an outage: a decision only the owner can make.
  'ops.decision.needed': { sources: ['cue', 'stage-manager', 'cast-list', 'prompter', 'operator'], priority: 'critical', data: { question: 'string', why: 'string', link: 'string' } },
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
  return c.delay ? { ok: true, priority: c.priority, delay: c.delay } : { ok: true, priority: c.priority };
}

# Cue: operating manual

The event backbone for every project on mutaafaziz.com. Read docs/ARCHITECTURE.md first: it says what belongs here and what deliberately doesn't.

## Invariants

- Events carry no personal data. Enforced by `validate` in src/contracts.mjs and its tests. Never loosen it to get an event through.
- A type not in `CONTRACTS` can't be published.
- A producer can't choose its source: binding `props` or the token decides.
- Consumers are idempotent. `deliveries` records each subscriber, so a retry reruns only what failed.
- Critical events are never shed, and normal events stop at `NORMAL_DAILY_LIMIT`.
- Events are CloudEvents 1.0 envelopes (`specversion`, `id`, `source`, `type`, `time`, `datacontenttype`); `priority`, `delay`, `replay` and `v` are extensions.
- Only critical events page (email plus Web Push to paired phones): an outage or a decision. Facts stay in the log. A pairing link comes from `node scripts/pair-link.mjs` and lasts 14 days.
- Replays reuse ids, so a subscriber that already succeeded never reruns. Never add a subscriber that isn't idempotent.
- Stay inside the free plan. No new cron: subscribe to `cue.clock.hourly`.

## Commands

- `npm test`: bus logic, no Cloudflare needed. Run `npm ci` first: token checks and logging come from [stagehand](https://github.com/mutaaf/stagehand).
- `npm run check`: tests plus a dry-run bundle. CI runs this.
- `npm run up`: tests, then a local server.
- `npm run deploy`: tests, D1 migrations, deploy. Manual, like most Workers here.

## Definition of done

- A test fails without the change.
- `npm run check` is green.
- After deploying: `/cue/api/health` answers, and a test event shows up in `/cue/api/stats`.
- Change the free plan table in docs/ARCHITECTURE.md if the numbers moved.

## Shipping

`main` requires green CI with no admin bypass. Branch, push, `gh pr create --fill`, `gh pr merge --auto --squash --delete-branch`.

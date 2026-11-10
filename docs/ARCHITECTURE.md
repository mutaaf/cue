# Portfolio architecture: an event backbone and a few shared services

Decided 2026-11-06, from an inventory of every project and the free plan's real limits.

## The decision

No two apps share a database and almost everything cross-app is polling. Traffic is small: Cold Gas has 7 recorded human sessions. Workers get 10 ms of CPU per request.

So this is **not** one microservice per feature. Splitting game scoring would add hops against a 10 ms budget and gain nothing. The portfolio gets one event backbone, and a shared service only where duplication already causes real trouble.

```text
 producers                    backbone                          subscribers
 Worker  -- service binding -->                              +-> alert email
 Lobby   -- HTTP + token ----> Cue --> Queue --> consumer ---+-> retention
 CI, Vercel -- HTTP + token ->             |         |       +-> next: Prompter, Cast List, ...
                                           v         v
                                      dead letters  D1 log (replayable, 90 days)
```

## Phases

| Phase | Service | Evidence | State |
|---|---|---|---|
| 1 | **Cue**, the event bus | Everything is polling; no project can react to another | Live |
| 2 | **Prompter**, one AI gateway and neuron budget | 5 copies of provider code, and per-Worker caps totalling far over the shared 10,000 neurons a day. Models have already failed in production on this | Live (2026-11-10): github.com/mutaaf/prompter. A drop-in for the Workers AI binding: guaranteed share per app, idle shares lent out as the UTC day runs down, model fallback. Bring-your-own-key calls stay in the apps |
| 3 | **Cast List**, one app catalog | 14 places listed the apps and disagreed (a missing app, a live app still called beta, two names for one game) | Live (2026-11-10): github.com/mutaaf/cast-list, mutaafaziz.com/cast. Catalog as code, store status live from Stage Manager, every listing surface audited and the result published as `cast.drift.changed` |
| 4 | **Stage Manager**, release and review tracking | App Store Connect tooling copied across 4+ repos | Live (2026-11-10): github.com/mutaaf/stage-manager. Owner approved the key leaving the Mac; it uses its own read-only key, separate from Lobby's. Woken by `cue.clock.hourly`, no cron |
| 5 | Shared operator auth, obs ingest | Copies multiplying | Planned |

## Left alone on purpose

- Gameplay and authoritative scoring. CPU-bound, and an extra hop costs the budget.
- Each product's database. Share events, not stores.
- Static sites and the launcher library.
- Moon Club, Almanac, Saturday. Their privacy promises come first. OUTATIME and OpenAero forbid analytics, so at most operational events.
- Dormant projects, until they wake up.

## Free plan budget

| Limit | Allowance | Use |
|---|---|---|
| Queue operations | 10,000 a day, about 3,300 events | Normal events stop at 2,400 a day. Critical events are never shed |
| Queue retention | 24 hours | D1 is the durable log. A consumer outage over 24 hours loses queued events |
| Cron triggers | 5 per account | 5 used (Cue's clock is one). Add jobs as subscribers to `cue.clock.hourly`, not as new crons |
| D1 databases | 10 per account | 7 used |
| CPU | 10 ms a request | Publish does one write and one send |
| Durable Object namespaces | 100, with preview copies counting | 5 used. `preview_urls: false` everywhere |

When traffic pushes past this, Workers Paid is $5 a month. That's the owner's decision, and the budget table above shows when.

## Rules

1. **Contract first.** An event type that isn't in `src/contracts.mjs` can't be published.
2. **No personal data.** Events describe what the system did. Personal-looking fields are refused in code, whatever a contract says.
3. **Source can't be forged.** The binding's `props` or the token decides the source, never the payload.
4. **At-least-once delivery.** Consumers must be idempotent. Give an event a stable `id` when a duplicate would matter.
5. **Publishing never breaks the caller.** Fire it in `ctx.waitUntil`, and a failed publish costs an event, not a request.
6. **No new cron.** Subscribe to the clock.

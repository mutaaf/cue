# Producers

| Source | How | Events |
|---|---|---|
| lobby | HTTP, `lobby watch-review` hourly on the owner's Mac | `app.review.changed` |
| stage-manager | Service binding, called by Cue's hourly clock; reads App Store Connect in the cloud (github.com/mutaaf/stage-manager) | `app.review.changed` (same ids as lobby, so a change is logged once while both run) |
| prompter | Service binding; once per app per day when its AI share is used up, and when a model fails | `prompter.budget.refused`, `prompter.model.failed` |
| cast-list | Service binding, when the audit's set of mismatches changes (github.com/mutaaf/cast-list) | `cast.drift.changed` |
| cold-gas | Service binding | `coldgas.run.scored`; may publish `app.error` and `app.funnel` (not wired yet) |
| operator | HTTP | `ops.test.alert` |
| cue | Its own clock; the DMARC mailbox (dmarc@ is routed to this Worker); the weekly replay drill | `cue.clock.hourly`, `email.dmarc.report`, `ops.drill`, `ops.decision.needed` |
| github | Signed push webhooks (`/cue/hooks/github`, `GITHUB_HOOK_SECRET`) on the repos behind every listing surface. Delayed 240 s so the deploy is live | `repo.pushed` |

## Cross-app errors and funnel

`app.error` {app, kind, fingerprint} and `app.funnel` {app, step: opened|started|finished} come only from the app producers in `APP_SOURCES` (src/contracts.mjs). Every field must match a pattern, so none can carry a message or anything a person typed: `fingerprint` is an opaque 6 to 64 character hash the app makes of its own code path. Counts are read straight from the event log (stored once per id, so retries and replays never double count) at `GET /cue/api/funnel?days=7` (public, counts only, 1 to 90 days). `.github/workflows/cross-app-issues.yml` reads it daily and keeps one issue per fingerprint, labelled `cross-app`; a closed issue reopens only when the error comes back after it was closed.

Funnel events are normal priority, so they share the 2,400 a day normal budget and are shed first. At today's traffic that is far off; per-step sampling is the lever before Workers Paid.

What each app needs to publish (none is wired yet):

| App | Needs | Note |
|---|---|---|
| cold-gas | One `env.CUE.publish(...)` line per signal in `ctx.waitUntil` | Already has the binding and is in `APP_SOURCES` |
| kin, hinge-pop, chalk-talk, metaphases, hearth, library | The CUE service binding (`props.source` = the app), its name in `APP_SOURCES`, and the publish line | |
| openaero-dfw, outatime-88 | Same, `app.error` only | They forbid analytics, so no funnel |
| Moon Club (moon-club, metaphases kids) | Nothing, on purpose | Kids app; its privacy promise comes first |

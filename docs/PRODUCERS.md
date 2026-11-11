# Producers

| Source | How | Events |
|---|---|---|
| lobby | HTTP, `lobby watch-review` hourly on the owner's Mac | `app.review.changed` |
| stage-manager | Service binding, called by Cue's hourly clock; reads App Store Connect in the cloud (github.com/mutaaf/stage-manager) | `app.review.changed` (same ids as lobby, so a change is logged once while both run) |
| prompter | Service binding; once per app per day when its AI share is used up, and when a model fails | `prompter.budget.refused`, `prompter.model.failed` |
| cast-list | Service binding, when the audit's set of mismatches changes (github.com/mutaaf/cast-list) | `cast.drift.changed` |
| cold-gas | Service binding | `coldgas.run.scored` |
| operator | HTTP | `ops.test.alert` |
| cue | Its own clock; the DMARC mailbox (dmarc@ is routed to this Worker); the weekly replay drill | `cue.clock.hourly`, `email.dmarc.report`, `ops.drill`, `ops.decision.needed` |
| github | Signed push webhooks (`/cue/hooks/github`, `GITHUB_HOOK_SECRET`) on the repos behind every listing surface. Delayed 240 s so the deploy is live | `repo.pushed` |

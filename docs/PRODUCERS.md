# Producers

| Source | How | Events |
|---|---|---|
| lobby | HTTP, `lobby watch-review` hourly on the owner's Mac | `app.review.changed` |
| stage-manager | Service binding, called by Cue's hourly clock; reads App Store Connect in the cloud (github.com/mutaaf/stage-manager) | `app.review.changed` (same ids as lobby, so a change is logged once while both run) |
| cold-gas | Service binding | `coldgas.run.scored` |
| operator | HTTP | `ops.test.alert` |
| cue | Its own clock | `cue.clock.hourly` |

# Producers

| Source | How | Events |
|---|---|---|
| lobby | HTTP, `lobby watch-review` hourly on the owner's Mac | `app.review.changed` |
| cold-gas | Service binding | `coldgas.run.scored` |
| operator | HTTP | `ops.test.alert` |
| cue | Its own clock | `cue.clock.hourly` |

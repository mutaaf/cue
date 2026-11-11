Read [AGENTS.md](AGENTS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Environment nuances

| Nuance | What to do |
|---|---|
| Tokens: `~/.config/cue/tokens` on the owner's Mac holds plaintext (mode 600). The Worker secret `TOKENS` holds only sha-256 hash to source | Add a producer: `sh scripts/add-token.sh <source>`. Never print a token |
| Queue retention is fixed at 24 hours on the free plan | D1 is the durable log, not the queue |
| `send_email` only reaches a verified Email Routing address | The owner's Gmail is verified. A new address needs verifying in the dashboard |
| Secrets in `~/.config/cue/` (mode 600): `vapid.jwk` (Web Push signing key, also secret VAPID_JWK), `pair-secret` (PAIR_SECRET), `github-hook-secret` (GITHUB_HOOK_SECRET, on 12 repos' push hooks) | Rotating the VAPID key unpairs every phone |
| ntfy.sh answers 429 to Workers: Cloudflare's shared egress addresses are rate-limited there | The pager uses Web Push straight to the phone's push service instead |
| zsh doesn't word-split a variable holding a command | Use a function, not `W="npx wrangler"` |
| `wrangler d1 migrations apply --remote` asks for confirmation and, piped through grep, silently applied nothing on the first deploy, so every write threw 1101 | `npm run deploy` pipes `yes` in and ends with a health check |

## Definition of done

- `npm test` passes (CI runs `npm run check` on every PR; main is protected).
- A new event type has a contract in `src/contracts.mjs`, a test, and a row in `docs/PRODUCERS.md`.
- `npm run deploy` applies migrations, deploys and passes the health check.
- A new way this broke goes in `docs/LESSONS.md`, and in a test if a test can catch it.

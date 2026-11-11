# Lessons

What already went wrong here, and what stops it happening again.

| What happened | Why | What changed |
|---|---|---|
| Every write threw error 1101 right after the first deploy | `wrangler d1 migrations apply` asked for confirmation, and a `grep` in the same command hid the prompt, so the tables were never created | `npm run deploy` pipes `yes` into the migration and ends with a health check that writes |
| A deploy command did nothing in zsh | `W="npx wrangler"; $W deploy` doesn't split words in zsh | Shell functions or full commands, never a command in a variable |
| Cloudflare reported the alert email delivered, but it couldn't be found in Gmail | The sending domain has no DMARC record and the message isn't DKIM-signed, so the mailbox may file it anywhere | Closed 2026-11-11: the Nov 9 alert ("Moon Club 0.15.0 is now READY_FOR_SALE") is in the owner's Gmail inbox, Primary. The first one was most likely searched for too soon. SPF/DMARC for the domain is still worth adding before more mail goes out |
| A producer could have claimed another's name | The source came from the request body | The source comes from the service binding's `props` or the hashed token, never the body (tested) |

- 2026-11-11: Cue gained its first runtime dependency (stagehand, from GitHub). CI had run `npm run check` without installing anything, so it would have failed to resolve the import; CI now runs `npm ci` against a committed package-lock.json, and `npm run up`/`npm run deploy` install first.
- 2026-11-11: the first pager used ntfy.sh. Every publish from the Worker got 429, because ntfy.sh rate-limits by IP and Workers share egress addresses. Switched to Web Push (RFC 8030/8291/8292) direct to the phone's push service; a test decrypts the payload the way a browser does.

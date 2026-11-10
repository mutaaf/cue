# Lessons

What already went wrong here, and what stops it happening again.

| What happened | Why | What changed |
|---|---|---|
| Every write threw error 1101 right after the first deploy | `wrangler d1 migrations apply` asked for confirmation, and a `grep` in the same command hid the prompt, so the tables were never created | `npm run deploy` pipes `yes` into the migration and ends with a health check that writes |
| A deploy command did nothing in zsh | `W="npx wrangler"; $W deploy` doesn't split words in zsh | Shell functions or full commands, never a command in a variable |
| Cloudflare reported the alert email delivered, but it couldn't be found in Gmail | The sending domain has no DMARC record and the message isn't DKIM-signed, so the mailbox may file it anywhere | Still open: add SPF/DMARC for mutaafaziz.com, or a second alert channel |
| A producer could have claimed another's name | The source came from the request body | The source comes from the service binding's `props` or the hashed token, never the body (tested) |

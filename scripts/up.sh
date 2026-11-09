#!/bin/sh
# One idempotent command: test, then run locally.
set -eu
npm test --silent
npx --yes wrangler@4 d1 migrations apply cue --local
exec npx --yes wrangler@4 dev

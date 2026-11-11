#!/usr/bin/env node
// Print a pairing link for the Cue pager, valid 14 days. Open it on the phone that should be paged.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pairing } from '../src/webpush.mjs';
const secret = readFileSync(`${homedir()}/.config/cue/pair-secret`, 'utf8').trim();
console.log(`https://mutaafaziz.com/cue/pager?k=${encodeURIComponent(await pairing(secret, Date.now() + 14 * 864e5))}`);

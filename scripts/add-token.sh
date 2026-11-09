#!/bin/sh
# Make a token for a producer and update the Worker's hashed list. Prints no token.
set -eu
SOURCE=${1:?usage: add-token.sh <source>}
DIR="$HOME/.config/cue"; mkdir -p "$DIR"; chmod 700 "$DIR"; F="$DIR/tokens"; touch "$F"; chmod 600 "$F"
grep -q "^$SOURCE=" "$F" || echo "$SOURCE=$(openssl rand -hex 32)" >> "$F"
node -e 'const fs=require("fs"),c=require("crypto"),o={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){const i=l.indexOf("=");if(i>0)o[c.createHash("sha256").update(l.slice(i+1)).digest("hex")]=l.slice(0,i)}process.stdout.write(JSON.stringify(o))' "$F" | npx --yes wrangler@4 secret put TOKENS >/dev/null
echo "token for $SOURCE is in $F, hash uploaded"

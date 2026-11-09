# Cue

The event backbone for the portfolio at [mutaafaziz.com](https://mutaafaziz.com/). Typed events go in, a durable log and subscribers come out. Status: [mutaafaziz.com/cue](https://mutaafaziz.com/cue). The design and its reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Publish from a Worker

```jsonc
// wrangler.jsonc
"services": [{ "binding": "CUE", "service": "cue", "props": { "source": "my-app" } }]
```

```js
ctx.waitUntil(env.CUE.publish({ type: 'coldgas.run.scored', data: { course: 'show', total: 94 } }));
```

## Publish from anything else

```sh
curl -X POST https://mutaafaziz.com/cue/api/publish \
  -H "authorization: Bearer $CUE_TOKEN" \
  -d '{"type":"ops.test.ping","data":{"note":"hello"}}'
```

## Add an event

Add it to `src/contracts.mjs` with the sources allowed to send it, and a test. That's the whole registry.

## Run it

`npm run up` runs the tests and starts it locally. `npm run deploy` tests, migrates and deploys.

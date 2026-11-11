import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, vapid, publicKeyOf, b64u, unb64u, pairing, paired, push } from '../src/webpush.mjs';

const enc = new TextEncoder();
async function hkdf(salt, ikm, info, n) { const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8)); }
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

// The browser's side of RFC 8291, written independently, to prove a phone could read what Cue sends.
async function decrypt(body, ua, auth) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const key = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12) }, key, ct));
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  return new TextDecoder().decode(pt.slice(0, -1));
}

test('a phone can decrypt what Cue encrypts (RFC 8291)', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encrypt('{"title":"hi"}', b64u(await crypto.subtle.exportKey('raw', ua.publicKey)), b64u(auth));
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(await decrypt(body, ua, auth), '{"title":"hi"}');
});

test('the VAPID token verifies with the advertised public key (RFC 8292)', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const t = await vapid('https://web.push.apple.com/abc', jwk, 'mailto:cue@mutaafaziz.com', 0);
  const [h, c, s] = t.split('.');
  assert.equal(JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))).aud, 'https://web.push.apple.com');
  const pub = await crypto.subtle.importKey('raw', unb64u(publicKeyOf(jwk)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(s), enc.encode(`${h}.${c}`)));
});

test('a push carries the vapid header and the aes128gcm encoding', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  let seen; const status = await push({ endpoint: 'https://fcm.googleapis.com/x', p256dh: b64u(await crypto.subtle.exportKey('raw', ua.publicKey)), auth: b64u(new Uint8Array(16)) }, { title: 't' }, await crypto.subtle.exportKey('jwk', kp.privateKey), { f: async (u, o) => { seen = o; return { status: 201 }; } });
  assert.equal(status, 201); assert.match(seen.headers.authorization, /^vapid t=.+, k=.+/); assert.equal(seen.headers['content-encoding'], 'aes128gcm');
});

test('only a fresh pairing link made with the secret pairs a phone', async () => {
  const k = await pairing('s3cret', Date.now() + 60_000);
  assert.equal(await paired('s3cret', k), true);
  assert.equal(await paired('other', k), false);
  assert.equal(await paired('s3cret', k.slice(0, -2) + 'xx'), false);
  assert.equal(await paired('s3cret', await pairing('s3cret', Date.now() - 1)), false);
  assert.equal(await paired('', k), false);
});

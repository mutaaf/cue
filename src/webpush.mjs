// Web Push, by the open standards only: RFC 8030 (delivery), RFC 8291 (aes128gcm payload encryption) and
// RFC 8292 (VAPID). Cue talks straight to the phone's own push service (Apple, Google, Mozilla), so there is
// no third party in between and no account. WebCrypto only, no Cloudflare imports: all of it runs under test.

const enc = new TextEncoder();
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { out.set(x, i); i += x.length; } return out; };

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// RFC 8291: encrypt one record for a subscription's p256dh key and auth secret.
export async function encrypt(payload, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), local = null } = {}) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const as = local ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(secret, ecdh, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, body);
}

// RFC 8292: a short-lived JWT, signed with the server's P-256 key, for the push service's origin.
export async function vapid(endpoint, jwk, subject, now = Date.now()) {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64u(sig)}`;
}

export const publicKeyOf = (jwk) => b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));

// Send one notification. Returns the push service's status: 201 delivered, 404/410 the subscription is gone.
export async function push(sub, message, jwk, { subject = 'mailto:cue@mutaafaziz.com', urgency = 'high', ttl = 86400, f = fetch } = {}) {
  const body = await encrypt(JSON.stringify(message), sub.p256dh, sub.auth);
  const r = await f(sub.endpoint, { method: 'POST', headers: {
    authorization: `vapid t=${await vapid(sub.endpoint, jwk, subject)}, k=${publicKeyOf(jwk)}`,
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttl), urgency,
  }, body });
  return r.status;
}

// Pairing links: only someone holding a link Cue's operator made can add a phone. HMAC over the expiry.
export async function pairing(secret, exp) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${exp}.${b64u(await crypto.subtle.sign('HMAC', key, enc.encode(`pager:${exp}`)))}`;
}
export async function paired(secret, k, now = Date.now()) {
  const exp = Number(String(k ?? '').split('.')[0]);
  if (!secret || !Number.isFinite(exp) || exp < now) return false;
  const want = await pairing(secret, exp);
  if (want.length !== String(k).length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ String(k).charCodeAt(i);
  return d === 0;
}

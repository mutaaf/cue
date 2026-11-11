// DMARC aggregate reports (RFC 7489), mailed by Gmail, Microsoft, Yahoo and others to dmarc@mutaafaziz.com
// and routed to this Worker. They arrive as a zip or gzip of XML. Cue keeps counts only: who reported, how many
// messages passed DMARC (aligned SPF or DKIM) and how many failed. Source IPs never leave this function.
// No Cloudflare imports, so all of it runs under test.

const dec = new TextDecoder();

// The first attachment that looks like a report, as bytes.
export function attachment(raw) {
  const text = typeof raw === 'string' ? raw : dec.decode(raw);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(text)?.[1];
  const parts = boundary ? text.split(`--${boundary}`) : [text];
  for (const part of parts) {
    const head = part.slice(0, Math.max(0, part.search(/\r?\n\r?\n/)));
    if (!/(zip|gzip|xml|octet-stream)/i.test(head)) continue;
    if (/multipart\//i.test(head)) { const inner = attachment(part); if (inner) return inner; continue; }
    const body = part.slice(head.length).trim();
    if (/content-transfer-encoding:\s*base64/i.test(head)) return Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    if (/xml/i.test(head)) return new TextEncoder().encode(body);
  }
  return null;
}

async function inflate(bytes, format) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)));
  return dec.decode(await out.arrayBuffer());
}

// gzip, zip (one entry, deflate or stored) or plain XML → XML text.
export async function unpack(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return inflate(bytes, 'gzip');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Sizes come from the central directory, since a local header may defer them to a data descriptor.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip');
    const cd = v.getUint32(eocd + 16, true);
    const method = v.getUint16(cd + 10, true), size = v.getUint32(cd + 20, true), local = v.getUint32(cd + 42, true);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) return dec.decode(data);
    if (method === 8) return inflate(data, 'deflate-raw');
    throw new Error(`zip method ${method}`);
  }
  return dec.decode(bytes);
}

const tag = (xml, name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? '';

export function summarize(xml) {
  const meta = tag(xml, 'report_metadata') || xml;
  const org = tag(meta, 'org_name').slice(0, 60) || 'unknown';
  const id = `${org}:${tag(meta, 'report_id')}`.replace(/[^\w.:@-]/g, '_').slice(0, 120);
  const begin = Number(tag(meta, 'begin'));
  let pass = 0, fail = 0;
  for (const rec of xml.split(/<record>/).slice(1)) {
    const n = Number(tag(rec, 'count')) || 0, pe = tag(rec, 'policy_evaluated') ? rec.split('<policy_evaluated>')[1] : rec;
    if (tag(pe, 'dkim') === 'pass' || tag(pe, 'spf') === 'pass') pass += n; else fail += n;
  }
  return { id, org, day: Number.isFinite(begin) && begin > 0 ? new Date(begin * 1000).toISOString().slice(0, 10) : null, pass, fail };
}

export async function readReport(raw) {
  const bytes = attachment(raw);
  if (!bytes) return null;
  return summarize(await unpack(bytes));
}

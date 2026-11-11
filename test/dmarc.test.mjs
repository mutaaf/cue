import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { attachment, unpack, summarize, readReport } from '../src/dmarc.mjs';

const XML = `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><report_id>123</report_id><date_range><begin>1762819200</begin><end>1762905599</end></date_range></report_metadata>
<record><row><source_ip>203.0.113.9</source_ip><count>3</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row></record>
<record><row><source_ip>198.51.100.4</source_ip><count>2</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><auth_results><dkim><result>pass</result></dkim></auth_results></record></feedback>`;

function zip(name, data) {
  const comp = deflateRawSync(data), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + n.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, n, comp, cd, n, eocd]);
}
const mail = (type, bytes) => `From: noreply-dmarc-support@google.com\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nreport\r\n--b1\r\nContent-Type: ${type}; name="r"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n--b1--\r\n`;

test('a report counts aligned passes and failures', () => assert.deepEqual(summarize(XML), { id: 'google.com:123', org: 'google.com', day: '2025-11-11', pass: 3, fail: 2 }));
test('dkim in auth_results does not count: only the policy evaluation does', () => assert.equal(summarize(XML).fail, 2));
test('a gzip report is read', async () => assert.equal((await readReport(mail('application/gzip', gzipSync(XML)))).pass, 3));
test('a zip report is read', async () => assert.equal((await readReport(mail('application/zip', zip('r.xml', Buffer.from(XML))))).fail, 2));
test('a mail with no report reads as nothing', async () => assert.equal(await readReport('Content-Type: text/plain\r\n\r\nhello'), null));
test('source addresses never leave the parser', () => assert.ok(!JSON.stringify(summarize(XML)).includes('203.0.113')));
test('plain xml unpacks as itself', async () => assert.equal(await unpack(new TextEncoder().encode('<a/>')), '<a/>'));
test('attachment finds the base64 part', () => assert.ok(attachment(mail('application/gzip', gzipSync(XML)))?.length > 10));

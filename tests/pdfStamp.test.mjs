// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import {
  buildSecuredPdf,
  extractTrace,
  fingerprintOf,
  fingerprintBitsForPage,
  generateLicenseId,
  toPdfText,
  formatIST,
  pageGeometry,
  wrapText
} from '../lib/pdfStamp.js';

const USER = { userId: '65f1c0a2b3d4e5f601234567', name: 'Ashank Mishra', email: 'ashank@example.com', mobile: '+919876543210' };

async function makeSource(pages) {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([p.w ?? 595, p.h ?? 842]);
    if (p.crop) page.setCropBox(...p.crop);
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  return doc.save();
}

test('license ids are readable and unique', () => {
  const ids = new Set(Array.from({ length: 500 }, generateLicenseId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^DH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test('toPdfText never returns anything Helvetica (WinAnsi) cannot encode', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  const nasty = ['Ramānujan', 'आशंक मिश्रा', 'Ashank 🙂', 'José Álvarez', 'Łukasz', '中文名字', '', null, undefined, 'a\u0000b‮c'];
  for (const raw of nasty) {
    const safe = toPdfText(raw);
    assert.doesNotThrow(() => page.drawText(safe, { font, size: 9 }), `failed for ${JSON.stringify(raw)}`);
  }
  assert.equal(toPdfText('Ramānujan'), 'Ramanujan');
  assert.equal(toPdfText('आशंक मिश्रा'), 'N/A');
  assert.equal(toPdfText('आशंक', 'Student'), 'Student');
});

test('formatIST converts UTC to Indian time', () => {
  assert.equal(formatIST(new Date('2026-09-25T09:15:00Z')), '25 Sep 2026, 14:45 IST');
  assert.equal(formatIST(new Date('2026-12-31T20:00:00Z')), '01 Jan 2027, 01:30 IST');
});

test('wrapText wraps by width and never drops words', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapText('one two three four five six seven eight nine ten', 60, font, 9);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(' '), 'one two three four five six seven eight nine ten');
});

test('fingerprint bits cycle through all 32 bits in 16 pages', () => {
  const fp = fingerprintOf('DH-AAAA-BBBB-CCCC');
  let rebuilt = 0;
  for (let page = 0; page < 16; page++) {
    const [b0, b1] = fingerprintBitsForPage(fp, page);
    rebuilt |= b0 << (page * 2);
    rebuilt |= b1 << (page * 2 + 1);
  }
  assert.equal(rebuilt >>> 0, fp);
});

test('pageGeometry maps displayed coordinates for every rotation and round-trips', async () => {
  const doc = await PDFDocument.create();
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([600, 800]);
    page.setCropBox(20, 30, 500, 700);
    page.setRotation(degrees(rot));
    const geo = pageGeometry(page);
    const sideways = rot === 90 || rot === 270;
    assert.equal(geo.dw, sideways ? 700 : 500);
    assert.equal(geo.dh, sideways ? 500 : 700);
    for (const [vx, vy] of [[0, 0], [10, 40], [geo.dw, geo.dh], [geo.dw / 2, geo.dh / 2]]) {
      const { x, y } = geo.toUser(vx, vy);
      const back = geo.fromUser(x, y);
      assert.ok(Math.abs(back.vx - vx) < 1e-9 && Math.abs(back.vy - vy) < 1e-9, `round trip failed rot=${rot}`);
    }
  }
});

test('buildSecuredPdf stamps every page and inserts licence pages (mixed page types, hostile names)', async () => {
  const src = await makeSource([
    { }, { w: 842, h: 595 }, { rotate: 90 }, { rotate: 180 }, { rotate: 270 },
    { w: 700, h: 900, crop: [60, 80, 500, 700] }, { w: 300, h: 420 }
  ]);
  const license = { licenseId: generateLicenseId(), issuedAt: new Date('2026-09-25T09:15:00Z') };
  const user = { ...USER, name: 'Ramānujan आशंक 🙂 "; rm -rf / #' };

  const out = await buildSecuredPdf({ sources: [src], user, license, docInfo: { title: 'Test Course' } });
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 7 + 1, '7 source pages + 1 licence page (floor(7/50) -> min 1)');
  assert.equal(doc.getTitle(), 'Test Course');
  assert.match(doc.getKeywords(), new RegExp(license.licenseId));

  const trace = await extractTrace(out);
  assert.equal(trace.licenseId, license.licenseId);
  assert.equal(trace.userId, USER.userId);
  assert.equal(trace.stampedPages, 7);
});

test('the per-page position fingerprint fully recovers the license fingerprint', async () => {
  const src = await makeSource(Array.from({ length: 20 }, () => ({})));
  const license = { licenseId: generateLicenseId(), issuedAt: new Date() };
  const out = await buildSecuredPdf({ sources: [src], user: USER, license });
  const trace = await extractTrace(out);
  assert.equal(trace.stampedPages, 20);
  assert.equal(trace.fingerprintBitsSeen, 32);
  assert.equal(trace.fingerprint, fingerprintOf(license.licenseId));
});

test('two downloads of the same pdf carry different traces', async () => {
  const src = await makeSource(Array.from({ length: 16 }, () => ({})));
  const a = await extractTrace(await buildSecuredPdf({ sources: [src], user: USER, license: { licenseId: generateLicenseId(), issuedAt: new Date() } }));
  const b = await extractTrace(await buildSecuredPdf({ sources: [src], user: USER, license: { licenseId: generateLicenseId(), issuedAt: new Date() } }));
  assert.notEqual(a.licenseId, b.licenseId);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('multiple source parts are merged in order and numbered continuously', async () => {
  const a = await makeSource([{}, {}]);
  const b = await makeSource([{}, {}, {}]);
  const out = await buildSecuredPdf({ sources: [a, b], user: USER, license: { licenseId: generateLicenseId(), issuedAt: new Date() } });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 5 + 1);
  assert.equal((await extractTrace(out)).stampedPages, 5);
});

// Shared PDF licensing/stamping pipeline.
//
// Used by BOTH the GitHub Actions worker (scripts/process-pdf.js) and the server-side fallback in
// courseController.js, so the watermark layout is defined exactly once. Everything drawn here is
// derived from the *displayed* page (after /Rotate, inside the CropBox), so it lands in the same
// place on portrait, landscape, rotated and offset-box pages.
//
// Per stamped page we draw:
//   1. VISIBLE  centred watermark      - "Name | Email | Mobile", 9pt grey, exact page centre
//   2. VISIBLE  bottom credentials strip - licensee, user id, License ID, download time, page
//   3. VISIBLE  barcode (user id), bottom right
//   4. HIDDEN   License ID micro-text  - 1pt, invisible render mode (extractable, never painted)
//   5. HIDDEN   position fingerprint   - sub-point offsets of the barcode and hidden text encode 2
//                                        bits of a per-download 32-bit code on every page
// Hidden marks add roughly 150 bytes per page.

import { createHash, randomBytes } from 'crypto';
import bwipjs from 'bwip-js';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFArray,
  decodePDFRawStream,
  rgb,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  setTextRenderingMode,
  TextRenderingMode
} from 'pdf-lib';

// ---------- constants (layout) ----------
export const WATERMARK_SIZE = 9;
export const WATERMARK_COLOR = rgb(0.6, 0.6, 0.6);
const WATERMARK_LINE_HEIGHT = 12;
const WATERMARK_SIDE_MARGIN = 30;

const STRIP_SIZE = 7;
const STRIP_COLOR = rgb(0.45, 0.45, 0.45);
const STRIP_LINE_HEIGHT = 9;
const STRIP_LEFT = 25;
const STRIP_BOTTOM = 14;

const BARCODE_W = 90;
const BARCODE_H = 20;
const BARCODE_RIGHT_MARGIN = 25;
const BARCODE_BOTTOM = 15;

// Hidden mark placement (displayed coordinates) and the size of a fingerprint nudge, in points.
export const TRACE_BASE_X = 36;
export const TRACE_BASE_Y = 6;
export const FINGERPRINT_STEP = 0.5;
export const TRACE_PREFIX = 'DHL';

// ---------- license id + fingerprint ----------
const LICENSE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - easy to read off a page

export function generateLicenseId() {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => LICENSE_ALPHABET[b % LICENSE_ALPHABET.length]);
  return `DH-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

// 32-bit code derived from the license id. Two bits of it are carried by every stamped page.
export function fingerprintOf(licenseId) {
  return createHash('sha256').update(String(licenseId)).digest().readUInt32BE(0);
}

// Which two fingerprint bits page `pageIndex` (0-based, among stamped pages) carries.
export function fingerprintBitsForPage(fingerprint, pageIndex) {
  const lo = (pageIndex * 2) % 32;
  return [(fingerprint >>> lo) & 1, (fingerprint >>> ((lo + 1) % 32)) & 1];
}

// ---------- text safety ----------
// The standard Helvetica font only encodes WinAnsi. drawText() THROWS on anything else (Devanagari,
// "ā", emoji, ...), which used to fail the whole download job for those students. We fold accents
// (Ramānujan -> Ramanujan), drop what cannot be represented, and fall back if nothing is left.
export function toPdfText(value, fallback = 'N/A') {
  if (value === undefined || value === null) return fallback;
  const folded = String(value).normalize('NFKD').replace(/\p{M}+/gu, '');
  let out = '';
  for (const ch of folded) {
    const cp = ch.codePointAt(0);
    const ascii = cp >= 0x20 && cp <= 0x7e;
    const latin1Letter = cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7;
    if (ascii || latin1Letter) out += ch;
    else if (/\s/u.test(ch)) out += ' ';
  }
  out = out.replace(/ +/g, ' ').trim();
  return out || fallback;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatIST(date) {
  const d = new Date(new Date(date).getTime() + 330 * 60 * 1000); // UTC+05:30, no ICU needed
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

export function wrapText(text, maxWidth, font, fontSize) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ---------- page geometry ----------
// Returns the displayed size and a function mapping "as the viewer sees it" coordinates (origin at the
// bottom-left of the displayed page) back into PDF user space, plus the inverse for the tracer.
export function pageGeometry(page) {
  let box;
  try {
    box = page.getCropBox();
  } catch {
    box = page.getMediaBox();
  }
  if (!box || !(box.width > 0) || !(box.height > 0)) box = { x: 0, y: 0, width: 595.28, height: 841.89 };

  let rot = ((page.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rot)) rot = 0;
  const sideways = rot === 90 || rot === 270;

  const toUser = (vx, vy) => {
    switch (rot) {
      case 90: return { x: box.x + box.width - vy, y: box.y + vx };
      case 180: return { x: box.x + box.width - vx, y: box.y + box.height - vy };
      case 270: return { x: box.x + vy, y: box.y + box.height - vx };
      default: return { x: box.x + vx, y: box.y + vy };
    }
  };
  const fromUser = (x, y) => {
    const rx = x - box.x;
    const ry = y - box.y;
    switch (rot) {
      case 90: return { vx: ry, vy: box.width - rx };
      case 180: return { vx: box.width - rx, vy: box.height - ry };
      case 270: return { vx: box.height - ry, vy: rx };
      default: return { vx: rx, vy: ry };
    }
  };
  return {
    rot,
    dw: sideways ? box.height : box.width,
    dh: sideways ? box.width : box.height,
    toUser,
    fromUser
  };
}

function drawText(page, geo, text, { vx, vy, size, font, color }) {
  const { x, y } = geo.toUser(vx, vy);
  page.drawText(text, { x, y, size, font, color, rotate: degrees(geo.rot) });
}

// ---------- the per-page stamp ----------
export function buildStampLines(ctx) {
  const name = toPdfText(ctx.user.name, 'N/A');
  const email = toPdfText(ctx.user.email, 'N/A');
  const mobile = toPdfText(ctx.user.mobile, 'N/A');
  return {
    watermark: `Name: ${name}  |  Email: ${email}  |  Mobile: ${mobile}`,
    strip1: `Licensed to: ${name}  |  ${email}  |  ${mobile}`,
    strip2: (pageNo, pageTotal) =>
      `User ID: ${toPdfText(ctx.user.userId)}  |  License ID: ${ctx.license.licenseId}  |  Downloaded: ${formatIST(ctx.license.issuedAt)}  |  Pg ${pageNo}/${pageTotal}`
  };
}

export function traceString(ctx, pageNo) {
  return `${TRACE_PREFIX}|${ctx.license.licenseId}|${ctx.user.userId}|${pageNo}`;
}

/**
 * Stamps one page. `pageIndex` counts stamped pages from 0 (used for the fingerprint),
 * `pageTotal` is how many pages will be stamped in the whole document.
 */
export function stampPage(page, { ctx, fonts, barcodeImage, pageIndex, pageTotal, lines }) {
  const geo = pageGeometry(page);
  const { dw, dh } = geo;
  const fingerprint = fingerprintOf(ctx.license.licenseId);
  const [bitX, bitY] = fingerprintBitsForPage(fingerprint, pageIndex);

  // 1. Centred watermark - same 9pt grey text as before, wrapped (never shrunk) if wider than the page.
  const wmLines = wrapText(lines.watermark, Math.max(120, dw - 2 * WATERMARK_SIDE_MARGIN), fonts.regular, WATERMARK_SIZE);
  const blockHeight = wmLines.length * WATERMARK_LINE_HEIGHT;
  // Baseline of the first line so the whole block is centred (cap-height is ~0.72em, hence the 3pt nudge).
  const firstBaseline = dh / 2 + blockHeight / 2 - WATERMARK_LINE_HEIGHT + 3;
  wmLines.forEach((line, i) => {
    const w = fonts.regular.widthOfTextAtSize(line, WATERMARK_SIZE);
    drawText(page, geo, line, {
      vx: (dw - w) / 2,
      vy: firstBaseline - i * WATERMARK_LINE_HEIGHT,
      size: WATERMARK_SIZE,
      font: fonts.regular,
      color: WATERMARK_COLOR
    });
  });

  // 2. Bottom strip, left of the barcode. Stacked upwards from the bottom edge.
  const stripMaxWidth = Math.max(120, dw - STRIP_LEFT - BARCODE_W - BARCODE_RIGHT_MARGIN - 12);
  const stripLines = [
    ...wrapText(lines.strip1, stripMaxWidth, fonts.regular, STRIP_SIZE),
    ...wrapText(lines.strip2(pageIndex + 1, pageTotal), stripMaxWidth, fonts.regular, STRIP_SIZE)
  ];
  stripLines.slice().reverse().forEach((line, i) => {
    drawText(page, geo, line, {
      vx: STRIP_LEFT,
      vy: STRIP_BOTTOM + i * STRIP_LINE_HEIGHT,
      size: STRIP_SIZE,
      font: fonts.regular,
      color: STRIP_COLOR
    });
  });

  // 3. Barcode (user id), bottom right. Its position carries the fingerprint bits.
  if (barcodeImage) {
    const { x, y } = geo.toUser(
      dw - BARCODE_W - BARCODE_RIGHT_MARGIN + bitX * FINGERPRINT_STEP,
      BARCODE_BOTTOM + bitY * FINGERPRINT_STEP
    );
    page.drawImage(barcodeImage, { x, y, width: BARCODE_W, height: BARCODE_H, rotate: degrees(geo.rot) });
  }

  // 4 + 5. Hidden trace: 1pt text in the invisible render mode, nudged by the same fingerprint bits.
  const { x: tx, y: ty } = geo.toUser(TRACE_BASE_X + bitX * FINGERPRINT_STEP, TRACE_BASE_Y + bitY * FINGERPRINT_STEP);
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
  page.drawText(traceString(ctx, pageIndex + 1), {
    x: tx,
    y: ty,
    size: 1,
    font: fonts.regular,
    color: rgb(0, 0, 0),
    rotate: degrees(geo.rot)
  });
  page.pushOperators(popGraphicsState());
}

// ---------- the licence / warning page ----------
export function drawWarningPage(page, ctx, fonts, docInfo = {}) {
  const { width, height } = page.getSize();
  const { regular: font, bold: boldFont } = fonts;

  page.drawRectangle({ x: 40, y: 40, width: width - 80, height: height - 80, borderColor: rgb(0.8, 0.2, 0.2), borderWidth: 2.5, color: rgb(0.99, 0.98, 0.98) });
  page.drawRectangle({ x: 40, y: height - 90, width: width - 80, height: 50, color: rgb(0.75, 0.15, 0.15) });

  const title = 'SECURITY NOTICE & LICENSE AGREEMENT';
  page.drawText(title, { x: (width - boldFont.widthOfTextAtSize(title, 13)) / 2, y: height - 70, size: 13, font: boldFont, color: rgb(1, 1, 1) });

  let y = height - 120;
  page.drawText('LICENSE REGISTRATION DETAILS', { x: 60, y, size: 11, font: boldFont, color: rgb(0.2, 0.2, 0.2) });
  y -= 25;

  const details = [
    ['Authorized Licensee:', toPdfText(ctx.user.name)],
    ['Registered Email:', toPdfText(ctx.user.email)],
    ['Mobile Number:', toPdfText(ctx.user.mobile)],
    ['User ID:', toPdfText(ctx.user.userId)],
    ['License ID:', ctx.license.licenseId],
    ['Issued On:', formatIST(ctx.license.issuedAt)],
    ['Document Name:', toPdfText(docInfo.title)]
  ];
  for (const [label, value] of details) {
    page.drawText(label, { x: 70, y, size: 9.5, font: boldFont, color: rgb(0.35, 0.35, 0.35) });
    page.drawText(value, { x: 210, y, size: 9.5, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 18;
  }

  y -= 15;
  page.drawLine({ start: { x: 60, y }, end: { x: width - 60, y }, color: rgb(0.85, 0.85, 0.85), thickness: 1 });
  y -= 25;
  page.drawText('LEGAL TERMS & SHARE RESTRICTIONS', { x: 60, y, size: 11, font: boldFont, color: rgb(0.75, 0.15, 0.15) });
  y -= 20;

  const paragraphs = [
    '1. LICENSED USE: This document is uniquely registered to the individual named above and is intended solely for the registered user’s personal educational use.',
    '2. PROHIBITED SHARING: It is strictly prohibited to share, publish, distribute, resell, or upload this PDF to any private/public forum, website, Telegram channel, Google Drive, WhatsApp group, or social media platform.',
    '3. SECURITY TRACING: This document carries visible watermarks and additional hidden tracking marks that are tied to the License ID above. Any leaked copy can be traced back to the licensee.',
    '4. LEGAL CONSEQUENCES: Unauthorized sharing, distribution and reproduction of this document constitutes a breach of this license agreement. Violations will result in immediate termination of access without refund and initiation of appropriate legal proceedings.'
  ];
  for (const p of paragraphs) {
    for (const line of wrapText(p, width - 120, font, 9)) {
      page.drawText(line, { x: 65, y, size: 9, font, color: rgb(0.25, 0.25, 0.25) });
      y -= 14;
    }
    y -= 6;
  }
  y -= 10;

  const note = 'NOTE - This document is individually licensed and embedded with traceable ownership credentials, both VISIBLE and HIDDEN, based on the License ID. Any unauthorized acquisition and distribution will result in enforcement of appropriate legal remedies, without further notice.';
  const noteLines = wrapText(note, width - 150, boldFont, 8.5);
  const pad = 10;
  const boxH = noteLines.length * 13 + pad * 2;
  const boxY = y - boxH;
  page.drawRectangle({ x: 60, y: boxY, width: width - 120, height: boxH, color: rgb(0.98, 0.94, 0.88), borderColor: rgb(0.85, 0.55, 0.1), borderWidth: 1 });
  let ny = y - pad - 2;
  for (const line of noteLines) {
    page.drawText(line, { x: 70, y: ny, size: 8.5, font: boldFont, color: rgb(0.55, 0.32, 0.02) });
    ny -= 13;
  }

  const footer = "Thank you for supporting honest learning and respecting authors' copy rights.";
  page.drawText(footer, { x: (width - font.widthOfTextAtSize(footer, 8.5)) / 2, y: boxY - 15, size: 8.5, font, color: rgb(0.5, 0.5, 0.5) });
}

// ---------- barcode ----------
export function makeBarcodePng(text) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer(
      { bcid: 'code128', text: String(text), scale: 2, height: 10, includetext: true, textxalign: 'center' },
      (err, png) => (err ? reject(err) : resolve(png))
    );
  });
}

// ---------- the whole pipeline ----------
/**
 * @param {object} opts
 * @param {Array<Uint8Array|Buffer>} opts.sources  raw PDF bytes, in order
 * @param {{userId:string,name:string,email:string,mobile?:string}} opts.user
 * @param {{licenseId:string,issuedAt:Date}} opts.license
 * @param {{title?:string,subject?:string}} [opts.docInfo]
 * @param {(step:'barcode'|'stamping'|'saving')=>Promise<void>|void} [opts.onStep]
 * @returns {Promise<Uint8Array>} the stamped, UNENCRYPTED pdf
 */
export async function buildSecuredPdf({ sources, user, license, docInfo = {}, onStep }) {
  const ctx = { user, license };
  const loaded = [];
  for (const bytes of sources) loaded.push(await PDFDocument.load(bytes));

  if (onStep) await onStep('barcode');
  const barcodePng = await makeBarcodePng(user.userId);

  if (onStep) await onStep('stamping');
  const out = await PDFDocument.create();
  const barcodeImage = await out.embedPng(barcodePng);
  const fonts = { regular: await out.embedFont('Helvetica'), bold: await out.embedFont('Helvetica-Bold') };
  const lines = buildStampLines(ctx);

  const pageTotal = loaded.reduce((n, d) => n + d.getPageCount(), 0);

  out.setTitle(toPdfText(docInfo.title, 'Secured Course PDF'));
  out.setAuthor(user.email);
  out.setSubject(`License ${license.licenseId}`);
  out.setProducer('The Dark Horse UPSC');
  out.setCreator('The Dark Horse UPSC');
  out.setKeywords([user.userId, user.email, license.licenseId]);
  out.setCreationDate(new Date(license.issuedAt));
  out.setModificationDate(new Date(license.issuedAt));

  let pageIndex = 0;
  for (const doc of loaded) {
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) {
      stampPage(page, { ctx, fonts, barcodeImage, pageIndex, pageTotal, lines });
      out.addPage(page);
      pageIndex++;
    }
  }

  // Licence/warning pages: the first always lands on page 2, the rest at random positions.
  if (pageTotal > 0) {
    const { width, height } = out.getPages()[0].getSize();
    const extra = Math.max(1, Math.floor(pageTotal / 50));
    const insertAt = [1];
    let count = pageTotal + 1;
    for (let j = 1; j < extra; j++) {
      insertAt.push(Math.floor(Math.random() * (count - 2 + 1)) + 2);
      count++;
    }
    insertAt.sort((a, b) => a - b);
    for (const idx of insertAt) {
      drawWarningPage(out.insertPage(idx, [width, height]), ctx, fonts, docInfo);
    }
  }

  if (onStep) await onStep('saving');
  return out.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// ---------- tracer (admin tooling + tests) ----------
function decodedPageContent(pdfDoc, page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdfDoc.context.lookup(r)) : [contents];
  let text = '';
  for (const s of streams) {
    if (!s) continue;
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents?.();
    if (bytes) text += Buffer.from(bytes).toString('latin1') + '\n';
  }
  return text;
}

/**
 * Reads back the hidden marks from an UNENCRYPTED pdf produced by buildSecuredPdf. Real downloads are
 * password protected, so decrypt them first (e.g. `qpdf --password=... --decrypt in.pdf out.pdf`).
 * Returns { licenseId, userId, stampedPages, fingerprint, fingerprintBitsSeen }.
 */
export async function extractTrace(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const found = { licenseId: null, userId: null, stampedPages: 0, fingerprint: 0, fingerprintBitsSeen: 0 };
  const seen = new Set();
  // Anchor on our own marker (the hex of "DHL|") instead of any invisible text: OCR'd PDFs also use render mode 3.
  const markerHex = Buffer.from(`${TRACE_PREFIX}|`, 'latin1').toString('hex').toUpperCase();
  const markerRe = new RegExp(`<(${markerHex}[0-9A-Fa-f]*)> Tj`, 'i');
  const tmRe = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g;

  for (const page of doc.getPages()) {
    const content = decodedPageContent(doc, page);
    const marker = markerRe.exec(content);
    if (!marker) continue; // warning pages carry no trace
    // The text matrix that positions it is the last Tm before the show-text operator.
    let m = null;
    for (const t of content.slice(Math.max(0, marker.index - 600), marker.index).matchAll(tmRe)) m = t;
    if (!m) continue;
    const decoded = Buffer.from(marker[1], 'hex').toString('latin1');
    const parts = decoded.split('|');

    found.licenseId = found.licenseId || parts[1];
    found.userId = found.userId || parts[2];
    const pageIndex = Number(parts[3]) - 1;
    found.stampedPages++;

    const { vx, vy } = pageGeometry(page).fromUser(Number(m[5]), Number(m[6]));
    const bitX = vx - TRACE_BASE_X > FINGERPRINT_STEP / 2 ? 1 : 0;
    const bitY = vy - TRACE_BASE_Y > FINGERPRINT_STEP / 2 ? 1 : 0;
    const lo = (pageIndex * 2) % 32;
    for (const [offset, bit] of [[0, bitX], [1, bitY]]) {
      const pos = (lo + offset) % 32;
      seen.add(pos);
      if (bit) found.fingerprint = (found.fingerprint | (1 << pos)) >>> 0;
    }
  }
  found.fingerprintBitsSeen = seen.size;
  return found;
}

export { PDFName }; // re-exported for tests that build synthetic PDFs

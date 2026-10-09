import { PDFDocument } from 'pdf-lib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';

// The PDF a student gets for a topic whose subject they haven't bought: same page count
// as the original (so the viewer's absolute page numbers still work), but every page
// outside the free-preview answers is an empty page of the same size. Paid copies never
// leave the server, even through the network tab.
//
// Compendium PDFs are big scans shared by every topic of a section, so results are
// cached in memory, keyed by the topic and its last edit.
const CACHE_MAX = 12;
const cache = new Map();

export const buildPreviewPdf = async (doc, ranges) => {
  const allowed = new Set();
  for (const [start, end] of ranges) {
    for (let p = start; p <= end; p++) allowed.add(p);
  }
  const key = `${doc._id}:${doc.pdfKey}:${new Date(doc.updatedAt || 0).getTime()}:${[...allowed].sort((a, b) => a - b).join(',')}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit;
  }

  const obj = await r2Client.send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: doc.pdfKey.replace('r2://', ''),
  }));
  const src = await PDFDocument.load(await obj.Body.transformToByteArray(), { ignoreEncryption: true });

  const out = await PDFDocument.create();
  const total = src.getPageCount();
  const keep = [...allowed].filter((p) => p >= 1 && p <= total).map((p) => p - 1);
  const copied = new Map((await out.copyPages(src, keep)).map((page, i) => [keep[i], page]));
  for (let i = 0; i < total; i++) {
    if (copied.has(i)) out.addPage(copied.get(i));
    else out.addPage([src.getPage(i).getWidth(), src.getPage(i).getHeight()]);
  }
  const bytes = Buffer.from(await out.save());

  cache.set(key, bytes);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return bytes;
};

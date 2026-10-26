// Toppers Copy — "Best part of the answer" crops (see models/ToppersBestPart.js).
// The admin drags a box over a topper's answer page; the browser renders that region
// to a PNG and uploads it here.
//
//   GET    /api/toppers-copy/admin/:id/best-parts             all crops of a topic
//   POST   /api/toppers-copy/admin/:id/best-parts             multipart: image, questionId, page, rect, caption, topperName
//   PATCH  /api/toppers-copy/admin/best-parts/:bid            caption / order
//   DELETE /api/toppers-copy/admin/best-parts/:bid
//   GET    /api/toppers-copy/best-parts/:bid/image            stream the PNG (?token= ok, for <img>)
//
// Students receive them inline with GET /api/toppers-copy/:id (see bestPartsByQuestion).

import fs from 'fs/promises';
import crypto from 'crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersBestPart from '../models/ToppersBestPart.js';
import { requireAdmin, isAdminRequest } from './progressController.js';

const MAX_PER_QUESTION = 6;
const safeUnlink = (p) => (p ? fs.unlink(p).catch(() => {}) : Promise.resolve());
const frac = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

const publicShape = (b) => ({
  _id: b._id,
  questionId: b.questionId,
  page: b.page,
  rect: b.rect,
  topperName: b.topperName,
  caption: b.caption,
  width: b.width,
  height: b.height,
  order: b.order,
});

/**
 * Map questionId → [best parts], for attaching to questions in GET /:id. A crop whose
 * questionId no longer exists (question re-created by an import) is placed under the
 * question whose answer page range holds its page.
 */
export const bestPartsByQuestion = async (doc) => {
  const rows = await ToppersBestPart.find({ toppersCopy: doc._id }).sort({ order: 1, createdAt: 1 }).lean();
  const out = new Map();
  if (!rows.length) return out;
  const ids = new Set((doc.questions || []).map((q) => String(q._id)));
  const byPage = (page) => (doc.questions || []).find((q) =>
    (q.answers || []).some((a) => a.startPage && page >= a.startPage && page <= (a.endPage || a.startPage)));
  for (const r of rows) {
    const qid = ids.has(String(r.questionId)) ? String(r.questionId) : (byPage(r.page) ? String(byPage(r.page)._id) : null);
    if (!qid) continue;
    if (!out.has(qid)) out.set(qid, []);
    out.get(qid).push(publicShape(r));
  }
  return out;
};

// GET /admin/:id/best-parts
export const listBestParts = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const rows = await ToppersBestPart.find({ toppersCopy: req.params.id }).sort({ order: 1, createdAt: 1 }).lean();
    res.json({ bestParts: rows.map(publicShape) });
  } catch (err) {
    console.error('listBestParts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /admin/:id/best-parts
export const createBestPart = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'An image is required' });

  try {
    const doc = await ToppersCopy.findById(req.params.id).select('questions._id').lean();
    if (!doc) { await safeUnlink(file.path); return res.status(404).json({ error: 'Not found' }); }
    const questionId = String(req.body.questionId || '');
    if (!doc.questions.some((q) => String(q._id) === questionId)) {
      await safeUnlink(file.path);
      return res.status(400).json({ error: 'Question not found in this topic' });
    }
    const count = await ToppersBestPart.countDocuments({ toppersCopy: doc._id, questionId });
    if (count >= MAX_PER_QUESTION) {
      await safeUnlink(file.path);
      return res.status(400).json({ error: `Up to ${MAX_PER_QUESTION} best parts per question.` });
    }

    let rect = {};
    try { rect = JSON.parse(req.body.rect || '{}'); } catch { /* keep defaults */ }

    const key = `tc-best-parts/${doc._id}/${crypto.randomUUID()}.png`;
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: await fs.readFile(file.path),
      ContentType: file.mimetype || 'image/png',
    }));
    await safeUnlink(file.path);

    const part = await ToppersBestPart.create({
      toppersCopy: doc._id,
      questionId,
      page: Number(req.body.page) || 0,
      rect: { x: frac(rect.x, 0), y: frac(rect.y, 0), w: frac(rect.w, 1), h: frac(rect.h, 1) },
      topperName: String(req.body.topperName || '').slice(0, 120),
      caption: String(req.body.caption || '').slice(0, 300),
      key: `r2://${key}`,
      width: Number(req.body.width) || 0,
      height: Number(req.body.height) || 0,
      order: count,
    });
    res.json({ bestPart: publicShape(part) });
  } catch (err) {
    await safeUnlink(file.path);
    console.error('createBestPart error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
};

// PATCH /admin/best-parts/:bid
export const updateBestPart = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const part = await ToppersBestPart.findById(req.params.bid);
    if (!part) return res.status(404).json({ error: 'Not found' });
    if (typeof req.body.caption === 'string') part.caption = req.body.caption.slice(0, 300);
    if (Number.isFinite(Number(req.body.order))) part.order = Number(req.body.order);
    await part.save();
    res.json({ bestPart: publicShape(part) });
  } catch (err) {
    console.error('updateBestPart error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// DELETE /admin/best-parts/:bid
export const deleteBestPart = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const part = await ToppersBestPart.findById(req.params.bid);
    if (!part) return res.status(404).json({ error: 'Not found' });
    if (part.key?.startsWith('r2://')) {
      await r2Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: part.key.replace('r2://', ''),
      })).catch((e) => console.warn('best part r2 delete failed:', e.message));
    }
    await part.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteBestPart error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /best-parts/:bid/image — students only for published topics.
export const streamBestPartImage = async (req, res) => {
  try {
    const part = await ToppersBestPart.findById(req.params.bid).lean();
    if (!part?.key?.startsWith('r2://')) return res.status(404).json({ error: 'Not found' });
    const doc = await ToppersCopy.findById(part.toppersCopy).select('published').lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (!doc.published && !(await isAdminRequest(req))) return res.status(403).json({ error: 'Not available' });

    const r2Response = await r2Client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: part.key.replace('r2://', ''),
    }));
    if (r2Response.ContentType) res.setHeader('Content-Type', r2Response.ContentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (r2Response.ContentLength != null) res.setHeader('Content-Length', r2Response.ContentLength);
    r2Response.Body.pipe(res);
  } catch (err) {
    console.error('streamBestPartImage error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Toppers Copy — per-topic "Value addition" (see models/ToppersValueAddition.js).
//
//   GET    /api/toppers-copy/admin/:id/value-additions          all entries of a topic (drafts too)
//   POST   /api/toppers-copy/admin/:id/value-additions          multipart: title, body, published, pdf?
//   PATCH  /api/toppers-copy/admin/value-additions/:vid         multipart: title / body / published / order / pdf? / removePdf
//   DELETE /api/toppers-copy/admin/value-additions/:vid
//   GET    /api/toppers-copy/value-additions/:vid/pdf           Range-aware inline stream
//
// Students receive the published ones inline with GET /api/toppers-copy/:id (valueAdditionsFor).

import fs from 'fs/promises';
import crypto from 'crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersValueAddition from '../models/ToppersValueAddition.js';
import { requireAdmin, isAdminRequest } from './progressController.js';

const MAX_PER_TOPIC = 30;
const safeUnlink = (p) => (p ? fs.unlink(p).catch(() => {}) : Promise.resolve());
const asBool = (v) => v === true || v === 'true' || v === '1';

const publicShape = (v) => ({
  _id: v._id,
  title: v.title,
  body: v.body,
  hasPdf: !!v.pdfKey,
  pdfName: v.pdfName,
  pdfSize: v.pdfSize,
  published: v.published,
  order: v.order,
  updatedAt: v.updatedAt,
});

const uploadPdf = async (topicId, file) => {
  const key = `tc-value-addition/${topicId}/${crypto.randomUUID()}.pdf`;
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: await fs.readFile(file.path),
    ContentType: 'application/pdf',
  }));
  return `r2://${key}`;
};

const deletePdf = (pdfKey) => {
  if (!pdfKey?.startsWith('r2://')) return Promise.resolve();
  return r2Client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: pdfKey.replace('r2://', ''),
  })).catch((e) => console.warn('value addition r2 delete failed:', e.message));
};

/** Entries for GET /:id — admins see drafts too. */
export const valueAdditionsFor = async (topicId, { admin = false } = {}) => {
  const filter = { toppersCopy: topicId, ...(admin ? {} : { published: true }) };
  const rows = await ToppersValueAddition.find(filter).sort({ order: 1, createdAt: 1 }).lean();
  return rows.map(publicShape);
};

/** Drop a topic's entries and their PDFs (called when the topic is deleted). */
export const deleteValueAdditionsOf = async (topicId) => {
  const rows = await ToppersValueAddition.find({ toppersCopy: topicId }).select('pdfKey').lean();
  await Promise.all(rows.map((r) => deletePdf(r.pdfKey)));
  await ToppersValueAddition.deleteMany({ toppersCopy: topicId });
};

// GET /admin/:id/value-additions
export const listValueAdditions = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    res.json({ valueAdditions: await valueAdditionsFor(req.params.id, { admin: true }) });
  } catch (err) {
    console.error('listValueAdditions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /admin/:id/value-additions
export const createValueAddition = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const file = req.file;
  try {
    const doc = await ToppersCopy.findById(req.params.id).select('_id').lean();
    if (!doc) { await safeUnlink(file?.path); return res.status(404).json({ error: 'Not found' }); }
    const title = String(req.body.title || '').trim().slice(0, 200);
    const body = String(req.body.body || '').slice(0, 20000);
    if (!title) { await safeUnlink(file?.path); return res.status(400).json({ error: 'A title is required' }); }
    if (!file && !body.trim()) return res.status(400).json({ error: 'Add some notes or a PDF' });
    const count = await ToppersValueAddition.countDocuments({ toppersCopy: doc._id });
    if (count >= MAX_PER_TOPIC) {
      await safeUnlink(file?.path);
      return res.status(400).json({ error: `Up to ${MAX_PER_TOPIC} value additions per topic.` });
    }

    const pdfKey = file ? await uploadPdf(doc._id, file) : '';
    await safeUnlink(file?.path);

    const entry = await ToppersValueAddition.create({
      toppersCopy: doc._id,
      title,
      body,
      pdfKey,
      pdfName: file ? file.originalname : '',
      pdfSize: file ? file.size : 0,
      published: req.body.published == null ? true : asBool(req.body.published),
      order: count,
    });
    res.json({ valueAddition: publicShape(entry) });
  } catch (err) {
    await safeUnlink(file?.path);
    console.error('createValueAddition error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
};

// PATCH /admin/value-additions/:vid — a new `pdf` replaces the old one; removePdf=true drops it.
export const updateValueAddition = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const file = req.file;
  try {
    const entry = await ToppersValueAddition.findById(req.params.vid);
    if (!entry) { await safeUnlink(file?.path); return res.status(404).json({ error: 'Not found' }); }

    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim().slice(0, 200);
      if (!title) { await safeUnlink(file?.path); return res.status(400).json({ error: 'A title is required' }); }
      entry.title = title;
    }
    if (typeof req.body.body === 'string') entry.body = req.body.body.slice(0, 20000);
    if (req.body.published != null) entry.published = asBool(req.body.published);
    if (req.body.order != null && Number.isFinite(Number(req.body.order))) entry.order = Number(req.body.order);

    const oldKey = entry.pdfKey;
    if (file) {
      entry.pdfKey = await uploadPdf(entry.toppersCopy, file);
      entry.pdfName = file.originalname;
      entry.pdfSize = file.size;
      await safeUnlink(file.path);
    } else if (asBool(req.body.removePdf)) {
      entry.pdfKey = '';
      entry.pdfName = '';
      entry.pdfSize = 0;
    }
    if (!entry.pdfKey && !entry.body.trim()) return res.status(400).json({ error: 'Add some notes or a PDF' });

    await entry.save();
    if (oldKey && oldKey !== entry.pdfKey) await deletePdf(oldKey);
    res.json({ valueAddition: publicShape(entry) });
  } catch (err) {
    await safeUnlink(file?.path);
    console.error('updateValueAddition error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// DELETE /admin/value-additions/:vid
export const deleteValueAddition = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const entry = await ToppersValueAddition.findById(req.params.vid);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    await deletePdf(entry.pdfKey);
    await entry.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteValueAddition error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /value-additions/:vid/pdf — Range-aware inline stream (same technique as the topic PDF).
// Students only for published entries of published topics.
export const streamValueAdditionPdf = async (req, res) => {
  try {
    const entry = await ToppersValueAddition.findById(req.params.vid).lean();
    if (!entry?.pdfKey?.startsWith('r2://')) return res.status(404).json({ error: 'Not found' });
    const doc = await ToppersCopy.findById(entry.toppersCopy).select('published').lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if ((!doc.published || !entry.published) && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: 'Not available' });
    }

    const rangeHeader = req.headers.range;
    const params = { Bucket: process.env.R2_BUCKET_NAME, Key: entry.pdfKey.replace('r2://', '') };
    if (rangeHeader) params.Range = rangeHeader;
    const r2Response = await r2Client.send(new GetObjectCommand(params));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    if (r2Response.ContentLength != null) res.setHeader('Content-Length', r2Response.ContentLength);
    if (rangeHeader && r2Response.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', r2Response.ContentRange);
    }
    r2Response.Body.pipe(res);
  } catch (err) {
    console.error('streamValueAdditionPdf error:', err);
    res.status(500).json({ error: 'Server error streaming PDF' });
  }
};

// Toppers Copy — per-topic "Value addition" (see models/ToppersValueAddition.js).
//
//   GET    /api/toppers-copy/admin/:id/value-additions          all entries of a topic (drafts too)
//   POST   /api/toppers-copy/admin/:id/value-additions          multipart: title, body, published, pdf?, docx?
//   PATCH  /api/toppers-copy/admin/value-additions/:vid         multipart: title / body / published / order / pdf? / removePdf / docx? / removeBank
//   DELETE /api/toppers-copy/admin/value-additions/:vid
//   GET    /api/toppers-copy/value-additions/:vid/pdf           Range-aware inline stream
//   GET    /api/toppers-copy/value-additions/:vid/bank          the notes bank parsed from the Word file
//
// Students receive the published ones inline with GET /api/toppers-copy/:id (valueAdditionsFor).

import fs from 'fs/promises';
import crypto from 'crypto';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2.js';
import ToppersCopy from '../models/ToppersCopy.js';
import ToppersValueAddition from '../models/ToppersValueAddition.js';
import { requireAdmin, isAdminRequest } from './progressController.js';
import { parseValueAdditionDocx } from '../utils/valueAdditionDocx.js';

const MAX_PER_TOPIC = 30;
const safeUnlink = (p) => (p ? fs.unlink(p).catch(() => {}) : Promise.resolve());
const asBool = (v) => v === true || v === 'true' || v === '1';
const uploadsOf = (req) => ({ file: req.files?.pdf?.[0], docx: req.files?.docx?.[0] });
const cleanup = ({ file, docx }) => Promise.all([safeUnlink(file?.path), safeUnlink(docx?.path)]);
const hasContent = (e) => !!(e.pdfKey || e.body.trim() || e.bank);

// Parse the uploaded Word file; a file with no notes is an admin mistake, not a server error.
const readBank = async (docx, title) => {
  let parsed;
  try {
    parsed = parseValueAdditionDocx(await fs.readFile(docx.path), title);
  } catch (e) {
    throw Object.assign(new Error(`Could not read the Word file: ${e.message}`), { status: 400 });
  }
  if (!parsed.notes.length) {
    throw Object.assign(new Error('No notes found in the Word file. Use Heading 1 / Heading 2 for sections such as Data, Facts, Examples.'), { status: 400 });
  }
  return { bank: { sections: parsed.sections, notes: parsed.notes }, bankName: docx.originalname, bankStats: parsed.stats };
};

const publicShape = (v) => ({
  _id: v._id,
  title: v.title,
  body: v.body,
  hasPdf: !!v.pdfKey,
  pdfName: v.pdfName,
  pdfSize: v.pdfSize,
  hasBank: !!v.bank,
  bankName: v.bankName || '',
  bankStats: v.bank ? v.bankStats : null,
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
  // The bank's contents stay out of the topic payload; `bank` comes back as {} (or null) — enough for hasBank.
  const rows = await ToppersValueAddition.find(filter).select('-bank.notes -bank.sections').sort({ order: 1, createdAt: 1 }).lean();
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

  const uploads = uploadsOf(req);
  const { file, docx } = uploads;
  try {
    const doc = await ToppersCopy.findById(req.params.id).select('_id').lean();
    if (!doc) { await cleanup(uploads); return res.status(404).json({ error: 'Not found' }); }
    const title = String(req.body.title || '').trim().slice(0, 200);
    const body = String(req.body.body || '').slice(0, 20000);
    if (!title) { await cleanup(uploads); return res.status(400).json({ error: 'A title is required' }); }
    if (!file && !docx && !body.trim()) return res.status(400).json({ error: 'Add some notes, a PDF or a Word file' });
    const count = await ToppersValueAddition.countDocuments({ toppersCopy: doc._id });
    if (count >= MAX_PER_TOPIC) {
      await cleanup(uploads);
      return res.status(400).json({ error: `Up to ${MAX_PER_TOPIC} value additions per topic.` });
    }

    const bank = docx ? await readBank(docx, title) : {};
    const pdfKey = file ? await uploadPdf(doc._id, file) : '';
    await cleanup(uploads);

    const entry = await ToppersValueAddition.create({
      toppersCopy: doc._id,
      title,
      body,
      pdfKey,
      pdfName: file ? file.originalname : '',
      pdfSize: file ? file.size : 0,
      ...bank,
      published: req.body.published == null ? true : asBool(req.body.published),
      order: count,
    });
    res.json({ valueAddition: publicShape(entry) });
  } catch (err) {
    await cleanup(uploads);
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('createValueAddition error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
};

// PATCH /admin/value-additions/:vid — a new `pdf` replaces the old one; removePdf=true drops it.
export const updateValueAddition = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const uploads = uploadsOf(req);
  const { file, docx } = uploads;
  try {
    const entry = await ToppersValueAddition.findById(req.params.vid);
    if (!entry) { await cleanup(uploads); return res.status(404).json({ error: 'Not found' }); }

    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim().slice(0, 200);
      if (!title) { await cleanup(uploads); return res.status(400).json({ error: 'A title is required' }); }
      entry.title = title;
    }
    if (typeof req.body.body === 'string') entry.body = req.body.body.slice(0, 20000);
    if (req.body.published != null) entry.published = asBool(req.body.published);
    if (req.body.order != null && Number.isFinite(Number(req.body.order))) entry.order = Number(req.body.order);

    if (docx) {
      Object.assign(entry, await readBank(docx, entry.title));
      await safeUnlink(docx.path);
    } else if (asBool(req.body.removeBank)) {
      entry.bank = null;
      entry.bankName = '';
      entry.bankStats = { notes: 0, pyqs: 0, sections: 0 };
    }
    entry.markModified('bank');

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
    if (!hasContent(entry)) return res.status(400).json({ error: 'Add some notes, a PDF or a Word file' });

    await entry.save();
    if (oldKey && oldKey !== entry.pdfKey) await deletePdf(oldKey);
    res.json({ valueAddition: publicShape(entry) });
  } catch (err) {
    await cleanup(uploads);
    if (err.status) return res.status(err.status).json({ error: err.message });
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

// GET /value-additions/:vid/bank — the parsed notes bank. Same access rule as the PDF.
export const getValueAdditionBank = async (req, res) => {
  try {
    const entry = await ToppersValueAddition.findById(req.params.vid).select('toppersCopy published bank title').lean();
    if (!entry?.bank) return res.status(404).json({ error: 'Not found' });
    const doc = await ToppersCopy.findById(entry.toppersCopy).select('published').lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if ((!doc.published || !entry.published) && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: 'Not available' });
    }
    res.json({ title: entry.title, bank: entry.bank });
  } catch (err) {
    console.error('getValueAdditionBank error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

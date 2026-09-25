import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { once } from 'events';
import mongoose from 'mongoose';

// Tooling to move the people / purchase collections (see config/peopleDb.js) from the content cluster to the
// people cluster without losing data:
//   backupCollections  lossless Extended-JSON files + manifest, re-read and checked after writing
//   copyCollections    insert-if-missing by _id (never overwrites), then copies the indexes
//   compareCollections document-by-document comparison using a canonical hash
//   syncCollections    catch-up pass: inserts what is missing, refreshes what is older, reports conflicts
//   dropVerified       removes the source collections ONLY when every document is safely on the target
//   restoreBackup      puts a backup back (insert-if-missing, or --overwrite)
// All functions take mongodb driver `Db` handles, so they are also usable from tests.

const { EJSON } = mongoose.mongo.BSON;

// Indexes that are created by the app at boot or dropped on purpose are not carried over.
const SKIP_INDEXES = new Set(['_id_', 'upiTxnId_1']);
const BATCH_DOCS = 200;
const BATCH_BYTES = 12 * 1024 * 1024;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

// Canonical, order-insensitive fingerprint of a document (types preserved through canonical Extended JSON).
export const docHash = (doc) => sha256(JSON.stringify(sortKeys(EJSON.serialize(doc, { relaxed: false }))));

const timeOf = (d) => (d && d.updatedAt instanceof Date ? d.updatedAt.getTime() : null);

export const dbIdentity = (db) => {
  const o = db.client.options;
  const where = o.srvHost || (o.hosts || []).map((h) => `${h.host}:${h.port}`).sort().join(',');
  return `${where}/${db.databaseName}`;
};

const assertDifferentTargets = (srcDb, dstDb) => {
  if (srcDb === dstDb || dbIdentity(srcDb) === dbIdentity(dstDb)) {
    throw new Error(`Source and target are the same database (${dbIdentity(srcDb)}); refusing to continue.`);
  }
};

const isMissingNamespace = (e) => e && (e.code === 26 || e.codeName === 'NamespaceNotFound');

async function readIndexes(db, name) {
  try {
    return (await db.collection(name).indexes()).filter((i) => !SKIP_INDEXES.has(i.name));
  } catch (e) {
    if (isMissingNamespace(e)) return [];
    throw e;
  }
}

async function applyIndexes(db, name, indexes) {
  const created = [];
  const failed = [];
  for (const { key, name: indexName, v, ns, ...options } of indexes) {
    try {
      await db.collection(name).createIndex(key, { ...options, name: indexName });
      created.push(indexName);
    } catch (e) {
      failed.push({ name: indexName, message: e.message });
    }
  }
  return { created, failed };
}

async function upsertBatches(dstCol, docs, { overwrite }) {
  let inserted = 0;
  let existed = 0;
  const errors = [];
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const ops = batch.map((d) => {
      const { _id, ...rest } = d;
      return overwrite
        ? { replaceOne: { filter: { _id }, replacement: rest, upsert: true } }
        : { updateOne: { filter: { _id }, update: { $setOnInsert: rest }, upsert: true } };
    });
    try {
      const r = await dstCol.bulkWrite(ops, { ordered: false });
      inserted += r.upsertedCount;
      existed += ops.length - r.upsertedCount;
    } catch (e) {
      const writeErrors = [].concat(e.writeErrors || []);
      if (!writeErrors.length && !e.result) throw e;
      const up = e.result?.upsertedCount ?? 0;
      inserted += up;
      existed += Math.max(0, ops.length - up - writeErrors.length);
      for (const w of writeErrors) {
        errors.push({ id: String(batch[w.index]?._id), code: w.code, message: String(w.errmsg || w.message).slice(0, 200) });
      }
    }
    batch = [];
    size = 0;
  };
  for await (const d of docs) {
    batch.push(d);
    size += mongoose.mongo.BSON.calculateObjectSize(d);
    if (batch.length >= BATCH_DOCS || size >= BATCH_BYTES) await flush();
  }
  await flush();
  return { inserted, existed, errors };
}

// ---------------------------------------------------------------------------------------------- backup

async function writeCollectionFile(file, cursor) {
  const out = fs.createWriteStream(file);
  const failed = new Promise((_, reject) => out.once('error', reject));
  const fileHash = crypto.createHash('sha256');
  const pairs = [];
  let bytes = 0;
  let count = 0;
  const put = async (s) => {
    fileHash.update(s);
    bytes += Buffer.byteLength(s);
    if (!out.write(s)) await Promise.race([once(out, 'drain'), failed]);
  };
  await put('[\n');
  for await (const doc of cursor) {
    await put((count ? ',\n' : '') + EJSON.stringify(doc, { relaxed: false }));
    pairs.push(`${doc._id}|${docHash(doc)}`);
    count += 1;
  }
  await put('\n]\n');
  const finished = once(out, 'finish');
  out.end();
  await Promise.race([finished, failed]);
  pairs.sort();
  return { count, bytes, sha256: fileHash.digest('hex'), docsDigest: sha256(pairs.join('\n')) };
}

export async function backupCollections(srcDb, outDir, { collections, meta = {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    format: 'canonical-extended-json',
    createdAt: new Date().toISOString(),
    source: dbIdentity(srcDb),
    ...meta,
    collections: {}
  };
  for (const name of collections) {
    const file = `${name}.json`;
    const info = await writeCollectionFile(path.join(outDir, file), srcDb.collection(name).find({}));
    manifest.collections[name] = { file, ...info, indexes: await readIndexes(srcDb, name) };
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.txt'), [
    'Backup of the people / purchase collections. Contains personal data - keep it private.',
    '',
    'One canonical Extended JSON file per collection (ObjectIds, dates and binary data are preserved) plus',
    'manifest.json with document counts, file checksums and index definitions.',
    '',
    'Check the files:   node scripts/people_split.mjs check-backup "<this folder>"',
    'Restore (adds only what is missing, never overwrites):',
    '                   node scripts/people_split.mjs restore "<this folder>" --to source|people',
    'Overwrite existing documents too:  add --overwrite',
    ''
  ].join('\n'));
  const check = verifyBackup(outDir);
  if (!check.ok) throw new Error('Backup failed its own integrity check: ' + check.problems.join('; '));
  return manifest;
}

export function readBackupCollection(dir, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entry = manifest.collections[name];
  if (!entry) throw new Error(`Collection "${name}" is not in this backup.`);
  return EJSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'), { relaxed: false });
}

export function verifyBackup(dir) {
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const [name, entry] of Object.entries(manifest.collections)) {
    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) { problems.push(`${name}: file missing`); continue; }
    const raw = fs.readFileSync(file);
    if (sha256(raw) !== entry.sha256) problems.push(`${name}: file checksum differs from the manifest`);
    const docs = EJSON.parse(raw.toString('utf8'), { relaxed: false });
    if (docs.length !== entry.count) problems.push(`${name}: ${docs.length} documents in the file, ${entry.count} expected`);
    const digest = sha256(docs.map((d) => `${d._id}|${docHash(d)}`).sort().join('\n'));
    if (digest !== entry.docsDigest) problems.push(`${name}: document contents differ from what was read from the database`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

// -------------------------------------------------------------------------------------------- copy / sync

export async function copyCollections(srcDb, dstDb, { collections }) {
  assertDifferentTargets(srcDb, dstDb);
  const results = [];
  for (const name of collections) {
    const { inserted, existed, errors } = await upsertBatches(dstDb.collection(name), srcDb.collection(name).find({}), { overwrite: false });
    const read = inserted + existed + errors.length;
    const indexes = await applyIndexes(dstDb, name, await readIndexes(srcDb, name));
    results.push({ name, read, inserted, existed, errors, indexes });
  }
  return results;
}

async function fingerprints(col) {
  const map = new Map();
  for await (const d of col.find({})) map.set(String(d._id), { id: d._id, hash: docHash(d), at: timeOf(d) });
  return map;
}

export async function compareCollections(srcDb, dstDb, { collections }) {
  const results = [];
  for (const name of collections) {
    const src = await fingerprints(srcDb.collection(name));
    const dst = await fingerprints(dstDb.collection(name));
    const r = { name, source: src.size, target: dst.size, identical: 0, missingInTarget: [], sourceNewer: [], targetNewer: 0, conflicts: [], extraInTarget: 0 };
    for (const [key, s] of src) {
      const t = dst.get(key);
      if (!t) r.missingInTarget.push(s.id);
      else if (t.hash === s.hash) r.identical += 1;
      else if (s.at !== null && t.at !== null && s.at > t.at) r.sourceNewer.push(s.id);
      else if (s.at !== null && t.at !== null && s.at < t.at) r.targetNewer += 1;
      else r.conflicts.push(s.id);
    }
    for (const key of dst.keys()) if (!src.has(key)) r.extraInTarget += 1;
    results.push(r);
  }
  return results;
}

export const isSafeToDrop = (results) => results.every((r) => !r.missingInTarget.length && !r.sourceNewer.length && !r.conflicts.length);

export async function syncCollections(srcDb, dstDb, { collections }) {
  assertDifferentTargets(srcDb, dstDb);
  const cmp = await compareCollections(srcDb, dstDb, { collections });
  const results = [];
  for (const r of cmp) {
    const wanted = [...r.missingInTarget, ...r.sourceNewer];
    const errors = [];
    let applied = 0;
    for (let i = 0; i < wanted.length; i += 25) {
      const docs = await srcDb.collection(r.name).find({ _id: { $in: wanted.slice(i, i + 25) } }).toArray();
      for (const d of docs) {
        try {
          const { _id, ...rest } = d;
          await dstDb.collection(r.name).replaceOne({ _id }, rest, { upsert: true });
          applied += 1;
        } catch (e) {
          errors.push({ id: String(d._id), message: String(e.message).slice(0, 200) });
        }
      }
    }
    results.push({ name: r.name, inserted: r.missingInTarget.length, refreshed: r.sourceNewer.length, applied, errors, conflicts: r.conflicts.map(String), keptNewerOnTarget: r.targetNewer });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------- drop / restore

export async function dropVerified(srcDb, dstDb, { collections }) {
  assertDifferentTargets(srcDb, dstDb);
  const cmp = await compareCollections(srcDb, dstDb, { collections });
  if (!isSafeToDrop(cmp)) {
    const bad = cmp.filter((r) => r.missingInTarget.length || r.sourceNewer.length || r.conflicts.length)
      .map((r) => `${r.name}: ${r.missingInTarget.length} missing, ${r.sourceNewer.length} older on target, ${r.conflicts.length} conflicts`);
    throw new Error('Not dropping: the target does not yet hold every document - ' + bad.join('; ') + '. Run "sync" first.');
  }
  const dropped = [];
  for (const name of collections) {
    try {
      await srcDb.collection(name).drop();
      dropped.push(name);
    } catch (e) {
      if (!isMissingNamespace(e)) throw e;
    }
  }
  return dropped;
}

export async function restoreBackup(dir, dstDb, { overwrite = false, collections } = {}) {
  const check = verifyBackup(dir);
  if (!check.ok) throw new Error('Backup failed its integrity check: ' + check.problems.join('; '));
  const results = [];
  for (const name of collections || Object.keys(check.manifest.collections)) {
    const docs = readBackupCollection(dir, name);
    const { inserted, existed, errors } = await upsertBatches(dstDb.collection(name), docs, { overwrite });
    const indexes = await applyIndexes(dstDb, name, check.manifest.collections[name].indexes || []);
    results.push({ name, inFile: docs.length, inserted, existed, errors, indexes });
  }
  return results;
}

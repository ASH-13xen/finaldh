// Tests for the people-data migration tooling (lib/peopleSplit.js). They need a MongoDB, so they only run when
// TEST_MONGODB_URI is set. Two databases on that server stand in for the two clusters.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

const URI = process.env.TEST_MONGODB_URI;

if (!URI) {
  test('people split tests (skipped: set TEST_MONGODB_URI)', { skip: true }, () => {});
} else {
  const lib = await import('../lib/peopleSplit.js');
  const { ObjectId, Binary, MongoClient } = mongoose.mongo;
  const COLLS = ['users', 'purchaserequests', 'upscqas'];
  let client, src, dst, dir;

  const oid = () => new ObjectId();
  const days = (n) => new Date(Date.UTC(2026, 8, n, 10, 30, 15, 123));
  // a payment screenshot as the app stores it: a string of raw JPEG bytes, plus a real Binary field for good measure
  const fakeJpeg = 'ÿØÿà\u0000\u0010JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000ÿÛ\u0000C ☃ 😀 "quoted" \\ back\\slash';
  const seed = async () => {
    await src.collection('users').insertMany([
      { _id: oid(), googleId: 'g1', email: 'a@x.dev', name: 'Asha', purchasedCourses: [oid(), oid()], downloadLimits: [{ courseId: 'c_0', downloadedCount: 1, allowedCount: 2 }], createdAt: days(1), updatedAt: days(2) },
      { _id: oid(), googleId: 'g2', email: 'b@x.dev', name: 'Ravi', interestedCourses: ['anthro'], createdAt: days(1), updatedAt: days(3), nested: { deep: { list: [1, 2.5, null, true, 'z'] } } },
      { _id: oid(), googleId: 'g3', email: 'c@x.dev', name: 'Meera', createdAt: days(1), updatedAt: days(4) }
    ]);
    await src.collection('users').createIndex({ email: 1 }, { unique: true });
    await src.collection('users').createIndex({ googleId: 1 }, { unique: true });
    await src.collection('purchaserequests').insertMany([
      { _id: oid(), userEmail: 'a@x.dev', price: 999, screenshotData: fakeJpeg, raw: new Binary(Buffer.from([0, 1, 2, 250, 255])), createdAt: days(5), updatedAt: days(5) },
      { _id: oid(), userEmail: 'b@x.dev', price: 0, screenshotData: '', createdAt: days(6), updatedAt: days(6) }
    ]);
    await src.collection('upscqas').insertMany([{ _id: oid(), question_text: 'Q?', tags: ['GS-1'], file_urls: [{ url: 'https://x/y.pdf' }], createdAt: days(7) }]);
  };

  before(async () => {
    client = new MongoClient(URI);
    await client.connect();
    src = client.db('split_src');
    dst = client.db('split_dst');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-split-'));
  });
  after(async () => {
    await client.db('split_src').dropDatabase();
    await client.db('split_dst').dropDatabase();
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const reset = async () => {
    await src.dropDatabase();
    await dst.dropDatabase();
    await seed();
  };
  const cmp = () => lib.compareCollections(src, dst, { collections: COLLS });

  test('backup: writes one JSON file per collection, re-reads it, and the round trip is lossless', async () => {
    await reset();
    const out = path.join(dir, 'b1');
    const manifest = await lib.backupCollections(src, out, { collections: [...COLLS, 'downloadlogs'] });
    assert.equal(manifest.collections.users.count, 3);
    assert.equal(manifest.collections.purchaserequests.count, 2);
    assert.equal(manifest.collections.downloadlogs.count, 0, 'an empty / missing collection backs up as an empty file');
    assert.ok(fs.existsSync(path.join(out, 'users.json')) && fs.existsSync(path.join(out, 'manifest.json')) && fs.existsSync(path.join(out, 'README.txt')));
    assert.ok(manifest.collections.users.indexes.some((i) => i.unique && i.key.email === 1), 'index definitions are recorded');
    assert.equal(lib.verifyBackup(out).ok, true);
    // every document read back from the file is identical (type for type) to the one in the database
    const inFile = lib.readBackupCollection(out, 'purchaserequests');
    const inDb = await src.collection('purchaserequests').find({}).toArray();
    assert.deepEqual(new Set(inFile.map(lib.docHash)), new Set(inDb.map(lib.docHash)));
    const paid = inFile.find((d) => d.userEmail === 'a@x.dev');
    assert.equal(paid.screenshotData, fakeJpeg);
    assert.ok(paid.raw instanceof Binary);
    assert.ok(inFile[0]._id instanceof ObjectId && inFile[0].createdAt instanceof Date);
  });

  test('backup: a damaged file is detected', async () => {
    const out = path.join(dir, 'b1');
    const f = path.join(out, 'users.json');
    const original = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, original.replace('Asha', 'Ashx'));
    const r = lib.verifyBackup(out);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /users: file checksum differs/);
    fs.writeFileSync(f, original);
    assert.equal(lib.verifyBackup(out).ok, true);
  });

  test('copy: everything arrives identical, indexes come along, and it is safe to run twice', async () => {
    await reset();
    const first = await lib.copyCollections(src, dst, { collections: COLLS });
    assert.deepEqual(first.map((r) => [r.name, r.read, r.inserted, r.existed, r.errors.length]), [['users', 3, 3, 0, 0], ['purchaserequests', 2, 2, 0, 0], ['upscqas', 1, 1, 0, 0]]);
    const c = await cmp();
    for (const r of c) {
      assert.equal(r.identical, r.source, `${r.name}: all documents identical`);
      assert.equal(r.missingInTarget.length + r.sourceNewer.length + r.conflicts.length, 0);
    }
    assert.equal(lib.isSafeToDrop(c), true);
    const idx = await dst.collection('users').indexes();
    assert.ok(idx.some((i) => i.unique && i.key.email === 1) && idx.some((i) => i.unique && i.key.googleId === 1));

    // running it again inserts nothing and never overwrites what is on the target
    await dst.collection('users').updateOne({ email: 'a@x.dev' }, { $set: { name: 'Edited on target' } });
    const second = await lib.copyCollections(src, dst, { collections: COLLS });
    assert.deepEqual(second.map((r) => [r.inserted, r.existed]), [[0, 3], [0, 2], [0, 1]]);
    assert.equal((await dst.collection('users').findOne({ email: 'a@x.dev' })).name, 'Edited on target');
  });

  test('sync: catches up records created or changed on the source since the copy, keeps newer target data, flags conflicts', async () => {
    await reset();
    await lib.copyCollections(src, dst, { collections: COLLS });
    // 1) new signup on the source   2) source edited later   3) target edited later   4) differs with equal timestamps
    const fresh = { _id: oid(), googleId: 'g9', email: 'new@x.dev', name: 'New', createdAt: days(20), updatedAt: days(20) };
    await src.collection('users').insertOne(fresh);
    await src.collection('users').updateOne({ email: 'a@x.dev' }, { $set: { name: 'Asha v2', updatedAt: days(21) } });
    await dst.collection('users').updateOne({ email: 'b@x.dev' }, { $set: { name: 'Ravi v2 (target)', updatedAt: days(22) } });
    await src.collection('users').updateOne({ email: 'c@x.dev' }, { $set: { name: 'Meera src' } });
    await dst.collection('users').updateOne({ email: 'c@x.dev' }, { $set: { name: 'Meera dst' } });

    let c = (await cmp()).find((r) => r.name === 'users');
    assert.equal(c.missingInTarget.length, 1);
    assert.equal(c.sourceNewer.length, 1);
    assert.equal(c.targetNewer, 1);
    assert.equal(c.conflicts.length, 1);
    assert.equal(lib.isSafeToDrop([c]), false);

    const [s] = await lib.syncCollections(src, dst, { collections: ['users'] });
    assert.deepEqual([s.inserted, s.refreshed, s.keptNewerOnTarget, s.conflicts.length, s.errors.length], [1, 1, 1, 1, 0]);
    assert.equal((await dst.collection('users').findOne({ email: 'new@x.dev' })).name, 'New');
    assert.equal((await dst.collection('users').findOne({ email: 'a@x.dev' })).name, 'Asha v2');
    assert.equal((await dst.collection('users').findOne({ email: 'b@x.dev' })).name, 'Ravi v2 (target)', 'newer data on the target is never overwritten');
    assert.equal((await dst.collection('users').findOne({ email: 'c@x.dev' })).name, 'Meera dst', 'a conflict is reported, not resolved silently');
    c = (await cmp()).find((r) => r.name === 'users');
    assert.equal(c.conflicts.length, 1, 'the conflict is still flagged until a human decides');
  });

  test('drop: refuses while the target lacks anything, drops only after everything is safely on the target', async () => {
    await reset();
    await lib.copyCollections(src, dst, { collections: COLLS });
    await src.collection('users').insertOne({ _id: oid(), googleId: 'late', email: 'late@x.dev', createdAt: days(25), updatedAt: days(25) });
    await assert.rejects(() => lib.dropVerified(src, dst, { collections: COLLS }), /Not dropping.*1 missing/);
    assert.equal(await src.collection('users').countDocuments(), 4, 'nothing was dropped');

    await lib.syncCollections(src, dst, { collections: COLLS });
    const dropped = await lib.dropVerified(src, dst, { collections: COLLS });
    assert.deepEqual(dropped.sort(), [...COLLS].sort());
    const left = (await src.listCollections().toArray()).map((c) => c.name);
    assert.deepEqual(left.filter((n) => COLLS.includes(n)), []);
    assert.equal(await dst.collection('users').countDocuments(), 4, 'the target keeps everything');
  });

  test('guards: copy / sync / drop refuse to run when source and target are the same database', async () => {
    await reset();
    await assert.rejects(() => lib.copyCollections(src, src, { collections: COLLS }), /same database/);
    await assert.rejects(() => lib.dropVerified(src, src, { collections: COLLS }), /same database/);
    await assert.rejects(() => lib.syncCollections(src, client.db('split_src'), { collections: COLLS }), /same database/);
    assert.equal(await src.collection('users').countDocuments(), 3);
  });

  test('restore: a backup rebuilds the collections exactly, adds only what is missing, and can overwrite on request', async () => {
    await reset();
    const out = path.join(dir, 'b2');
    await lib.backupCollections(src, out, { collections: COLLS });
    const before = await src.collection('users').find({}).toArray();

    // disaster: everything is gone
    await src.dropDatabase();
    const r = await lib.restoreBackup(out, src, {});
    assert.deepEqual(r.map((x) => [x.name, x.inserted, x.existed]), [['users', 3, 0], ['purchaserequests', 2, 0], ['upscqas', 1, 0]]);
    const after = await src.collection('users').find({}).toArray();
    assert.deepEqual(new Set(after.map(lib.docHash)), new Set(before.map(lib.docHash)));
    assert.ok((await src.collection('users').indexes()).some((i) => i.unique && i.key.email === 1), 'indexes are restored');

    // a second restore neither duplicates nor overwrites...
    await src.collection('users').updateOne({ email: 'a@x.dev' }, { $set: { name: 'changed after restore' } });
    await lib.restoreBackup(out, src, {});
    assert.equal(await src.collection('users').countDocuments(), 3);
    assert.equal((await src.collection('users').findOne({ email: 'a@x.dev' })).name, 'changed after restore');
    // ...unless asked to
    await lib.restoreBackup(out, src, { overwrite: true });
    assert.equal((await src.collection('users').findOne({ email: 'a@x.dev' })).name, 'Asha');
  });

  test('restore: a damaged backup is refused before anything is written', async () => {
    await reset();
    const out = path.join(dir, 'b3');
    await lib.backupCollections(src, out, { collections: COLLS });
    fs.appendFileSync(path.join(out, 'upscqas.json'), ' ');
    await dst.dropDatabase();
    await assert.rejects(() => lib.restoreBackup(out, dst, {}), /integrity check/);
    assert.equal(await dst.collection('users').countDocuments(), 0);
  });
}

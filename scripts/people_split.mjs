// Moves the people / purchase collections from the content cluster (MONGODB_URI) to the people cluster
// (MONGODB_URI_PEOPLE). Nothing here deletes data except "cleanup --confirm-delete", which first takes a fresh
// backup, syncs, and refuses to drop anything the target does not fully hold.
//
//   node scripts/people_split.mjs backup [--label pre-split]   JSON backup of the source (folder under migration-backups/)
//   node scripts/people_split.mjs copy                          copy source -> target (insert-if-missing, never overwrites)
//   node scripts/people_split.mjs verify                        compare source and target document by document (read-only)
//   node scripts/people_split.mjs sync                          catch-up: add what the target lacks, refresh what is older there
//   node scripts/people_split.mjs cleanup [--confirm-delete]    backup + sync + verify, then drop the source collections
//   node scripts/people_split.mjs check-backup <folder>         re-read a backup and validate it (read-only)
//   node scripts/people_split.mjs restore <folder> [--to source|people] [--overwrite]
//
// Test-only overrides: SPLIT_SOURCE_DB / SPLIT_TARGET_DB choose the database name on each connection.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { PEOPLE_COLLECTIONS } from '../config/peopleDb.js';
import {
  backupCollections, copyCollections, compareCollections, syncCollections, dropVerified,
  isSafeToDrop, restoreBackup, verifyBackup, dbIdentity
} from '../lib/peopleSplit.js';

const { MongoClient } = mongoose.mongo;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

const usage = () => {
  console.error('Usage: node scripts/people_split.mjs <backup|copy|verify|sync|cleanup|check-backup|restore> [options]');
  process.exit(2);
};
if (!cmd) usage();

const clients = [];
const open = async (uriVar, dbVar) => {
  const uri = process.env[uriVar];
  if (!uri) { console.error(`${uriVar} is not set (backend/.env).`); process.exit(2); }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  clients.push(client);
  return client.db(process.env[dbVar] || undefined);
};

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const backupDir = (label) => path.join(here, '..', 'migration-backups', `people-split-${label}-${stamp()}`);
const pad = (s, n) => String(s).padEnd(n);

const printCompare = (results) => {
  console.log(`${pad('collection', 22)}${pad('source', 8)}${pad('target', 8)}${pad('identical', 11)}${pad('missing', 9)}${pad('src newer', 11)}${pad('tgt newer', 11)}${pad('conflicts', 10)}extra-on-target`);
  for (const r of results) {
    console.log(`${pad(r.name, 22)}${pad(r.source, 8)}${pad(r.target, 8)}${pad(r.identical, 11)}${pad(r.missingInTarget.length, 9)}${pad(r.sourceNewer.length, 11)}${pad(r.targetNewer, 11)}${pad(r.conflicts.length, 10)}${r.extraInTarget}`);
  }
};

const doBackup = async (src, label) => {
  const dir = backupDir(label);
  const manifest = await backupCollections(src, dir, { collections: PEOPLE_COLLECTIONS, meta: { label } });
  console.log(`Backup written and re-read successfully: ${dir}`);
  for (const [name, e] of Object.entries(manifest.collections)) console.log(`  ${pad(name, 22)}${pad(e.count + ' docs', 12)}${(e.bytes / 1048576).toFixed(2)} MB`);
  return dir;
};

try {
  if (cmd === 'check-backup') {
    const dir = args[1];
    if (!dir) usage();
    const r = verifyBackup(dir);
    console.log(r.ok ? 'Backup is intact.' : 'PROBLEMS: ' + r.problems.join('; '));
    for (const [name, e] of Object.entries(r.manifest.collections)) console.log(`  ${pad(name, 22)}${e.count} docs`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'restore') {
    const dir = args[1];
    if (!dir) usage();
    const to = opt('to', 'source');
    const dst = to === 'people' ? await open('MONGODB_URI_PEOPLE', 'SPLIT_TARGET_DB') : await open('MONGODB_URI', 'SPLIT_SOURCE_DB');
    console.log(`Restoring into ${to} (${dbIdentity(dst)})${flag('overwrite') ? ' - OVERWRITING existing documents' : ' - adding missing documents only'}`);
    for (const r of await restoreBackup(dir, dst, { overwrite: flag('overwrite') })) {
      console.log(`  ${pad(r.name, 22)}in file ${r.inFile}, inserted ${r.inserted}, already present ${r.existed}, errors ${r.errors.length}, indexes ${r.indexes.created.length} ok / ${r.indexes.failed.length} failed`);
    }
  } else {
    const src = await open('MONGODB_URI', 'SPLIT_SOURCE_DB');
    const dst = ['backup'].includes(cmd) ? null : await open('MONGODB_URI_PEOPLE', 'SPLIT_TARGET_DB');
    console.log(`source: ${dbIdentity(src)}${dst ? `\ntarget: ${dbIdentity(dst)}` : ''}\n`);

    if (cmd === 'backup') {
      await doBackup(src, opt('label', 'pre-split'));
    } else if (cmd === 'copy') {
      for (const r of await copyCollections(src, dst, { collections: PEOPLE_COLLECTIONS })) {
        console.log(`${pad(r.name, 22)}read ${r.read}, inserted ${r.inserted}, already on target ${r.existed}, errors ${r.errors.length}, indexes ${r.indexes.created.length} ok / ${r.indexes.failed.length} failed`);
        for (const e of r.errors) console.log('   error', e.id, e.code, e.message);
        for (const f of r.indexes.failed) console.log('   index', f.name, f.message);
      }
    } else if (cmd === 'verify') {
      const results = await compareCollections(src, dst, { collections: PEOPLE_COLLECTIONS });
      printCompare(results);
      console.log(isSafeToDrop(results) ? '\nEvery source document is on the target.' : '\nDifferences exist (records written to the source since the last copy show up here). Run "sync".');
      process.exitCode = isSafeToDrop(results) ? 0 : 1;
    } else if (cmd === 'sync') {
      for (const r of await syncCollections(src, dst, { collections: PEOPLE_COLLECTIONS })) {
        console.log(`${pad(r.name, 22)}added ${r.inserted}, refreshed ${r.refreshed}, kept newer on target ${r.keptNewerOnTarget}, conflicts ${r.conflicts.length}, errors ${r.errors.length}`);
        for (const e of r.errors) console.log('   error', e.id, e.message);
        if (r.conflicts.length) console.log('   conflicting ids (differ, no usable updatedAt):', r.conflicts.join(', '));
      }
    } else if (cmd === 'cleanup') {
      console.log('Step 1/4  fresh backup of the source');
      await doBackup(src, 'final');
      console.log('\nStep 2/4  catch-up sync');
      for (const r of await syncCollections(src, dst, { collections: PEOPLE_COLLECTIONS })) {
        console.log(`  ${pad(r.name, 22)}added ${r.inserted}, refreshed ${r.refreshed}, conflicts ${r.conflicts.length}, errors ${r.errors.length}`);
      }
      console.log('\nStep 3/4  verify');
      const results = await compareCollections(src, dst, { collections: PEOPLE_COLLECTIONS });
      printCompare(results);
      if (!isSafeToDrop(results)) {
        console.error('\nNOT SAFE TO DELETE - the target is missing or has older versions of some documents. Nothing was deleted.');
        process.exitCode = 1;
      } else if (!flag('confirm-delete')) {
        console.log('\nDRY RUN: everything is on the target. Nothing was deleted. Re-run with --confirm-delete to drop these collections from the SOURCE cluster:');
        console.log('  ' + PEOPLE_COLLECTIONS.join(', '));
      } else {
        console.log('\nStep 4/4  dropping from the source');
        const dropped = await dropVerified(src, dst, { collections: PEOPLE_COLLECTIONS });
        console.log('Dropped from source:', dropped.join(', ') || '(none present)');
      }
    } else {
      usage();
    }
  }
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
}

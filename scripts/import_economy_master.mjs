#!/usr/bin/env node
// Load the parsed Economy Master File into Mongo.
//
//   node scripts/parse_economy_master.mjs --file "Economy_Master_File.pdf" --out economy_master.json
//   node scripts/import_economy_master.mjs --file economy_master.json [--replace] [--overwrite-edited] [--dry-run]
//
// Same logic as Admin → Economy Master File → Import (utils/economyImport.js). Themes are created
// unpublished; publish them from the admin screen once they look right.

import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { importParsed } from '../utils/economyImport.js';

dotenv.config();
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const file = val('file');
if (!file) {
  console.error('usage: import_economy_master.mjs --file <parsed.json> [--replace] [--overwrite-edited] [--dry-run]');
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
await mongoose.connect(process.env.MONGODB_URI);
try {
  const report = await importParsed(parsed, {
    mode: flag('replace') ? 'replace' : 'merge',
    overwriteEdited: flag('overwrite-edited'),
    dryRun: flag('dry-run'),
  });
  console.log(JSON.stringify({ ...report, errors: report.errors.slice(0, 50) }, null, 2));
  if (flag('dry-run')) console.log('(dry run — nothing written)');
} finally {
  await mongoose.disconnect();
}

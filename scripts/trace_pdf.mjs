// Reads the hidden License ID + fingerprint out of a leaked PDF.
//
//   node scripts/trace_pdf.mjs leaked.pdf
//
// Downloads are password protected, and the hidden marks live inside encrypted page content. Decrypt a
// copy first (you need the student's opening password - last 10 digits of their mobile, else their email):
//
//   qpdf --password=<password> --decrypt leaked.pdf leaked_decrypted.pdf
//   node scripts/trace_pdf.mjs leaked_decrypted.pdf
//
// Then look the License ID up under Admin -> Admin View -> Leak Trace.
import fs from 'fs';
import { extractTrace, fingerprintOf } from '../lib/pdfStamp.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/trace_pdf.mjs <file.pdf>');
  process.exit(2);
}

try {
  const t = await extractTrace(fs.readFileSync(file));
  if (!t.licenseId) {
    console.log('No hidden trace found. The file is encrypted, was not produced by this system, or its pages were re-rendered/printed.');
    process.exit(1);
  }
  console.log(`License ID : ${t.licenseId}`);
  console.log(`User ID    : ${t.userId}`);
  console.log(`Stamped pages carrying the trace: ${t.stampedPages}`);
  console.log(`Position fingerprint: ${t.fingerprintBitsSeen}/32 bits recovered, ` +
    (t.fingerprintBitsSeen === 32
      ? (t.fingerprint === fingerprintOf(t.licenseId) ? 'matches the License ID (file not tampered with)' : 'DOES NOT match the License ID (marks were altered)')
      : 'too few pages to verify fully'));
} catch (err) {
  console.error('Could not read this PDF:', err.message);
  console.error('If it is password protected, decrypt it first (see the comment at the top of this script).');
  process.exit(1);
}

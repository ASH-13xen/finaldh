import { encryptPDF } from '@pdfsmaller/pdf-encrypt-lite';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildSecuredPdf } from '../lib/pdfStamp.js';

// GitHub Actions worker: downloads a course PDF from R2, stamps it for one student (see
// lib/pdfStamp.js), password-protects it, uploads it back and reports to the backend via a webhook.
//
// Inputs are read from PDF_* environment variables (what the workflow uses - values passed through the
// environment are never parsed by a shell, so a hostile student name cannot inject commands) and fall
// back to --key=value CLI arguments so the script can still be run by hand.

const cliArgs = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const val = argv[i];
    if (!val.startsWith('--')) continue;
    if (val.includes('=')) {
      const at = val.indexOf('=');
      cliArgs[val.substring(2, at)] = val.substring(at + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      cliArgs[val.substring(2)] = argv[++i];
    } else {
      cliArgs[val.substring(2)] = 'true';
    }
  }
}
const input = (name, envName) => process.env[envName] ?? cliArgs[name] ?? '';

const courseId = input('courseId', 'PDF_COURSE_ID');
const userId = input('userId', 'PDF_USER_ID');
const userName = input('userName', 'PDF_USER_NAME');
const userEmail = input('userEmail', 'PDF_USER_EMAIL');
const userMobile = input('userMobile', 'PDF_USER_MOBILE');
const sourceKey = input('sourceKey', 'PDF_SOURCE_KEY'); // comma separated list of keys in R2
const destinationKey = input('destinationKey', 'PDF_DESTINATION_KEY');
const callbackUrl = input('callbackUrl', 'PDF_CALLBACK_URL');
const licenseId = input('licenseId', 'PDF_LICENSE_ID');
const issuedAtRaw = input('issuedAt', 'PDF_ISSUED_AT');

// Deliberately no names / emails / phone numbers in the logs.
console.log('--- Starting PDF Asynchronous Processing Script ---');
console.log(`Course ID: ${courseId}`);
console.log(`User ID: ${userId}`);
console.log(`License ID: ${licenseId}`);
console.log(`Source Keys: ${sourceKey}`);
console.log(`Destination Key: ${destinationKey}`);
console.log(`Callback URL: ${callbackUrl}`);
console.log('--- Environment Variables Check ---');
for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_KEY_ID', 'CLOUDFLARE_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'CALLBACK_SECRET']) {
  console.log(`${k}: ${process.env[k] ? 'defined' : 'undefined'}`);
}

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY
  }
});

// Cloudflare R2 occasionally returns a transient 500 InternalError that the AWS SDK's own default retry
// (3 attempts within ~100ms total) is too fast to ride out. Wrap the R2 calls that matter most with a
// slower, longer-running retry so a brief R2 hiccup doesn't fail the whole job.
async function withRetry(fn, { attempts = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`R2 call failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

async function callback(body) {
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CALLBACK_SECRET}` },
    body: JSON.stringify({ courseId, userId, licenseId, ...body })
  });
  if (!res.ok) throw new Error(`Callback responded ${res.status}`);
}

async function updateProgress(step) {
  console.log(`Reporting progress step: ${step}`);
  try {
    await callback({ status: 'progress', step });
  } catch (err) {
    console.error(`Failed to report progress step ${step}:`, err.message);
  }
}

// The password the student opens the file with: last 10 digits of their mobile, else their email.
function openingPassword() {
  const digits = (userMobile || '').replace(/\D/g, '');
  if (digits && userMobile.trim() !== 'N/A') return digits.length >= 10 ? digits.slice(-10) : digits;
  return userEmail.trim().toLowerCase();
}

async function run() {
  try {
    const keys = sourceKey.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0 || !userId || !userEmail || !licenseId || !destinationKey || !callbackUrl) {
      throw new Error('Missing required inputs');
    }

    await updateProgress(5); // downloading

    const sources = [];
    for (let i = 0; i < keys.length; i++) {
      console.log(`Downloading part ${i + 1}/${keys.length} from Cloudflare R2: ${keys[i]}`);
      const r2Response = await withRetry(() => r2Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: keys[i] })));
      const chunks = [];
      for await (const chunk of r2Response.Body) chunks.push(chunk);
      sources.push(Buffer.concat(chunks));
    }

    const stepNumbers = { barcode: 6, stamping: 7, saving: 8 };
    const issuedAt = issuedAtRaw && !Number.isNaN(Date.parse(issuedAtRaw)) ? new Date(issuedAtRaw) : new Date();
    const stamped = await buildSecuredPdf({
      sources,
      user: { userId, name: userName, email: userEmail, mobile: userMobile },
      license: { licenseId, issuedAt },
      docInfo: { title: courseId },
      onStep: (step) => updateProgress(stepNumbers[step])
    });

    await updateProgress(9); // encrypting + uploading
    console.log('Encrypting PDF...');
    const encrypted = await encryptPDF(stamped, openingPassword());

    console.log(`Uploading processed PDF back to R2: ${destinationKey}`);
    await withRetry(() =>
      r2Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: destinationKey,
        Body: Buffer.from(encrypted),
        ContentType: 'application/pdf'
      }))
    );

    console.log(`Pinging callback webhook: ${callbackUrl}`);
    await callback({ status: 'completed', destinationKey });
    console.log('Asynchronous processing completed successfully!');
  } catch (err) {
    console.error('Error during asynchronous PDF generation:', err);
    try {
      await callback({ status: 'failed', error: err.message || 'Unknown error during script run' });
    } catch (cbErr) {
      console.error('Failed to notify callback URL of failure:', cbErr.message);
    }
    process.exit(1);
  }
}

run();

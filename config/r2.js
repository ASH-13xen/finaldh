import { S3Client } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

// Storage backend: Cloudflare R2 in prod, plain AWS S3 for local testing.
// If CLOUDFLARE_ACCOUNT_ID is set we talk to R2 (custom endpoint, region "auto").
// Otherwise, if AWS credentials are present, we fall back to real S3.
const useR2 = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);

export const r2Client = useR2
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
      },
    })
  : new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

console.log(`[storage] using ${useR2 ? 'Cloudflare R2' : 'AWS S3'} — bucket: ${process.env.R2_BUCKET_NAME || '(unset)'}`);

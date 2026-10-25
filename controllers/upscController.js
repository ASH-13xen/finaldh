import UPSCQA from '../models/UPSCQA.js';
import { safeGet } from '../utils/safeFetch.js';

// Retrieve all UPSC questions and topper details
export const getUPSCQuestions = async (req, res) => {
  try {
    const questions = await UPSCQA.find({}).sort({ createdAt: -1 });
    res.json({ questions });
  } catch (err) {
    console.error('Error fetching UPSC questions:', err);
    res.status(500).json({ error: 'Server error retrieving UPSC questions list' });
  }
};

const PROXY_MAX_BYTES = 150 * 1024 * 1024;

// Proxy topper copies to view them inline without triggering download.
// This route is public (it is loaded through an <iframe src>, which cannot send an Authorization
// header), so it must never act as an open proxy: it only fetches URLs that are actually stored as
// topper copies in the database, and the fetch itself is SSRF-guarded (see utils/safeFetch.js).
export const proxyPDF = async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  try {
    const known = await UPSCQA.exists({ 'file_urls.url': url });
    if (!known) {
      return res.status(403).json({ error: 'This URL is not an approved topper copy.' });
    }

    const upstream = await safeGet(url);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let received = 0;
    let firstChunk = true;
    upstream.on('data', (chunk) => {
      received += chunk.length;
      if (firstChunk) {
        firstChunk = false;
        if (chunk.subarray(0, 1024).indexOf('%PDF-') === -1) {
          upstream.destroy();
          if (!res.headersSent) res.status(415).json({ error: 'The linked file is not a PDF.' });
          else res.end();
          return;
        }
      }
      if (received > PROXY_MAX_BYTES) {
        upstream.destroy();
        res.end();
        return;
      }
      if (!res.write(chunk)) {
        upstream.pause();
        res.once('drain', () => upstream.resume());
      }
    });
    upstream.on('end', () => res.end());
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
  } catch (err) {
    console.error('Error proxying PDF copy:', err.message);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error proxying PDF answer copy' });
    }
  }
};

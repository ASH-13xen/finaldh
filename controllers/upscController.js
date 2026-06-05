import UPSCQA from '../models/UPSCQA.js';

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

// Proxy topper copies to view them inline without triggering download
export const proxyPDF = async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  try {
    console.log(`Proxying PDF copy from source URL: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch PDF copy from storage server.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.send(buffer);
  } catch (err) {
    console.error('Error proxying PDF copy:', err);
    res.status(500).json({ error: 'Server error proxying PDF answer copy' });
  }
};

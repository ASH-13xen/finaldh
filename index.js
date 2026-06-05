import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { connectDB } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import questionRoutes from './routes/questionRoutes.js';
import upscRoutes from './routes/upscRoutes.js';
import courseRoutes from './routes/courseRoutes.js';
import pdfEditorRoutes from './routes/pdfEditorRoutes.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'x-download-mode']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Global Request Logger to debug connection issues (ignoring high-frequency progress polling)
app.use((req, res, next) => {
  if (!req.originalUrl.includes('/download-progress')) {
    console.log(`[HTTP Server] Incoming: ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Initialize Database Connection
connectDB();

// Middleware to set no-cache headers for index.html
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Serve static frontend files from Vite build directory
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Serve uploaded course PDF files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Mount Layered Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/upsc', upscRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/pdf-editor', pdfEditorRoutes);

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error'
  });
});

// Fallback: serve index.html for any other non-API routes (Express 5 RegExp wildcard)
app.get(/.*/, async (req, res) => {
  const indexPath = path.join(__dirname, '../frontend/dist/index.html');
  try {
    await fs.access(indexPath);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(indexPath);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json({ status: "ok", message: "The Dark Horse UPSC API Server is running" });
  }
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 601000;

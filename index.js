import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize Database Connection
connectDB();

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

// Fallback: serve index.html for any other non-API routes (Express 5 named wildcard)
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 601000;

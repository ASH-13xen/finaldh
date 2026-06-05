import express from 'express';
import { 
  getUserProfile, 
  updateUserProfile,
  updateOptionalSubject, 
  toggleTopicProgress, 
  getUserSyllabus,
  trackDownload,
  requestAdditionalDownload,
  getPendingDownloadRequests,
  approveDownloadRequest,
  getUserDownloadRequests,
  getUserBarcode
} from '../controllers/userController.js';
import { authenticateToken } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/profile', authenticateToken, getUserProfile);
router.put('/profile', authenticateToken, updateUserProfile);
router.post('/optional', authenticateToken, updateOptionalSubject);
router.post('/progress', authenticateToken, toggleTopicProgress);
router.get('/syllabus', authenticateToken, getUserSyllabus);
router.get('/barcode', authenticateToken, getUserBarcode);

// PDF Download Limit routes
router.post('/download-track', authenticateToken, trackDownload);
router.post('/download-request', authenticateToken, requestAdditionalDownload);
router.get('/download-requests', authenticateToken, getUserDownloadRequests);
router.get('/admin/requests', authenticateToken, getPendingDownloadRequests);
router.post('/admin/requests/:id/approve', authenticateToken, approveDownloadRequest);

export default router;

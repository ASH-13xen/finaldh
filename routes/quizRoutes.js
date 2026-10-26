import express from 'express';
import { authenticateToken } from '../middlewares/authMiddleware.js';
import {
  listTopics,
  startAttempt,
  getAttemptQuestions,
  answerQuestion,
  useHint,
  completeAttempt,
  getAttempt,
  listAttempts,
  reportQuestion
} from '../controllers/quizController.js';

const router = express.Router();

// Everything requires a logged-in user.
router.use(authenticateToken);

router.get('/topics', listTopics);

router.get('/attempts', listAttempts);
router.post('/attempts', startAttempt);
router.get('/attempts/:id', getAttempt);
router.get('/attempts/:id/questions', getAttemptQuestions);
router.post('/attempts/:id/answer', answerQuestion);
router.post('/attempts/:id/hint', useHint);
router.post('/attempts/:id/complete', completeAttempt);

router.post('/questions/:questionId/report', reportQuestion);

export default router;

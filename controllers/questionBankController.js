// Student-facing Question Bank listing. The actual practice (topic / random / all modes,
// hints, review) runs through quizController.js at /api/quiz/*, keyed by the bank's `subject`.

import QuestionBank from '../models/QuestionBank.js';
import QuizQuestion from '../models/QuizQuestion.js';

// GET /api/question-banks  — published banks for the MCQ landing page
export const listPublishedBanks = async (req, res) => {
  try {
    const banks = await QuestionBank.find({ isPublished: true }).sort({ order: 1, createdAt: 1 }).lean();
    if (banks.length === 0) return res.json({ banks: [] });

    const agg = await QuizQuestion.aggregate([
      { $match: { subject: { $in: banks.map((b) => b.subject) } } },
      { $group: { _id: '$subject', total: { $sum: 1 }, topics: { $addToSet: '$topic' } } }
    ]);
    const stats = {};
    for (const r of agg) stats[r._id] = { total: r.total, topicCount: r.topics.length };

    res.json({
      banks: banks
        .map((b) => ({
          subject: b.subject,
          title: b.title,
          description: b.description,
          total: stats[b.subject]?.total || 0,
          topicCount: stats[b.subject]?.topicCount || 0
        }))
        .filter((b) => b.total > 0)
    });
  } catch (err) {
    console.error('listPublishedBanks error:', err);
    res.status(500).json({ error: 'Failed to load question banks' });
  }
};

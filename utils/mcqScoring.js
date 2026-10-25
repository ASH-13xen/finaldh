import McqAttempt from '../models/McqAttempt.js';

export const round2 = (n) => Math.round(n * 100) / 100;

const isMarked = (status) => status === 'marked-for-review' || status === 'answered-marked-for-review';

// Applies the scoring rules to an attempt's responses IN PLACE and refreshes every aggregate.
// The single place scores are computed: used when an attempt is submitted and again whenever an
// answer key is corrected. Never trusts anything the client sent - only what is stored on the attempt.
export function applyScoring(attempt) {
  let marks = 0;
  let maxTotal = 0;
  let correct = 0;
  let wrong = 0;
  let unattempted = 0;
  let marked = 0;
  let time = 0;

  for (const r of attempt.responses) {
    time += r.timeSpentSeconds || 0;
    maxTotal += r.maxMarks;
    if (isMarked(r.status)) marked += 1;

    if (r.selectedOption === null || r.selectedOption === undefined) {
      r.isCorrect = null;
      r.marksAwarded = 0;
      unattempted += 1;
    } else {
      r.isCorrect = r.selectedOption === r.correctOption;
      r.marksAwarded = r.isCorrect ? r.maxMarks : -r.negativeMarks;
      if (r.isCorrect) correct += 1;
      else wrong += 1;
      marks += r.marksAwarded;
    }
  }

  attempt.totalMarksObtained = round2(marks);
  attempt.totalMaxMarks = round2(maxTotal);
  attempt.totalCorrect = correct;
  attempt.totalWrong = wrong;
  attempt.totalUnattempted = unattempted;
  attempt.totalMarked = marked;
  attempt.accuracyPercent = correct + wrong > 0 ? round2((correct / (correct + wrong)) * 100) : 0;
  attempt.totalTimeSpentSeconds = time;
  return attempt;
}

// An admin corrected a question's answer key: make every attempt that contains that question agree.
// - the stored key is updated atomically on every attempt (safe even while a student is mid-test)
// - finished attempts are then re-scored so totals, accuracy and ranks reflect the corrected key
// Returns the number of attempts that contained the question.
export async function rescoreQuestion(questionId, newCorrectOption) {
  const updated = await McqAttempt.updateMany(
    { 'responses.question': questionId },
    { $set: { 'responses.$[r].correctOption': newCorrectOption } },
    { arrayFilters: [{ 'r.question': questionId }] }
  );

  const finished = await McqAttempt.find({ 'responses.question': questionId, status: { $ne: 'in-progress' } });
  for (const attempt of finished) {
    applyScoring(attempt);
    await attempt.save();
  }
  return updated.matchedCount ?? updated.n ?? 0;
}

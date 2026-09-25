import { rescoreQuestion } from './mcqScoring.js';

// The one code path that changes a question's answer key or explanation after it has been published.
// Used both when an admin edits a question directly and when they accept a student's report, so both
// leave the same audit trail and re-score the same way.
//
// `question` is a loaded McqQuestion document. Any other field changes the caller already applied to it
// are saved together with the key change. Returns what happened so the caller can report it.
export async function correctAnswerKey({ question, correctOption, explanation, changedBy, report, note = '', rescore = true }) {
  const previousOption = question.correctOption;
  const optionChanged = !!correctOption && correctOption !== previousOption;
  const explanationChanged = explanation !== undefined && explanation !== null && explanation !== question.explanation;

  if (optionChanged) question.correctOption = correctOption;
  if (explanationChanged) question.explanation = explanation;

  if (optionChanged || explanationChanged) {
    question.answerHistory.push({
      changedBy,
      fromOption: previousOption,
      toOption: question.correctOption,
      explanationChanged,
      report,
      note
    });
  }
  await question.save();

  // The stored key on every past attempt is a snapshot, so a corrected key has to be pushed to them.
  const rescoredAttempts = optionChanged && rescore ? await rescoreQuestion(question._id, correctOption) : 0;
  return { optionChanged, explanationChanged, previousOption, rescoredAttempts };
}

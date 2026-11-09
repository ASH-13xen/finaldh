// Loads a built corpus (scripts/interview/pipeline.mjs build) into the content database, replacing the
// previous one. Admin corrections made after a seed are lost by the next seed of the same years, so
// re-seed only after re-parsing.
import mongoose from 'mongoose';
import InterviewTranscript from '../../models/InterviewTranscript.js';
import InterviewQuestion from '../../models/InterviewQuestion.js';
import InterviewFamily from '../../models/InterviewFamily.js';
import { invalidateCorpusIndex } from './corpusIndex.js';

const BATCH = 2000;

const insertInBatches = async (Model, docs, log, label) => {
  for (let i = 0; i < docs.length; i += BATCH) {
    await Model.insertMany(docs.slice(i, i + BATCH), { ordered: false, lean: true });
    if (log && docs.length > BATCH) log(`  ${label}: ${Math.min(i + BATCH, docs.length)}/${docs.length}`);
  }
};

export const seedCorpus = async ({ transcripts, questions, families }, { log } = {}) => {
  await Promise.all([InterviewTranscript.init(), InterviewQuestion.init(), InterviewFamily.init()]);
  await InterviewQuestion.deleteMany({});
  await InterviewTranscript.deleteMany({});
  await InterviewFamily.deleteMany({});

  const famId = new Map(families.map((f) => [f.key, new mongoose.Types.ObjectId()]));
  const trId = new Map(transcripts.map((t) => [t.key, new mongoose.Types.ObjectId()]));

  await insertInBatches(InterviewFamily, families.map(({ vec, ...f }) => ({
    _id: famId.get(f.key),
    ...f,
    ...(vec ? { vec: Buffer.from(vec, 'base64') } : {})
  })), log, 'families');

  await insertInBatches(InterviewTranscript, transcripts.map((t) => ({ _id: trId.get(t.key), ...t })), log, 'transcripts');

  await insertInBatches(InterviewQuestion, questions.map(({ transcriptKey, familyKey, ...q }) => ({
    ...q,
    transcript: trId.get(transcriptKey),
    family: familyKey ? famId.get(familyKey) : null
  })), log, 'questions');

  invalidateCorpusIndex();
  return { transcripts: transcripts.length, questions: questions.length, families: families.length };
};

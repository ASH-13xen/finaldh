import mongoose from 'mongoose';

const tagSchema = new mongoose.Schema({
  section: { type: String, required: true },
  title: { type: String, default: '' },
  matched: { type: Boolean, default: true }
}, { _id: false });

const optionSchema = new mongoose.Schema({
  label: { type: String, required: true, enum: ['A', 'B', 'C', 'D'] },
  text: { type: String, required: true }
}, { _id: false });

const mcqQuestionSchema = new mongoose.Schema({
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'McqTest', required: true },
  order: { type: Number, required: true },
  questionText: { type: String, required: true },
  options: { type: [optionSchema], required: true },
  correctOption: { type: String, required: true, enum: ['A', 'B', 'C', 'D'] }, // never sent to the client before submission
  explanation: { type: String, default: '' }, // never sent to the client before submission
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' },
  marks: { type: Number, default: null }, // overrides McqTest.marksPerQuestion when set
  tags: { type: [tagSchema], default: [] },
  rawTags: { type: [String], default: [] },
  examSource: { type: String, default: '' }, // real exam/year this question is attributed to, e.g. "UPSC IES 2023"
  questionType: { type: String, enum: ['conceptual', 'factual'], default: 'conceptual' }
}, { timestamps: true });

mcqQuestionSchema.index({ test: 1, order: 1 });
mcqQuestionSchema.index({ 'tags.section': 1 });

export default mongoose.model('McqQuestion', mcqQuestionSchema);

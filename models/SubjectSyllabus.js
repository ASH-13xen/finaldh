import mongoose from 'mongoose';

// A subject's syllabus: chapters in order, each with its sub-topics. Parsed from a Word file the
// admin uploads (utils/syllabusDocx.js). Tests and Question Bank PYQs of the subject are placed
// under these chapters (utils/syllabusTagging.js), so solutions read in syllabus order.
//
// A chapter's `key` is a slug of its title: re-uploading the file keeps existing placements as long
// as the chapter keeps its name. The Economy keys are also the Master File's theme keys
// (utils/economyThemes.js).

const chapterSchema = new mongoose.Schema({
  key: { type: String, required: true },
  number: { type: Number, required: true },
  title: { type: String, required: true },
  subtopics: { type: [String], default: [] },
}, { _id: false });

const subjectSyllabusSchema = new mongoose.Schema({
  subject: { type: String, required: true, unique: true, trim: true }, // same string as McqTest.subject / QuestionBank.subject
  chapters: { type: [chapterSchema], default: [] },
  studyOrder: { type: String, default: '' },   // the file's "Suggested Study Order" line, if any
  fileName: { type: String, default: '' },
}, { timestamps: true });

export default mongoose.model('SubjectSyllabus', subjectSyllabusSchema);

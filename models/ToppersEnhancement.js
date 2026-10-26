import mongoose from 'mongoose';

// The "enhancement layer" drawn over ONE topper's answer copy (Aspirants-Hub style
// margin notes). It never critiques the topper — only two kinds of note:
//   • works — green, left margin: the technique behind a stretch of lines
//   • addon — blue, right margin: extra material that builds on the topper's point
// plus an end-of-answer Takeaways card.
//
// Kept in its own collection (not inside ToppersCopy.questions[].answers[]) because
// the admin PATCH /admin/:id rewrites questions[] wholesale, which would silently
// drop anything the admin form didn't round-trip. Keyed by the answer's page range
// inside the topic PDF — that range is what the notes are anchored to.

const noteSchema = new mongoose.Schema({
  page: { type: Number, required: true },           // absolute page in the topic PDF
  kind: { type: String, enum: ['works', 'addon'], required: true },
  // Vertical span of the lines the note is about, as fractions of page height (0 = top).
  yFrom: { type: Number, required: true, min: 0, max: 1 },
  yTo: { type: Number, required: true, min: 0, max: 1 },
  title: { type: String, default: '', trim: true },  // works: the technique · addon: "Enrich with…" heading
  text: { type: String, default: '', trim: true },   // one line of explanation
  points: { type: [String], default: [] },           // addon: 1-3 concrete add-ons (report, data, case, example)
});

const toppersEnhancementSchema = new mongoose.Schema({
  toppersCopy: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersCopy', required: true },
  questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  startPage: { type: Number, required: true },       // the answer's range — the key
  endPage: { type: Number, required: true },
  topperName: { type: String, default: '' },

  notes: { type: [noteSchema], default: [] },
  takeaways: {
    techniques: { type: [String], default: [] },     // what to copy from this answer
    enrichment: { type: [String], default: [] },     // reports / cases / data / quotes to add
    keywords: { type: [String], default: [] },
  },

  published: { type: Boolean, default: false },      // drafts are admin-only
  aiModel: { type: String, default: '' },
  generatedAt: { type: Date, default: null },
  editedAt: { type: Date, default: null },
}, { timestamps: true });

toppersEnhancementSchema.index({ toppersCopy: 1, startPage: 1, endPage: 1 }, { unique: true });

export default mongoose.model('ToppersEnhancement', toppersEnhancementSchema);

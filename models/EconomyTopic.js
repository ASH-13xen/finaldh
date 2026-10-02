import mongoose from 'mongoose';

// One numbered topic of the Economy Master File ("8. Monetary Policy Committee (MPC)"), parsed
// from the PDF by scripts/parse_economy_master.mjs.
//
// The PDF has three parts that each cover the same themes (Forum, Part B, Vision). `themeKey`
// is the canonical student-facing theme (utils/economyThemes.js); `sourceTheme` is the heading
// it sat under in its own part. `importKey` = source|sourceTheme|number|title — stable across
// re-imports, so a re-parse updates the text in place and keeps everything layered on top
// (facts, research, student progress / bookmarks, which reference _id).
//
// Body text is kept as blocks of styled spans so the PDF's emphasis survives:
//   span.t  text      span.b  bold key term      span.hl  highlight 'g' green | 'c' cyan | 'y' yellow
//   span.m  'ok' | 'no'  — the ✅ / ❌ marks used to flag the right / wrong option

const spanSchema = new mongoose.Schema({
  t: { type: String, default: '' },
  b: { type: Number },
  hl: { type: String, enum: ['g', 'c', 'y'] },
  m: { type: String, enum: ['ok', 'no'] },
}, { _id: false });

const blockSchema = new mongoose.Schema({
  level: { type: Number, default: 0, min: 0, max: 3 },
  glyph: { type: String, default: null },     // null = plain paragraph
  heading: { type: Boolean, default: false }, // a sub-heading inside the topic
  spans: { type: [spanSchema], default: [] },
}, { _id: false });

export const SOURCES = ['forum', 'partB', 'vision'];

const economyTopicSchema = new mongoose.Schema({
  themeKey: { type: String, required: true, index: true },
  source: { type: String, enum: SOURCES, required: true },
  sourceTheme: { type: String, default: '' },
  number: { type: Number, default: null },
  title: { type: String, required: true },
  order: { type: Number, default: 0 },             // position in the PDF; sorts topics within a theme
  pages: { type: [Number], default: [] },          // 1-based pages of the source PDF
  blocks: { type: [blockSchema], default: [] },
  pyqTags: { type: [String], default: [] },        // "CSE 2022", "CDS 2023 (I)" — as printed in the PDF
  importKey: { type: String, required: true, unique: true },

  // Layered on by admins (optionally AI-drafted) — never overwritten by a re-import.
  facts: { type: [String], default: [] },          // relatable, real-world hooks
  research: { type: String, default: '' },         // crisp "beyond the book" note (plain text, \n-separated)
  extrasStatus: { type: String, enum: ['none', 'draft', 'published'], default: 'none' },

  hidden: { type: Boolean, default: false },       // admin can hide a junk / duplicate topic
  editedAt: { type: Date, default: null },         // set when an admin hand-edits the body
}, { timestamps: true });

economyTopicSchema.index({ themeKey: 1, order: 1 });
economyTopicSchema.index({ title: 'text', 'blocks.spans.t': 'text' });

export default mongoose.model('EconomyTopic', economyTopicSchema);

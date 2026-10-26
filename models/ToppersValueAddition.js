import mongoose from 'mongoose';

// "Value addition" material for one Toppers Copy topic — extra data, facts, reports,
// case studies, diagrams to lift an answer above the toppers'. Each entry is a titled
// note and/or a PDF the admin uploads; students open it from the Related PYQs drawer.
//
// Own collection (not inside ToppersCopy) for the same reason as ToppersBestPart: the
// admin PATCH /admin/:id rewrites the topic doc wholesale.

const toppersValueAdditionSchema = new mongoose.Schema({
  toppersCopy: { type: mongoose.Schema.Types.ObjectId, ref: 'ToppersCopy', required: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, default: '' },                // plain-text notes, shown above the PDF
  pdfKey: { type: String, default: '' },              // 'r2://tc-value-addition/…' or ''
  pdfName: { type: String, default: '' },             // original file name, for the admin list
  pdfSize: { type: Number, default: 0 },
  // Searchable notes bank parsed from an uploaded Word file (utils/valueAdditionDocx.js):
  // { sections: [{ id, name, pyqs, keywords }], notes: [{ id, section, type, sub, title, text, cols? }] }.
  // Sent to students only through GET /value-additions/:vid/bank, not with the topic.
  bank: { type: mongoose.Schema.Types.Mixed, default: null },
  bankName: { type: String, default: '' },            // original .docx name, for the admin list
  bankStats: {
    notes: { type: Number, default: 0 },
    pyqs: { type: Number, default: 0 },
    sections: { type: Number, default: 0 },
  },
  published: { type: Boolean, default: true },        // hide a half-ready entry from students
  order: { type: Number, default: 0 },
}, { timestamps: true });

toppersValueAdditionSchema.index({ toppersCopy: 1, order: 1 });

export default mongoose.model('ToppersValueAddition', toppersValueAdditionSchema);

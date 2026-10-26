import mongoose from 'mongoose';

// A student's named notebook in My Notes ("Polity revision", "Ethics examples"…). Any saved
// item (UserNote) can be filed into one notebook via UserNote.notebook; deleting a notebook
// just un-files its items, it never deletes them.
// A notebook with a `parent` is a sub-topic inside that notebook ("Polity" › "Parliament");
// only one level deep, so a parent is always a top-level notebook.
const notebookSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Notebook', default: null },
}, { timestamps: true });

notebookSchema.index({ user: 1, name: 1 });
notebookSchema.index({ user: 1, parent: 1 });

export default mongoose.model('Notebook', notebookSchema);

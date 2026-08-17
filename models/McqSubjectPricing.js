import mongoose from 'mongoose';

// One flat price per subject, set by admin. Buying a subject grants McqTest access to every
// test in it - present and future (see User.purchasedMcqSubjects) - rather than a fixed
// snapshot of tests that existed at purchase time.
const mcqSubjectPricingSchema = new mongoose.Schema({
  subject: { type: String, required: true, unique: true },
  price: { type: Number, required: true, default: 999 },
  discountedPrice: { type: Number, default: 0 },
  useDiscount: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('McqSubjectPricing', mcqSubjectPricingSchema);

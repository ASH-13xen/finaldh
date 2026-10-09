import mongoose from 'mongoose';

// Toppers Copy is sold per subject (GS-1, GS-2, ...) plus one all-subjects bundle, whose
// row uses the reserved key ALL_SUBJECTS. Buying unlocks every topic in the subject(s),
// present and future (see User.purchasedToppersSubjects). Same shape as McqSubjectPricing.
export const ALL_SUBJECTS = '__all__';

const toppersCopyPricingSchema = new mongoose.Schema({
  plan: { type: String, required: true, unique: true }, // a subject, or ALL_SUBJECTS
  price: { type: Number, required: true, default: 999 },
  discountedPrice: { type: Number, default: 0 },
  useDiscount: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('ToppersCopyPricing', toppersCopyPricingSchema);

// One-off: seeds an initial McqSubjectPricing doc for every subject that has at least one
// locked (requiresPurchase) test, so the new subject-bundle purchase flow works immediately
// for existing data. Price defaults to the sum of that subject's locked tests' prices - a
// starting point the admin can edit anytime in Manage MCQ > Subject Pricing. Idempotent -
// skips any subject that already has a pricing doc, safe to re-run.
import 'dotenv/config';
import mongoose from 'mongoose';
import McqTest from '../models/McqTest.js';
import McqSubjectPricing from '../models/McqSubjectPricing.js';

await mongoose.connect(process.env.MONGODB_URI);

const lockedTests = await McqTest.find({ requiresPurchase: true });
const bySubject = {};
for (const t of lockedTests) {
  const effectivePrice = t.useDiscount ? t.discountedPrice : t.price;
  bySubject[t.subject] = (bySubject[t.subject] || 0) + effectivePrice;
}

let created = 0, skipped = 0;
for (const [subject, sumPrice] of Object.entries(bySubject)) {
  const existing = await McqSubjectPricing.findOne({ subject });
  if (existing) {
    skipped++;
    console.log(`Skipped ${subject} - pricing already configured (₹${existing.price})`);
    continue;
  }
  await McqSubjectPricing.create({ subject, price: sumPrice });
  created++;
  console.log(`Created ${subject} - ₹${sumPrice}`);
}

console.log(`\nDone. Created ${created}, skipped ${skipped}.`);
await mongoose.disconnect();

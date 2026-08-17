// One-off migration: the 5 seeded test papers (Economics/Geography/Polity) were created
// before MCQ tests defaulted to requiresPurchase=true. Bring them in line with the new
// locked-by-default policy. Idempotent - safe to re-run.
import 'dotenv/config';
import mongoose from 'mongoose';
import McqTest from '../models/McqTest.js';

await mongoose.connect(process.env.MONGODB_URI);

const result = await McqTest.updateMany(
  { requiresPurchase: false },
  { $set: { requiresPurchase: true, price: 499 } }
);
console.log(`Locked ${result.modifiedCount} test(s) (matched ${result.matchedCount}).`);

const tests = await McqTest.find({}).select('title subject requiresPurchase price isPublished');
tests.forEach(t => console.log(`- ${t.title} (${t.subject}): requiresPurchase=${t.requiresPurchase} price=${t.price} published=${t.isPublished}`));

await mongoose.disconnect();

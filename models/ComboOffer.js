import mongoose from 'mongoose';
import { peopleConn } from '../config/peopleDb.js';

const comboOfferSchema = new mongoose.Schema({
  label: { type: String, required: true },
  eligibleCourseIds: { type: [String], required: true, default: [] },
  pickCount: { type: Number, required: true, min: 1 },
  requiredCourseIds: { type: [String], default: [] },
  price: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

export default peopleConn.model('ComboOffer', comboOfferSchema);

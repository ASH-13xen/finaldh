import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in your environment variables.');
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB successfully');

    // Dynamically drop the old unique index on upiTxnId if it exists in MongoDB
    try {
      const db = mongoose.connection.db;
      if (db) {
        await db.collection('purchaserequests').dropIndex('upiTxnId_1');
        console.log('Successfully dropped old upiTxnId_1 unique index');
      }
    } catch (indexErr) {
      // Error code 27 is IndexNotFound. We ignore it.
      if (indexErr.code !== 27 && indexErr.code !== 85) {
        console.log('Notice: Check on upiTxnId_1 index:', indexErr.message);
      }
    }
  } catch (err) {
    console.error('\n======================================================');
    console.error('DATABASE CONNECTION ERROR:');
    console.error(err.message || err);
    console.error('------------------------------------------------------');
    console.error('Diagnostic Tips:');
    console.error('1. IP Whitelist Issue: If using MongoDB Atlas, make sure your');
    console.error('   current IP address is whitelisted in your Atlas console.');
    console.error('   URL: https://cloud.mongodb.com/');
    console.error('2. Local Fallback: Alternatively, you can use a local MongoDB');
    console.error('   instance by editing backend/.env:');
    console.error('   MONGODB_URI=mongodb://127.0.0.1:27017/pdfff_db');
    console.error('======================================================\n');
  }
};

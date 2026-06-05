import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in your environment variables.');
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB successfully');
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

import mongoose from 'mongoose';
import { peopleConn, openPeopleDb } from './peopleDb.js';

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

  // Users, purchases, download requests/logs, combo offers and UPSC QAs live in a separate cluster (see
  // config/peopleDb.js). Without it the app would see no users at all, so refuse to run rather than limp along.
  try {
    await openPeopleDb();
    console.log('Connected to the people/purchases MongoDB successfully');

    // Dynamically drop the old unique index on upiTxnId if it exists in MongoDB
    try {
      await peopleConn.db.collection('purchaserequests').dropIndex('upiTxnId_1');
      console.log('Successfully dropped old upiTxnId_1 unique index');
    } catch (indexErr) {
      // Error code 27 is IndexNotFound, 26 is NamespaceNotFound. We ignore both.
      if (indexErr.code !== 27 && indexErr.code !== 85 && indexErr.code !== 26) {
        console.log('Notice: Check on upiTxnId_1 index:', indexErr.message);
      }
    }
  } catch (err) {
    console.error('\n======================================================');
    console.error('PEOPLE DATABASE CONNECTION ERROR:');
    console.error(err.message || err);
    console.error('------------------------------------------------------');
    console.error('Set MONGODB_URI_PEOPLE in backend/.env (and in your hosting environment) to the');
    console.error('connection string of the cluster that holds users and purchases, and make sure');
    console.error('this machine\'s IP address is allowed in that cluster\'s Atlas Network Access list.');
    console.error('======================================================\n');
    process.exit(1);
  }
};

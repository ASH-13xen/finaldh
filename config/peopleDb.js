import mongoose from 'mongoose';

// Personal and purchase data lives in its own MongoDB cluster (MONGODB_URI_PEOPLE), separate from the
// course / MCQ / progress content (MONGODB_URI) so the content cluster can be shared without exposing
// who signed up, who bought what, or what they paid. Models for the collections below are registered on
// this connection instead of the default one, so every read and write for them goes to the people cluster.
export const peopleConn = mongoose.createConnection();

// Collection names as Mongoose derives them from the model names in models/.
export const PEOPLE_COLLECTIONS = [
  'users',
  'purchaserequests',
  'mcqpurchaserequests',
  'downloadrequests',
  'combooffers',
  'upscqas',
  'downloadlogs'
];

let opening = null;

// Idempotent. The connection is opened here (not at import time) because the environment is loaded after
// the model files are imported; operations issued before it opens are buffered by Mongoose.
export const openPeopleDb = (uri = process.env.MONGODB_URI_PEOPLE, options = {}) => {
  if (!uri) {
    return Promise.reject(new Error('MONGODB_URI_PEOPLE is not defined in your environment variables.'));
  }
  if (!opening) {
    opening = peopleConn.openUri(uri, options).then(() => peopleConn, (err) => {
      opening = null;
      throw err;
    });
  }
  return opening;
};

export const closePeopleDb = async () => {
  opening = null;
  await peopleConn.close();
};

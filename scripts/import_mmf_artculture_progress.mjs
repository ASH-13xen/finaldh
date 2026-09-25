// One-time import of Progress checklist + PYQ data for the "MMF-Art and Culture" file inside the
// existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-7) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Governance imports. `tag` on each sub-heading is a short clean keyword for
// precise PYQ matching, mostly reusing the PYQ document's own microtheme labels where they read
// as clean phrases (e.g. "Indus Valley Civilization", "Kingdoms x Chola"). PYQs with no
// dedicated sub-heading (Taxila, rock-cut architecture, Tandava dance, Akbar, geographical
// factors, philosophy shaping monuments) fall back to the closest relevant chapter.
//
// Not blindly rerunnable: additive/upsert for the checklist, delete+reinsert for PYQs. Guarded
// with existing-data checks that skip unless --force.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Course from '../models/Course.js';
import Topic from '../models/Topic.js';
import ProgressPyq from '../models/ProgressPyq.js';
import { upsertTopicsAndQuestions } from '../controllers/progressController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const FORCE = process.argv.includes('--force');
const TARGET_FILE_NAME = 'MMF-Art and Culture';

const C1 = 'Chapter 1: Ancient India – Indus Valley to Post-Mauryan';
const C2 = 'Chapter 2: Ancient India – Gupta Age & South Indian Dynasties';
const C3 = 'Chapter 3: Medieval India';
const C4 = 'Chapter 4: Indian Architecture';
const C5 = 'Chapter 5: Indian Literature, Languages & Epigraphy';
const C6 = 'Chapter 6: Indian Music, Painting & Crafts';
const C7 = 'Chapter 7: Contemporary Relevance & Cultural Preservation';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Harappan Seals – Motifs & Symbols', pageNumber: 2, tag: 'Indus Valley Civilization' },
  { topicName: C1, questionText: '1.2 Harappan Seals & Sealings – Socio-Economic and Religious Life', pageNumber: 2, tag: 'Indus Valley Civilization' },
  { topicName: C1, questionText: '1.3 Indus Valley Civilization: Admiration for Art', pageNumber: 3, tag: 'Indus Valley Civilization' },
  { topicName: C1, questionText: '1.4 Society & Economy: Rig Vedic to Later Vedic Period', pageNumber: 3, tag: 'Vedic Culture' },
  { topicName: C1, questionText: '1.5 Upanishadic Thought – From Ritualism to Spiritual Inquiry', pageNumber: 4, tag: '' },
  { topicName: C1, questionText: '1.6 Transformation of Vedic Brahmanism into Puranic Hinduism', pageNumber: 5, tag: '' },
  { topicName: C1, questionText: '1.7 Impact of the Mauryan Dynasty on Art & Literature in North India', pageNumber: 5, tag: '' },
  { topicName: C1, questionText: '1.8 Post-Mauryan Regional Schools of Art', pageNumber: 6, tag: 'Buddhism and Jainism' },
  { topicName: C1, questionText: '1.9 Persian & Greek Presence in Ancient India', pageNumber: 7, tag: 'Buddhism and Jainism' },
  { topicName: C1, questionText: "1.10 Guilds (Shrenis) in Ancient India's Economy", pageNumber: 7, tag: '' },

  { topicName: C2, questionText: '2.1 The Gupta Age as the "Golden Age" – A Critical Examination', pageNumber: 9, tag: 'Kingdoms' },
  { topicName: C2, questionText: '2.2 Sangam Literature and the Status of Women in Early Tamil Society', pageNumber: 10, tag: 'Historical Sources' },
  { topicName: C2, questionText: '2.3 Pallavas of Kanchi – Contribution to Art & Literature', pageNumber: 10, tag: 'Kingdoms' },
  { topicName: C2, questionText: '2.4 Chola Achievements in Art and Architecture', pageNumber: 11, tag: 'Kingdoms x Chola' },

  { topicName: C3, questionText: '3.1 Bhakti Movement – Rise and Basic Tenets', pageNumber: 13, tag: 'Bhakti and Sufi Movements' },
  { topicName: C3, questionText: '3.2 Indo-Islamic Architecture – Provincial & Imperial Styles', pageNumber: 13, tag: '' },
  { topicName: C3, questionText: '3.3 Indo-Persian Culture under the Delhi Sultanate', pageNumber: 14, tag: 'Kingdom x Sultanate;Sources x Literature' },
  { topicName: C3, questionText: '3.4 Vijayanagara Empire – Contributions to Art, Architecture & Culture', pageNumber: 15, tag: 'Kingdoms x Kings' },

  { topicName: C4, questionText: '4.1 Nagara, Dravida & Vesara Temple Architecture', pageNumber: 17, tag: 'Sculptures' },
  { topicName: C4, questionText: '4.2 Buddhist and Jain Architecture', pageNumber: 18, tag: 'Buddhism and Jainism' },
  { topicName: C4, questionText: '4.3 Symbolism in Stupas & Temples', pageNumber: 18, tag: 'Buddhism and Jainism;Sculptures' },

  { topicName: C5, questionText: '5.1 Sanskrit Literature in Buddhism & Jainism', pageNumber: 20, tag: '' },
  { topicName: C5, questionText: '5.2 Classical Languages & Preservation of Cultural Heritage', pageNumber: 20, tag: 'Conservation of Indian Art & Heritage' },
  { topicName: C5, questionText: "5.3 Epigraphy – Significance for India's Art & Culture", pageNumber: 21, tag: 'Foreign Travellers;Historical Sources' },

  { topicName: C6, questionText: '6.1 Hindustani and Carnatic Streams of Music', pageNumber: 23, tag: '' },
  { topicName: C6, questionText: '6.2 Hindustani and Carnatic Schools of Music: Comparison', pageNumber: 23, tag: '' },
  { topicName: C6, questionText: '6.3 Pioneers of Contemporary Indian Art', pageNumber: 24, tag: '' },
  { topicName: C6, questionText: "6.4 Evolution of India's Textile Traditions", pageNumber: 24, tag: '' },

  { topicName: C7, questionText: '7.1 Preserving Cultural Traditions in the Age of Globalization', pageNumber: 26, tag: 'Conservation of Indian Art & Heritage' }
];

// ================= PYQs, classified against the checklist tags above (or Chapter fallback) =================
const PYQ_ROWS = [
  { questionText: 'Taxila university was one of the oldest universities of the world with which were associated a number of renowned learned personalities of different disciplines. Its strategic location caused its fame to flourish, but unlike Nalanda, it is not considered as a university in the modern sense. Discuss.', section: C1, year: 2014 },

  { questionText: 'The rock-cut architecture represents one of the most important sources of our knowledge of early Indian art and history. Discuss.', section: C4, year: 2020 },
  { questionText: 'Mesolithic rock cut architecture of India not only reflects the cultural life of the times but also a tine aesthetic sense comparable to modern painting. Critically evaluate this comment.', section: C4, year: 2015 },

  { questionText: 'Discuss the Tandava dance as recorded in the early Indian inscriptions.', section: C6, year: 2013 },

  { questionText: 'Evaluate the nature of the Bhakti literature and its contribution to Indian culture.', section: 'Bhakti and Sufi Movements', year: 2021 },
  { questionText: 'The Bhakti movement received a remarkable re-orientation with the advent of Sri Chaitanya Mahaprabhu. Discuss.', section: 'Bhakti and Sufi Movements', year: 2018 },
  { questionText: 'Sufis and medieval mystic saints failed to modify either the religious ideas and practices or the outward structure of Hindu/Muslim societies to any appreciable extent. Comment.', section: 'Bhakti and Sufi Movements', year: 2014 },

  { questionText: 'Highlight the Central Asian and Greco-Bactrian elements in Gandhara art.', section: 'Buddhism and Jainism', year: 2019 },
  { questionText: 'Early Buddhist Stupa-art, while depicting folk motifs and narratives successfully expounds Buddhist ideals. Elucidate.', section: 'Buddhism and Jainism', year: 2016 },
  { questionText: 'Gandhara sculpture owed as much to the Romans as to the Greeks. Explain.', section: 'Buddhism and Jainism', year: 2014 },

  { questionText: 'Safeguarding the Indian art heritage is the need of the moment. Discuss.', section: 'Conservation of Indian Art & Heritage', year: 2018 },

  { questionText: 'Assess the importance of the accounts of the Chinese and Arab travellers in the reconstruction of the history of India.', section: 'Foreign Travellers', year: 2018 },

  { questionText: 'Though not very useful from the point of view of a connected political history of South India, the Sangam literature portrays the social and economic conditions of its time with remarkable vividness. Comment.', section: 'Historical Sources', year: 2013 },

  { questionText: 'Discuss the salient features of the Harappan architecture.', section: 'Indus Valley Civilization', year: 2025 },
  { questionText: 'The ancient civilization in Indian sub-continent differed from those of Egypt, Mesopotamia and Greece in that its culture and traditions have been preserved without a breakdown to the present day. Comment.', section: 'Indus Valley Civilization', year: 2015 },
  { questionText: 'To what extent has the urban planning and culture of the Indus Valley Civilization provided inputs to the present day urbanization? Discuss.', section: 'Indus Valley Civilization', year: 2014 },

  { questionText: "'The sculptors filled the Chandella artform with resilient vigor and breadth of life.' Elucidate.", section: 'Sculptures', year: 2025 },
  { questionText: 'Estimate the contribution of Pallavas of Kanchi for the development of art and literature of South India.', section: 'Kingdoms', year: 2024 },
  { questionText: 'Pala period is the most significant phase in the history of Buddhism in India. Enumerate.', section: 'Buddhism and Jainism', year: 2020 },
  { questionText: 'How do you justify the view that the level of excellence of Gupta numismatic art is not at all noticeable in later times?', section: 'Kingdoms', year: 2017 },

  { questionText: '"Though the great Cholas are no more yet their name is still remembered with great pride because of their highest achievements in the domain of art and architecture." Comment.', section: 'Kingdoms x Chola', year: 2024 },
  { questionText: 'Chola architecture represents a high watermark in the evolution of temple architecture. Discuss.', section: 'Kingdoms x Chola', year: 2013 },

  { questionText: "Examine the main aspects of Akbar's religious syncretism.", section: C3, year: 2025 },
  { questionText: 'Krishnadeva Raya, the King of Vijayanagar, was not only an accomplished scholar himself but was also a great patron of learning and literature. Discuss.', section: 'Kingdoms x Kings', year: 2016 },

  { questionText: 'Discuss the main contributions of Gupta period and Chola period to Indian heritage and culture.', section: 'Kingdoms', year: 2022 },

  { questionText: 'What were the major technological changes introduced during the Sultanate period? How did those technological changes influence the Indian society?', section: 'Kingdom x Sultanate', year: 2023 },

  { questionText: 'Explain the role of geographical factors towards the development of Ancient India.', section: C1, year: 2023 },

  { questionText: 'Indian philosophy and tradition played a significant role in conceiving and shaping the monuments and their art in India. Discuss.', section: C4, year: 2020 },

  { questionText: 'How will you explain that medieval Indian temple sculptures represent the social life of those days?', section: 'Sculptures', year: 2022 },
  { questionText: 'Discuss the significance of the lion and bull figures in Indian mythology, art and architecture.', section: 'Sculptures', year: 2022 },

  { questionText: 'Persian literary sources of medieval India reflect the spirit of the age. Comment.', section: 'Sources x Literature', year: 2020 },

  { questionText: 'Underline the changes in the field of society and economy from the Rig Vedic to the later Vedic period.', section: 'Vedic Culture', year: 2024 },
  { questionText: 'What are the main features of Vedic society and religion? Do you think some of the features are still prevailing in Indian society?', section: 'Vedic Culture', year: 2023 }
];

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('No MONGODB_URI found');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const course = await Course.findOne({ courseId: 'MMF' });
  if (!course) {
    console.error('No Course with courseId "MMF" found - aborting.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const fileIndex = course.fileNames.findIndex((name) => name === TARGET_FILE_NAME);
  if (fileIndex === -1) {
    console.error(`No fileName exactly matching "${TARGET_FILE_NAME}" on the MMF course. fileNames: ${JSON.stringify(course.fileNames)}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Found course "${course.name}" (${course._id}), targeting fileIndex ${fileIndex} ("${course.fileNames[fileIndex]}")`);

  const existingTopicCount = await Topic.countDocuments({ course: course._id, fileIndex });
  if (existingTopicCount > 0 && !FORCE) {
    console.log(`SKIP checklist import: fileIndex ${fileIndex} already has ${existingTopicCount} topic(s). Pass --force to import anyway (will duplicate questions).`);
  } else {
    const result = await upsertTopicsAndQuestions(course, fileIndex, CHECKLIST_ROWS);
    console.log(`Checklist: inserted ${result.insertedCount} question(s) across ${result.touchedTopicCount} topic(s) (${result.newTopicsCount} new).`);
    if (result.skippedRows.length > 0) {
      console.log(`  skipped ${result.skippedRows.length} row(s):`);
      for (const s of result.skippedRows) console.log(`    - row ${s.row}: ${s.reason}`);
    }
  }

  const existingPyqCount = await ProgressPyq.countDocuments({ course: course._id, fileIndex });
  if (existingPyqCount > 0 && !FORCE) {
    console.log(`SKIP PYQ import: fileIndex ${fileIndex} already has ${existingPyqCount} PYQ(s). Pass --force to import anyway (will replace).`);
  } else {
    if (existingPyqCount > 0 && FORCE) {
      await ProgressPyq.deleteMany({ course: course._id, fileIndex });
      console.log(`--force: cleared ${existingPyqCount} existing PYQ(s) for fileIndex ${fileIndex}.`);
    }
    const docs = PYQ_ROWS.map((r) => ({
      questionText: r.questionText,
      subject: course.subject,
      course: course._id,
      fileIndex,
      section: r.section,
      year: r.year
    }));
    const inserted = await ProgressPyq.insertMany(docs);
    console.log(`PYQs: inserted ${inserted.length} PYQ(s).`);
  }

  if (!course.progressEnabled) {
    course.progressEnabled = true;
    await course.save();
    console.log('Enabled progressEnabled on the MMF course.');
  } else {
    console.log('progressEnabled already true on the MMF course.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

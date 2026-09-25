// One-time import of Progress checklist + PYQ data for the "MMF - World History" file inside the
// existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-7) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Modern History imports. `tag` on each sub-heading is a short clean keyword for
// precise PYQ matching. A few PYQs with no dedicated sub-heading (Indian indentured-labour
// diaspora, "Germany and the two world wars", "foundations of the modern world" spanning both
// revolutions) fall back to the closest relevant chapter.
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
const TARGET_FILE_NAME = 'MMF - World History';

const C1 = 'Chapter 1: Cold War Era & Bipolar World';
const C2 = 'Chapter 2: Revolutions of the Modern World';
const C3 = 'Chapter 3: Industrial Revolution and its Global Impact';
const C4 = 'Chapter 4: Rise of Modern Nation-States';
const C5 = 'Chapter 5: World Wars and the Interwar Crisis';
const C6 = 'Chapter 6: European Diplomacy and Power Politics';
const C7 = 'Chapter 7: Decline of European Empires and Decolonization';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Factors Behind the End of the Cold War and Disintegration of the USSR', pageNumber: 2, tag: '' },
  { topicName: C1, questionText: '1.2 The Sino-Soviet Split and Its Implications for India', pageNumber: 3, tag: '' },
  { topicName: C1, questionText: '1.3 Causes and Consequences of the Fall of the Berlin Wall', pageNumber: 4, tag: '' },
  { topicName: C1, questionText: '1.4 Vietnam War: A Proxy Conflict with a Strong Nationalist Character', pageNumber: 5, tag: '' },

  { topicName: C2, questionText: '2.1 Jacobins and their Role in the French Revolution', pageNumber: 6, tag: '' },
  { topicName: C2, questionText: '2.2 Reasons for American Resentment Behind the American Revolution', pageNumber: 6, tag: '' },
  { topicName: C2, questionText: '2.3 American Revolution: An Economic Revolt Against Mercantilism', pageNumber: 7, tag: 'American Revolution' },
  { topicName: C2, questionText: '2.4 French Revolution: Causes and Influence on the Indian Constitution', pageNumber: 8, tag: '' },
  { topicName: C2, questionText: '2.5 French Revolution: Enduring Relevance to the Contemporary World', pageNumber: 9, tag: 'French Revolution' },
  { topicName: C2, questionText: "2.6 Lenin's Political and Economic Changes after the Russian Revolution", pageNumber: 9, tag: '' },
  { topicName: C2, questionText: '2.7 Russian Revolution: Why October Was More Significant Than February', pageNumber: 10, tag: '' },

  { topicName: C3, questionText: '3.1 Industrial Revolution: Global Trade Patterns and Social Hierarchies', pageNumber: 12, tag: 'Industrial Revolution' },
  { topicName: C3, questionText: '3.2 Industrial Revolution as a Social and Cultural Upheaval', pageNumber: 12, tag: 'Industrial Revolution' },
  { topicName: C3, questionText: '3.3 Socio-Economic Effects of the Introduction of Railways Worldwide', pageNumber: 13, tag: 'Railways' },
  { topicName: C3, questionText: '3.4 England as Harbinger of the Industrial Revolution: Consequences for India', pageNumber: 14, tag: 'Industrial Revolution;India Impact' },

  { topicName: C4, questionText: "4.1 Importance of the Meiji Restoration in Japan's Modernisation", pageNumber: 15, tag: 'Meiji Restoration' },

  { topicName: C5, questionText: '5.1 First World War: Fought for the Preservation of Balance of Power?', pageNumber: 16, tag: 'World War I' },
  { topicName: C5, questionText: '5.2 Fascism: Key Characteristics and Factors for its Emergence', pageNumber: 17, tag: '' },
  { topicName: C5, questionText: '5.3 Why Britain Followed a Policy of Appeasement During the Inter-War Years', pageNumber: 18, tag: '' },
  { topicName: C5, questionText: "5.4 Spanish Civil War: 'The Opening Act of World War II'", pageNumber: 19, tag: '' },
  { topicName: C5, questionText: '5.5 The New Deal: Critical Evaluation of Its Effectiveness', pageNumber: 20, tag: 'New Deal' },
  { topicName: C5, questionText: '5.6 The League of Nations: A Premature Experiment in Collective Security', pageNumber: 21, tag: '' },
  { topicName: C5, questionText: '5.7 Fragility of Democracy in Inter-War Europe', pageNumber: 22, tag: 'Fragility of Democracy' },

  { topicName: C6, questionText: '6.1 Congress of Vienna (1814-15): Role in Reshaping Post-Napoleonic Europe', pageNumber: 23, tag: '' },

  { topicName: C7, questionText: "7.1 Suez Crisis 1956: Events and Blow to Britain's World-Power Image", pageNumber: 24, tag: 'Suez Crisis' },
  { topicName: C7, questionText: '7.2 Britain\'s Retreat from America: A Reorientation, Not a Decline', pageNumber: 24, tag: '' },
  { topicName: C7, questionText: '7.3 Decolonization: A Compulsion, Not Imperial Benevolence', pageNumber: 25, tag: 'Decolonization' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  { questionText: 'The French Revolution has enduring relevance to the contemporary world. Explain.', section: 'French Revolution', year: 2025 },
  { questionText: 'Explain how the foundations of the modern world were laid by the American and French revolution.', section: C2, year: 2019 },
  { questionText: 'American Revolution was an economic revolt against mercantilism. Substantiate.', section: 'American Revolution', year: 2013 },

  { questionText: 'What problems were germane to the decolonization process of Malay Peninsula.', section: 'Decolonization', year: 2017 },
  { questionText: 'The anti-colonial struggles in West Africa were led by the new elite of Western-educated Africans. Examine.', section: 'Decolonization', year: 2016 },
  { questionText: 'What were the major political, economic and social developments in the world which motivated the anti-colonial struggle in India?', section: 'Decolonization', year: 2014 },
  { questionText: 'Africa was chopped into states artificially created by accident of European competition. Analyse.', section: 'Decolonization', year: 2013 },

  { questionText: 'Why indentured labour was taken by the British from India to other colonies? Have they been able to preserve their cultural identity over there?', section: C7, year: 2018 },

  { questionText: 'How far was the Industrial Revolution in England responsible for the decline of handicrafts and cottage industries in India?', section: 'India Impact', year: 2024 },
  { questionText: 'Why did the industrial revolution first occur in England? Discuss the quality of life of the people there during the industrialization. How does it compare with that in India at present?', section: 'Industrial Revolution', year: 2015 },
  { questionText: 'Latecomer Industrial revolution in Japan involved certain factors that were markedly different from what west had experience.', section: 'Meiji Restoration', year: 2013 },

  { questionText: 'Bring out the socio-economic effects of the introduction of railways in different countries of the world.', section: 'Railways', year: 2023 },

  { questionText: "What were the events that led to the Suez Crisis in 1956? How did it deal a final blow to Britain's self-image as a world power?", section: 'Suez Crisis', year: 2014 },
  { questionText: 'What policy instruments were deployed to contain the great economic depression?', section: 'New Deal', year: 2013 },

  { questionText: 'How far is it correct to say that the First World War was fought essentially for the preservation of balance of power?', section: 'World War I', year: 2024 },
  { questionText: '"There arose a serious challenge to the Democratic State System between the two World Wars." Evaluate the statement.', section: 'Fragility of Democracy', year: 2021 },
  { questionText: 'To what extent can Germany be held responsible for causing the two World Wars? Discuss critically', section: C5, year: 2015 }
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

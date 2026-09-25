// One-time import of Progress checklist + PYQ data for the "MMF-Modern History" file inside the
// existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-11) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Social Justice/Environment imports. `tag` on each sub-heading is a short clean
// keyword for precise PYQ matching. The "Gandhi x Indian Leaders" microtheme (Gandhi vs Tagore/
// Bose/Ambedkar comparisons) is bucketed onto 8.1 (the book's own "Differing Approaches of
// Bhagat Singh and Mahatma Gandhi" item - the closest "Gandhi vs another leader" slot, even
// though the specific leader differs per PYQ). A few PYQs with no dedicated sub-heading
// (Moderates, "voices of the Gandhian phase", famine, Dalhousie, naval mutiny) fall back to the
// closest relevant chapter.
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
const TARGET_FILE_NAME = 'MMF-Modern History';

const C1 = 'Chapter 1: European Powers, EIC Expansion & Consolidation of British Rule';
const C2 = 'Chapter 2: 18th Century India & Decline of the Mughal Empire';
const C3 = 'Chapter 3: British Economic Policies and Their Impact';
const C4 = 'Chapter 4: Socio-Religious Reform Movements';
const C5 = 'Chapter 5: The Revolt of 1857';
const C6 = 'Chapter 6: Rise and Growth of Indian Nationalism';
const C7 = 'Chapter 7: Gandhian Era – Mass Movements';
const C8 = 'Chapter 8: Revolutionary Movements in the Freedom Struggle';
const C9 = 'Chapter 9: Role of Women in the Freedom Struggle';
const C10 = 'Chapter 10: Colonial Rule and Tribal Society';
const C11 = 'Chapter 11: Communalism and the Freedom Movement';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Factors Behind British Ascendancy over Other European Powers in India', pageNumber: 3, tag: '' },
  { topicName: C1, questionText: '1.2 Strategies of the British East India Company to Expand Territorial Control', pageNumber: 3, tag: 'EIC Armies' },
  { topicName: C1, questionText: "1.3 The Marathas' Challenge to British Expansion and Reasons for their Failure", pageNumber: 4, tag: '' },
  { topicName: C1, questionText: "1.4 Lord Wellesley's Expansionist Policy – Factors and Methods", pageNumber: 5, tag: '' },

  { topicName: C2, questionText: '2.1 Causes and Consequences of the Decline of the Mughal Empire', pageNumber: 6, tag: 'Decline of Mughal Empire' },

  { topicName: C3, questionText: '3.1 Railways in Colonial India: Serving Imperial Interests and Fueling Nationalist Resistance', pageNumber: 7, tag: '' },
  { topicName: C3, questionText: '3.2 Decline of Traditional Artisanal Industry and its Impact on the Rural Economy', pageNumber: 7, tag: 'Artisanal Industry' },
  { topicName: C3, questionText: '3.3 Drain of Wealth Theory and British Economic Exploitation', pageNumber: 8, tag: 'Economic Policies' },
  { topicName: C3, questionText: '3.4 Commercialization of Agriculture – Impact on Agriculture and Society', pageNumber: 9, tag: '' },

  { topicName: C4, questionText: "4.1 Role of Ishwar Chandra Vidyasagar and Jyotiba Phule in Advocating Women's Rights", pageNumber: 10, tag: 'Social Reform' },

  { topicName: C5, questionText: '5.1 Causes of the Revolt of 1857 and Reasons for its Failure', pageNumber: 11, tag: '1857 Revolt' },
  { topicName: C5, questionText: '5.2 Revolt of 1857 – Factors and Impact on British Policy', pageNumber: 11, tag: '1857 Revolt' },

  { topicName: C6, questionText: '6.1 The Press as an Instrument of Nationalist Discourse During the Freedom Struggle', pageNumber: 13, tag: '' },
  { topicName: C6, questionText: "6.2 Long-Term Implications of Viceroy Curzon's Policies on the National Movement", pageNumber: 13, tag: 'Governor Generals' },
  { topicName: C6, questionText: '6.3 British Education Policy and the Rise of Indian Nationalism', pageNumber: 14, tag: '' },
  { topicName: C6, questionText: '6.4 Factors Behind the Development of National Identity and Nationalism in India', pageNumber: 14, tag: 'National Identity' },

  { topicName: C7, questionText: '7.1 Events Leading to the Quit India Movement and its Results', pageNumber: 16, tag: 'Quit India Movement' },
  { topicName: C7, questionText: '7.2 Differences Between the Civil Disobedience Movement and Non-Cooperation Movement', pageNumber: 16, tag: 'Freedom Struggle Stages' },
  { topicName: C7, questionText: '7.3 Impact of the Non-Cooperation Movement (1920-22)', pageNumber: 17, tag: 'Freedom Struggle Stages' },
  { topicName: C7, questionText: '7.4 INC Participation in 1937 Elections and Implications', pageNumber: 18, tag: '' },

  { topicName: C8, questionText: '8.1 Differing Approaches of Bhagat Singh and Mahatma Gandhi in the Freedom Struggle', pageNumber: 19, tag: 'Gandhi & Other Leaders' },
  { topicName: C8, questionText: '8.2 Contribution and Constraints of Revolutionaries in the Freedom Struggle', pageNumber: 19, tag: '' },
  { topicName: C8, questionText: '8.3 Indian Revolutionary Activities Abroad (Early 20th Century)', pageNumber: 20, tag: 'Revolutionary Activities Abroad' },

  { topicName: C9, questionText: '9.1 Contributions of Indian Women to the Independence Struggle', pageNumber: 21, tag: 'Women in Freedom Struggle' },
  { topicName: C9, questionText: "9.2 Women's Participation in India's Freedom Struggle", pageNumber: 21, tag: 'Women in Freedom Struggle' },

  { topicName: C10, questionText: '10.1 Impact of Colonial Rule on Tribals and the Tribal Response to Oppression', pageNumber: 23, tag: 'Tribal' },

  { topicName: C11, questionText: '11.1 Factors Deepening Communal Divisions in the 1930s-40s and their Consequences', pageNumber: 24, tag: 'Communal Divisions;Transfer of Power' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  // 02. Modern Indian History - mid-18th century to Present
  { questionText: 'The 1857 Uprising was the culmination the recurrent big and small local rebellions that had occurred in the preceding hundred years of British rule. Elucidate.', section: '1857 Revolt', year: 2019 },
  { questionText: 'Clarify how mid-eighteenth century India was beset with the spectre of a fragmented polity.', section: 'Decline of Mughal Empire', year: 2017 },
  { questionText: 'Explain how the Uprising of 1857 constitutes an important watershed in the evolution of British policies towards colonial India.', section: '1857 Revolt', year: 2016 },
  { questionText: 'In what ways did the naval mutiny prove to be the last nail in the coffin of British colonial aspirations in India?', section: C5, year: 2014 },
  { questionText: 'The third battle of Panipat was fought in 1761. Why were so many empire-shaking battles fought at Panipat?', section: 'Decline of Mughal Empire', year: 2014 },

  { questionText: 'Why did the armies of the British East India Company - mostly comprising of Indian soldiers-win consistently against the more numerous and better equipped armies of the then Indian rulers? Give reasons.', section: 'EIC Armies', year: 2022 },

  { questionText: 'Examine how the decline of traditional artisanal industry in colonial India crippled the rural economy.', section: 'Artisanal Industry', year: 2017 },
  { questionText: 'Examine critically the various facets of economic policies of the British in India from mid-eighteenth century till independence.', section: 'Economic Policies', year: 2014 },

  { questionText: 'Why was there a sudden spurt in famines in colonial India since the mid-eighteenth century? Give reasons.', section: C3, year: 2022 },

  { questionText: 'How did the colonial rule affect the tribals in India and what was the tribal response to the colonial oppression?', section: 'Tribal', year: 2023 },

  { questionText: 'Evaluate the policies of Lord Curzon and their long term implications on the national movement.', section: 'Governor Generals', year: 2020 },
  { questionText: 'In many ways, Lord Dalhousie was the founder of modern India. Elaborate.', section: C1, year: 2013 },

  { questionText: 'What was the difference between Mahatma Gandhi and Rabindranath Tagore in their approach towards education and nationalism?', section: 'Gandhi & Other Leaders', year: 2023 },
  { questionText: 'Throw light on the significance of the thoughts of Mahatma Gandhi in the present times.', section: 'Gandhi & Other Leaders', year: 2018 },
  { questionText: 'Highlight the differences in the approach of Subhash Chandra Bose and Mahatma Gandhi in the struggle for freedom.', section: 'Gandhi & Other Leaders', year: 2016 },
  { questionText: 'Mahatma Gandhi and Dr. B.R. Ambedkar, despite having divergent approaches and strategies, had a common goal of amelioration of the downtrodden. Elucidate.', section: 'Gandhi & Other Leaders', year: 2015 },
  { questionText: 'How different would have been the achievement of Indian independence without Mahatma Gandhi? Discuss.', section: 'Gandhi & Other Leaders', year: 2015 },

  { questionText: "Mahatma Jotirao Phule's writings and efforts of social reforms touched issues of almost all subaltern classes. Discuss.", section: 'Social Reform', year: 2025 },
  { questionText: 'Trace the rise and growth of socio-religious reform movements with special reference to Young Bengal and Brahmo Samaj.', section: 'Social Reform', year: 2021 },
  { questionText: "The women's questions arose in modern India as a part of the 19th century social reform movement. What were the major issues and debates concerning women in that period?", section: 'Social Reform', year: 2017 },

  // 03. Freedom Struggle - various stages, contributors
  { questionText: 'Several foreigners made India their homeland and participated in various movements. Analyze their role in the Indian struggle for freedom.', section: 'Revolutionary Activities Abroad', year: 2013 },

  { questionText: 'To what extent did the role of the Moderates prepare a base for the wider freedom movement? Comment.', section: C6, year: 2021 },
  { questionText: "Why did the 'Moderates' fail to carry conviction with the nation about their proclaimed ideology and political goals by the end of the nineteenth century?", section: C6, year: 2017 },

  { questionText: 'Discuss the role of women in the freedom struggle especially during the Gandhian phase.', section: 'Women in Freedom Struggle', year: 2016 },
  { questionText: 'Defying the barriers of age, gender and religion, the Indian women became the torch bearer during the struggle for freedom in India. Discuss.', section: 'Women in Freedom Struggle', year: 2013 },

  { questionText: 'It would have been difficult for the Constituent Assembly to complete its historic task of drafting the Constitution for Independent India in just three years but for the experience gained with the Government of India Act, 1935. Discuss.', section: C6, year: 2015 },

  { questionText: 'What were the events that led to the Quit India Movement? Point out its results.', section: 'Quit India Movement', year: 2024 },
  { questionText: 'Bring out the constructive programmes of Mahatma Gandhi during Non-Cooperation Movement and Civil Disobedience Movement.', section: 'Freedom Struggle Stages', year: 2021 },
  { questionText: 'Since the decade of the 1920s, the national movement acquired various ideological strands and thereby expanded its social base. Discuss.', section: 'Freedom Struggle Stages', year: 2020 },
  { questionText: 'Assess the role of British imperial power in complicating the process of transfer of power during the 1940s.', section: 'Communal Divisions;Transfer of Power', year: 2019 },
  { questionText: 'Many voices had strengthened and enriched the nationalist movement during the Gandhian phase. Elaborate.', section: C7, year: 2019 },
  { questionText: "Examine the linkages between 19th centuries 'Indian Renaissance' and the emergence of national identity.", section: 'National Identity', year: 2019 },
  { questionText: 'Highlight the importance of the new objectives that got added to the vision of Indian independence since twenties of the last century.', section: 'Freedom Struggle Stages', year: 2017 }
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

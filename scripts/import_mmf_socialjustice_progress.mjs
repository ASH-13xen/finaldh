// One-time import of Progress checklist + PYQ data for the "Mains Master File-Social Justice"
// file inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-9) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society imports. `tag` on each sub-heading is a short clean keyword for precise PYQ
// matching; PYQs with no dedicated sub-heading in this index (most of the "welfare schemes for
// vulnerable sections" and generic Human Resources PYQs, which read as broad social-sector
// commentary rather than matching one specific topic) fall back to Chapter 9 (Welfare Delivery,
// Inclusion and Demography) or the nearest relevant chapter.
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
const TARGET_FILE_NAME = 'Mains Master File-Social Justice';

const C1 = 'Chapter 1: Poverty and Vulnerability';
const C2 = 'Chapter 2: Hunger and Nutrition';
const C3 = 'Chapter 3: Healthcare System';
const C4 = 'Chapter 4: Mental Health and Disability';
const C5 = 'Chapter 5: Vulnerable Sections: Transgender and Tribals';
const C6 = 'Chapter 6: Child Labour';
const C7 = 'Chapter 7: Education';
const C8 = 'Chapter 8: Skill Development and Employment';
const C9 = 'Chapter 9: Welfare Delivery, Inclusion and Demography';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Poverty as a Multidimensional Issue Beyond Income', pageNumber: 3, tag: 'Multidimensional Poverty' },
  { topicName: C1, questionText: '1.2 Multidimensional Approach to Poverty', pageNumber: 3, tag: 'Multidimensional Poverty' },
  { topicName: C1, questionText: '1.3 Multidimensional Vulnerability Index (MVI) – Healthcare and Poverty Prevention', pageNumber: 5, tag: '' },

  { topicName: C2, questionText: '2.1 Poverty–Malnutrition Vicious Cycle and Human Capital', pageNumber: 6, tag: 'Poverty-Malnutrition Cycle' },
  { topicName: C2, questionText: "2.2 India's Hunger Paradox: Growth Amid Food Insecurity", pageNumber: 7, tag: 'Hunger' },
  { topicName: C2, questionText: '2.3 Hidden Hunger (Micronutrient Deficiency)', pageNumber: 8, tag: '' },
  { topicName: C2, questionText: '2.4 Nutrition – Integrating with Agriculture and Economic Planning', pageNumber: 10, tag: '' },

  { topicName: C3, questionText: "3.1 Challenges Confronting India's Primary Healthcare System", pageNumber: 11, tag: 'Primary Healthcare' },
  { topicName: C3, questionText: "3.2 India's Public Healthcare System – Issues and Initiatives", pageNumber: 12, tag: 'Public Healthcare' },
  { topicName: C3, questionText: '3.3 Marketisation of Public Healthcare and the Role of the State', pageNumber: 14, tag: 'Marketisation of Healthcare' },
  { topicName: C3, questionText: "3.4 'One Health' Approach – Structural and Regulatory Hurdles", pageNumber: 15, tag: '' },

  { topicName: C4, questionText: '4.1 Mental Healthcare Act 2017 – Structural and Administrative Bottlenecks', pageNumber: 16, tag: '' },
  { topicName: C4, questionText: '4.2 Rising Mental Health Issues in India: Reasons and Measures', pageNumber: 17, tag: '' },
  { topicName: C4, questionText: '4.3 Disability as a Social Challenge: Government Response', pageNumber: 18, tag: 'Disability' },

  { topicName: C5, questionText: '5.1 Transgender Persons (Protection of Rights) Act, 2019', pageNumber: 19, tag: '' },
  { topicName: C5, questionText: '5.2 Challenges Faced by Tribals and Government Measures', pageNumber: 20, tag: 'Tribals' },
  { topicName: C5, questionText: '5.3 Tribal Development – Displacement and Rehabilitation', pageNumber: 21, tag: 'Tribals' },
  { topicName: C5, questionText: '5.4 Scheduled Tribes: Recognition and Constitutional Safeguards', pageNumber: 22, tag: 'Tribals' },

  { topicName: C6, questionText: '6.1 Reasons for Persistence of Child Labour in India', pageNumber: 23, tag: '' },
  { topicName: C6, questionText: '6.2 Child Labour – Causes and Poverty Cycle', pageNumber: 24, tag: '' },

  { topicName: C7, questionText: '7.1 Barriers to Education Access and Enrolment', pageNumber: 25, tag: 'Education Access' },
  { topicName: C7, questionText: '7.2 NEP 2020 – School Education and Medium of Instruction', pageNumber: 26, tag: 'NEP 2020' },
  { topicName: C7, questionText: '7.3 Foreign Higher Educational Institutions (FHEIs) in India', pageNumber: 27, tag: 'Foreign Educational Institutions' },
  { topicName: C7, questionText: '7.4 AI in Education – Equity, Access and Quality', pageNumber: 27, tag: '' },
  { topicName: C7, questionText: '7.5 Digital Education – Challenges to Inclusion and Equity', pageNumber: 28, tag: '' },

  { topicName: C8, questionText: '8.1 Skill India Mission: Bridging the Employability Gap', pageNumber: 30, tag: 'Skill Development' },
  { topicName: C8, questionText: '8.2 Lack of Skill Development in the Indian Workforce', pageNumber: 31, tag: 'Skill Development' },

  { topicName: C9, questionText: '9.1 Universal Basic Income (UBI): Viability in India', pageNumber: 33, tag: '' },
  { topicName: C9, questionText: "9.2 India's Demographic Paradox – Social and Policy Challenges", pageNumber: 34, tag: 'Demographic Dividend' },
  { topicName: C9, questionText: '9.3 Key Challenges to Achieving Inclusive Growth in India', pageNumber: 34, tag: 'Inclusive Growth' },
  { topicName: C9, questionText: '9.4 Unconditional Cash Transfers to Women – Drivers and Impact', pageNumber: 35, tag: '' },
  { topicName: C9, questionText: '9.5 NAMASTE Scheme – Safety and Dignity of Sanitation Workers', pageNumber: 36, tag: '' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  // 12. Welfare schemes for vulnerable sections
  { questionText: 'Examine the main provisions of the National Child Policy and throw light on the status of its implementation.', section: C9, year: 2016 },

  { questionText: 'The Rights of Persons with Disabilities Act, 2016 remains only a legal document without intense sensitisation of government functionaries and citizens regarding disability. Comment.', section: 'Disability', year: 2022 },
  { questionText: 'Does the Rights of Persons with Disabilities Act, 2016 ensure effective mechanism for empowerment and inclusion of the intended beneficiaries in the society? Discuss', section: 'Disability', year: 2017 },

  { questionText: '"Development and welfare schemes for the vulnerable, by its nature, are discriminatory in approach." Do you agree? Give reasons for your answer.', section: C9, year: 2023 },
  { questionText: 'Performance of welfare schemes that are implemented for vulnerable sections is not so effective due to absence of their awareness and active involvement at all stages of policy process – Discuss.', section: C9, year: 2019 },
  { questionText: "Do government's schemes for up-lifting vulnerable and backward communities by protecting required social resources for them, lead to their exclusion in establishing businesses in urban economics?", section: C9, year: 2014 },
  { questionText: 'The Central Government frequently complains on the poor performance of the State Governments in eradicating suffering of the vulnerable sections of the society. Restructuring of Centrally sponsored schemes across the sectors for ameliorating the cause of vulnerable sections of population aims at providing flexibility to the States in better implementation. Critically evaluate.', section: C9, year: 2013 },

  { questionText: "Women's social capital complements in advancing empowerment and gender equity. Explain.", section: C9, year: 2025 },
  { questionText: '"Though women in post-Independent India have excelled in various fields, the social attitude towards women and feminist movement has been patriarchial." Apart from women education and women empowerment schemes, what interventions can help change this milieu?', section: C9, year: 2021 },

  // 13. Health, Education, Human Resources
  { questionText: "The Right of Children to Free and Compulsory Education Act, 2009 remains inadequate in promoting incentive-based system for children's education without generating awareness about the importance of schooling. Analyse.", section: 'Education Access', year: 2022 },
  { questionText: "'Earn while you learn' scheme needs to be strengthened to make vocational education and skill training meaningful.\" Comment.", section: 'Skill Development', year: 2021 },
  { questionText: 'National Education Policy 2020 is in conformity with the Sustainable Development Goal-4. It intends to restructure and reorient education system in India. Critically examine the statement.', section: 'NEP 2020', year: 2020 },
  { questionText: 'The quality of higher education in India requires major improvements to make it internationally competitive. Do you think that the entry of foreign educational institutions would help improve the quality of higher and technical education in the country? Discuss.', section: 'Foreign Educational Institutions', year: 2015 },
  { questionText: 'Should the premier institutes like IITs/IIMs be allowed to retain premier status, allowed more academic independence in designing courses and also decide mode/criteria of selection of students. Discuss in light of the growing challenges.', section: C7, year: 2014 },

  { questionText: 'In a crucial domain like the public healthcare system, the Indian State should play a vital role to contain the adverse impact of marketisation of the system. Suggest some measures through which the State can enhance the reach of public healthcare at the grassroots level.', section: 'Marketisation of Healthcare', year: 2024 },
  { questionText: '"Besides being a moral imperative of a Welfare State, primary health structure is a necessary precondition for sustainable development." Analyse.', section: 'Primary Healthcare', year: 2021 },
  { questionText: 'In order to enhance the prospects of social development, sound and adequate health care policies are needed particularly in the fields of geriatric and maternal health care. Discuss.', section: 'Public Healthcare', year: 2020 },
  { questionText: "Appropriate local community-level healthcare intervention is a prerequisite to achieve 'Health for All' in India. Explain.", section: 'Primary Healthcare', year: 2018 },
  { questionText: "'To ensure effective implementation of policies addressing water, sanitation and hygiene needs, the identification of beneficiary segments is to be synchronized with the anticipated outcomes' Examine the statement in the context of the WASH scheme.", section: C3, year: 2017 },
  { questionText: 'Public health system has limitations in providing universal health coverage. Do you think that the private sector could help in bridging the gap? What other viable alternatives would you suggest?', section: 'Public Healthcare', year: 2015 },
  { questionText: 'Identify the Millennium Development Goals (MDGs) that are related to health. Discuss the success of the actions taken by the Government for achieving the same.', section: C3, year: 2013 },

  { questionText: 'Skill development programs have succeed in increasing human resources supply to various sectors. In the context of the statement analyze the linkages between education, skill and employment.', section: 'Skill Development', year: 2023 },
  { questionText: 'The crucial aspect of development process has been the inadequate attention paid to Human Resource Development in India. Suggest measures that can address this adequacy.', section: 'Skill Development', year: 2023 },
  { questionText: 'Despite Consistent experience of High growth, India still goes with the lowest indicators of human development. Examine the issues that make balanced and inclusive development elusive.', section: 'Inclusive Growth', year: 2019 },
  { questionText: 'Professor Amartya Sen has advocated important reforms in the realms of primary education and primary health care. What are your suggestions to improve their status and performance?', section: C9, year: 2016 },
  { questionText: 'Demographic Dividend in India will remain only theoretical unless our manpower becomes more educated, aware, skilled and creative. What measures have been taken by the government to enhance the capacity of our population to be more productive and employable?', section: 'Demographic Dividend', year: 2016 },
  { questionText: "An athlete participates in Olympics for personal triumph and nation's glory; victors are showered with cash incentives by various agencies, on their return. Discuss the merit of state sponsored talent hunt and its cultivation as against the rationale of a reward mechanism as encouragement.", section: C9, year: 2014 },

  // 14. Poverty and hunger
  { questionText: 'There is a growing divergence in the relationship between poverty and hunger in India. The shrinking of social expenditure by the government is forcing the poor to spend more on Non-Food essential items squeezing their food – budget. Elucidate.', section: 'Hunger', year: 2019 },
  { questionText: 'How far do you agree with the view that the focus on lack of availability of food as the main cause of hunger takes the attention away from ineffective human development policies in India?', section: 'Hunger', year: 2018 },
  { questionText: 'The concept of Mid Day Meal (MDM) scheme is almost a century old in India with early beginnings in Madras Presidency in pre-independent India. The scheme has again been given impetus in most states in the last two decades. Critically examine its twin objectives, latest mandates and success.', section: C2, year: 2013 },

  { questionText: "Inequality in the ownership pattern of resources is one of the major causes of poverty. Discuss in the context of 'paradox of poverty'.", section: 'Multidimensional Poverty', year: 2025 },
  { questionText: 'Poverty and malnutrition create a vicious cycle, adversely affecting human capital formation. What steps can be taken to break the cycle?', section: 'Poverty-Malnutrition Cycle', year: 2024 },
  { questionText: 'Besides the welfare schemes, India needs deft management of inflation and unemployment to serve the poor and the underprivileged sections of the society. Discuss.', section: C1, year: 2022 },
  { questionText: '"The incidence and intensity of poverty are more important in determining poverty based on income alone". In this context analyse the latest United Nations Multidimensional Poverty Index Report.', section: 'Multidimensional Poverty', year: 2020 },
  { questionText: 'Hunger and Poverty are the biggest challenges for good governance in India still today. Evaluate how far successive governments have progressed in dealing with these humongous problems. Suggest measures for improvement.', section: C1, year: 2017 },
  { questionText: "'Poverty Alleviation Programmes in India remain mere show pieces until and unless they are backed by political will'. Discuss with reference to the performance of the major poverty alleviation programmes in India.", section: C1, year: 2017 },
  { questionText: 'Though there have been several different estimates of poverty in India, all indicate reduction in poverty levels over time. Do you agree? Critically examine with reference to urban and rural poverty indicators.', section: C1, year: 2015 }
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

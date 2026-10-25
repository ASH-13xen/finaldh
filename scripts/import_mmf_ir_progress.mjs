// One-time import of Progress checklist + PYQ data for the "MMF - International Relations"
// file inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS',
// fileIndex resolved by name below) - same course+fileIndex-scoped approach as
// import_psir_progress_csvs.mjs / import_psir_pyqs.mjs, just inlined (single subject, no
// per-paper CSV split) since the source is a hand-typed chapter index + classified PYQ list.
//
// IMPORTANT: the MMF course's `subject` field ("All GS") is shared across all 18 MMF
// subject-PDFs, so PYQs here are inserted directly scoped to (course, fileIndex) rather than
// via uploadProgressPyqsCsv's subject-scoped replace-all (which would wipe every other MMF
// subject's PYQs).
//
// Not blindly rerunnable: uses upsertTopicsAndQuestions (additive/upsert) for the checklist,
// and a delete+reinsert for PYQs. Guarded with existing-data checks that skip unless --force.
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
const TARGET_FILE_NAME = 'MMF - International Relations';

const C1 = "Chapter 1: Foundations & Doctrines of India's Foreign Policy";
const C2 = 'Chapter 2: India and its Neighbourhood';
const C3 = 'Chapter 3: Regional & Global Groupings and Agreements';
const C4 = 'Chapter 4: Global South, Africa & Developed-Developing Country Dynamics';
const C5 = 'Chapter 5: International Institutions and the Indian Diaspora';

// ================= Checklist: chapters (Topic) + numbered sub-headings (ProgressQuestion) =================
// tag values are free keywords used purely for PYQ matching (see tagMatcher.js) - not shown
// to students distinctly from the Topic name, but let a PYQ surface against the *specific*
// sub-heading a student checked off rather than only the whole chapter.
const CHECKLIST_ROWS = [
  { topicName: C1, questionText: "1.1 Core Objectives of India's Foreign Policy", pageNumber: 2, tag: '' },
  { topicName: C1, questionText: '1.2 Gujral Doctrine – Contemporary Relevance', pageNumber: 3, tag: 'Gujral Doctrine' },
  { topicName: C1, questionText: "1.3 'Neighbourhood First' Policy – Features & Challenges", pageNumber: 3, tag: 'Neighbourhood First Policy' },
  { topicName: C1, questionText: "1.4 India's Soft Power – Key Attributes", pageNumber: 5, tag: 'Soft Power' },

  { topicName: C2, questionText: '2.1 Renewal of the Ganga Water Treaty 2026: Challenges Amid Shifting Dhaka Politics', pageNumber: 7, tag: 'Ganga Water Treaty;Bangladesh' },
  { topicName: C2, questionText: '2.2 India-Sri Lanka Relations: Strengthened Ties and Longstanding Concerns', pageNumber: 7, tag: 'Sri Lanka' },
  { topicName: C2, questionText: "2.3 Strategic Significance of Bhutan in India's Himalayan Security Architecture", pageNumber: 8, tag: 'Bhutan' },
  { topicName: C2, questionText: '2.4 Current Trends in India-Bangladesh Relations and a Policy Framework to Stabilise Cooperation', pageNumber: 9, tag: 'Bangladesh' },
  { topicName: C2, questionText: "2.5 Bangladesh – Key Pillar of Neighbourhood First Policy & 'Sonali Adhyay' at Risk", pageNumber: 10, tag: 'Bangladesh' },

  { topicName: C3, questionText: "3.1 India-France Partnership: 'Partnership for the Planet and the People'", pageNumber: 12, tag: 'France' },
  { topicName: C3, questionText: "3.2 Strategic Importance of Malaysia for India's Economic and Security Interests", pageNumber: 12, tag: 'Malaysia' },
  { topicName: C3, questionText: "3.3 India-EU FTA as a Strategic Breakthrough in India's Global Trade Engagement", pageNumber: 13, tag: 'EU FTA' },
  { topicName: C3, questionText: "3.4 BRICS Expansion: India's Dual Challenge as Bridge-Builder Between West and Global South", pageNumber: 14, tag: 'BRICS' },
  { topicName: C3, questionText: "3.5 SCO as 'Alliance of the East': How India Addresses Security Concerns Despite Adversaries", pageNumber: 15, tag: 'SCO' },
  { topicName: C3, questionText: "3.6 AUKUS vs. Quad: Comparative Relevance for India's Indo-Pacific Strategy", pageNumber: 17, tag: 'AUKUS;Quad' },
  { topicName: C3, questionText: '3.7 BIMSTEC – Aims, Objectives & Importance for India', pageNumber: 18, tag: 'BIMSTEC;SAARC' },
  { topicName: C3, questionText: "3.8 ASEAN as Cornerstone of India's Act East Policy & Indo-Pacific Vision", pageNumber: 19, tag: 'ASEAN;Look East Policy;Act East Policy' },
  { topicName: C3, questionText: '3.9 BRICS and Quad – Different Priorities, Shared Salience for India', pageNumber: 20, tag: 'BRICS;Quad' },
  { topicName: C3, questionText: "3.10 India's Relations with Central Asian Republics (CARs)", pageNumber: 20, tag: 'Central Asian Republics' },
  { topicName: C3, questionText: '3.11 India-Russia: Resilience Amid Geopolitical Challenges', pageNumber: 21, tag: 'Russia' },
  { topicName: C3, questionText: '3.12 India as an Alternative Defence Partner for Southeast Asia: Opportunities and Limitations', pageNumber: 22, tag: '' },
  { topicName: C3, questionText: '3.13 Growing Salience of the Indo-Pacific', pageNumber: 23, tag: 'Indo-Pacific' },

  { topicName: C4, questionText: "4.1 Protectionism in Developed Countries: Impact on India's Export Competitiveness", pageNumber: 25, tag: '' },
  { topicName: C4, questionText: "4.2 US-Iran Confrontation Risk: Implications for India's Energy Security and Hydrocarbon Supply Chain Measures", pageNumber: 26, tag: 'US-Iran;Energy Security' },
  { topicName: C4, questionText: "4.3 Tariffs & Trade Barriers: Impact on India's S&T Enterprise", pageNumber: 27, tag: '' },
  { topicName: C4, questionText: '4.4 West Fostering India as Alternative to China', pageNumber: 27, tag: 'West Fostering India;China' },
  { topicName: C4, questionText: "4.5 Africa's Role in India's Global South Strategy and Impediments to Strategic Partnership", pageNumber: 28, tag: 'Africa' },
  { topicName: C4, questionText: "4.6 Africa in India's Foreign Policy", pageNumber: 29, tag: 'Africa' },
  { topicName: C4, questionText: "4.7 Board of Peace for Gaza: Implications for Global Rules-Based Order and India's Foreign Policy", pageNumber: 30, tag: 'Gaza' },

  { topicName: C5, questionText: '5.1 UNHCR Mandate and Its Role in Strengthening the Global Refugee Protection Regime', pageNumber: 32, tag: 'UNHCR' },
  { topicName: C5, questionText: "5.2 IMF's Democratic Deficit and India's Push for Urgent Governance Reforms", pageNumber: 33, tag: 'IMF;World Bank' },
  { topicName: C5, questionText: "5.3 UNSC's Reflection of Contemporary Global Power Realities and Required Reforms", pageNumber: 34, tag: 'UNSC' },
  { topicName: C5, questionText: '5.4 WHO Funding Mechanisms & Global Health Priorities', pageNumber: 35, tag: 'WHO' },
  { topicName: C5, questionText: '5.5 Government Initiatives to Engage and Empower the Indian Diaspora', pageNumber: 36, tag: 'Indian Diaspora' },
  { topicName: C5, questionText: "5.6 Indian Diaspora as a 'Living Bridge' Strengthening India's Soft Power Abroad", pageNumber: 36, tag: 'Indian Diaspora' },
  { topicName: C5, questionText: '5.7 Indian Diaspora in the Gulf – Opportunities & Challenges', pageNumber: 37, tag: 'Indian Diaspora' },
  { topicName: C5, questionText: '5.8 Indian Diaspora – Significance & Government Initiatives', pageNumber: 38, tag: 'Indian Diaspora' }
];

// ================= PYQs, classified against the checklist above =================
// `section` is either an exact chapter name (broad fallback - matches any sub-heading in that
// chapter once the student checks one off) or a keyword that equals one of the semicolon-split
// `tag` values above (precise match to that one sub-heading). Sourced from the GS-2 Mains
// syllabus items 17-20 PYQ compilation the user provided; classified by topical fit against the
// MMF - IR chapter index, not strictly by which syllabus-numbered bucket each PYQ was filed
// under originally.
const PYQ_ROWS = [
  // Syllabus 17: India and its neighbourhood
  { questionText: 'Discuss the political developments in Maldives in the last two years. Should they be of any cause of concern to India?', section: C2, year: 2013 },
  { questionText: "India is an age-old friend of Sri Lanka.' Discuss India's role in the recent crisis in Sri Lanka in the light of the preceding statement.", section: 'Sri Lanka', year: 2022 },
  { questionText: 'Terrorist activities and mutual distrust have clouded India-Pakistan relations. To what extent the use of soft power like sports and cultural exchanges could help generate goodwill between the two countries? Discuss with suitable examples.', section: 'Soft Power', year: 2015 },
  { questionText: "Project 'Mausam' is considered a unique foreign policy initiative of the Indian Government to improve relationship with its neighbors. Does the project have a strategic dimension? Discuss.", section: C2, year: 2015 },
  { questionText: 'The protests in Shahbag Square in Dhaka in Bangladesh reveal a fundamental split in society between the nationalists and Islamic forces. What is its significance for India?', section: 'Bangladesh', year: 2013 },
  { questionText: 'In respect of India-Sri Lanka relations, discuss how domestic factors influence foreign policy.', section: 'Sri Lanka', year: 2013 },
  { questionText: 'What is meant by Gujral doctrine? Does it have any relevance today? Discuss.', section: 'Gujral Doctrine', year: 2013 },

  // Syllabus 18: Bilateral, regional and global groupings and agreements
  { questionText: 'India–Africa digital partnership is achieving mutual respect, co-development and long-term institutional partnerships. Elaborate.', section: 'Africa', year: 2025 },
  { questionText: "Discuss the geopolitical and geostrategic importance of Maldives for India with a focus on global trade and energy flows. Further also discuss how this relationship affects India's maritime security and regional stability amidst international competition?", section: C3, year: 2024 },
  { questionText: 'What is the significance of Indo-US defence deals over Indo-Russian defence deals? Discuss with reference to stability in the Indo-Pacific region.', section: 'Russia', year: 2020 },
  { questionText: "'The time has come for India and Japan to build a strong contemporary relationship, one involving global and strategic partnership that will have a great significance for Asia and the world as a whole.' Comment.", section: C3, year: 2019 },
  { questionText: "What introduces friction into the ties between India and the United States is that Washington is still unable to find for India a position in its global strategy, which would satisfy India's National self-esteem and ambitions. Explain with suitable examples.", section: C3, year: 2019 },
  { questionText: "India's relations with Israel have, of late, acquired a depth and diversity, which cannot be rolled back. Discuss.", section: C3, year: 2018 },
  { questionText: 'Increasing interest of India in Africa has its pros and cons. Critically examine.', section: 'Africa', year: 2015 },
  { questionText: 'With respect to the South China sea, maritime territorial disputes and rising tension affirm the need for safeguarding maritime security to ensure freedom of navigation and over flight throughout the region. In this context, discuss the bilateral issues between India and China.', section: C3, year: 2014 },
  { questionText: 'Economic ties between India and Japan, while growing in recent years, are still far below their potential. Elucidate the policy constraints which are inhibiting this growth.', section: C3, year: 2013 },

  { questionText: "Critically analyse India's evolving diplomatic, economic and strategic relations with the Central Asian Republics (CARs) highlighting their increasing significance in regional and global geopolitics.", section: 'Central Asian Republics', year: 2024 },
  { questionText: "'Virus of Conflict is affecting the functioning of the SCO'. In the light of the above statement point out the role of India in mitigating problems.", section: 'SCO', year: 2023 },
  { questionText: 'Do you think that BIMSTEC is a parallel organisation like the SAARC? What are the similarities and dissimilarities between the two? How are Indian foreign policy objectives realized by forming this new organisation?', section: 'BIMSTEC', year: 2022 },
  { questionText: 'Critically examine the aims and objectives of SCO. What importance does it hold for India?', section: 'SCO', year: 2021 },
  { questionText: "Evaluate the economic and strategic dimensions of India's Look East Policy in the context of the post-Cold War international scenario.", section: 'Look East Policy', year: 2016 },
  { questionText: 'Increasing cross-border terrorist attacks in India and growing interference in the internal affairs of several member-states by Pakistan are not conducive for the future of SAARC (South Asian Association for Regional Cooperation). Explain with suitable examples.', section: 'SAARC', year: 2016 },

  { questionText: 'How will I2U2 (India, Israel, UAE and USA) grouping transform India\'s position in global politics?', section: C3, year: 2022 },
  { questionText: "'If the last few decades were of Asia's growth story, the next few are expected to be of Africa's.' In the light of this statement, examine India's influence in Africa in recent years.", section: 'Africa', year: 2021 },
  { questionText: "The newly tri-nation partnership AUKUS is aimed at countering China's ambitions in the Indo-Pacific region. Is it going to supersede the existing partnerships in the region? Discuss the strength and impact of AUKUS in the present scenario.", section: 'AUKUS', year: 2021 },
  { questionText: "'Quadrilateral Security Dialogue (Quad)' is transforming itself into a trade bloc from a military alliance, in present times - Discuss.", section: 'Quad', year: 2020 },

  // Syllabus 19: Effect of policies of developed/developing countries on India's interests, diaspora
  { questionText: "Energy security constitutes the dominant kingpin of India's foreign policy, and is linked with India's overarching influence in Middle Eastern countries. How would you integrate energy security with India's foreign policy trajectories in the coming years?", section: 'Energy Security', year: 2025 },
  { questionText: "Clean energy is the order of the day. Describe briefly India's changing policy towards climate change in various international fora in the context of geopolitics.", section: 'Energy Security', year: 2022 },
  { questionText: "The question of India's Energy Security constitutes the most important part of India's economic progress. Analyze India's energy policy cooperation with West Asian Countries.", section: 'Energy Security', year: 2017 },

  { questionText: 'With the waning of globalization, post-Cold War world is becoming a site of sovereign nationalism. Elucidate.', section: C4, year: 2025 },
  { questionText: "The West is fostering India as an alternative to reduce dependence on China's supply chain and as a strategic ally to counter China's political and economic dominance.' Explain this statement with examples.", section: 'West Fostering India', year: 2024 },
  { questionText: "'The long-sustained image of India as a leader of the oppressed and marginalised Nations has disappeared on account of its new found role in the emerging global order'. Elaborate.", section: C4, year: 2019 },
  { questionText: "A number of outside powers have entrenched themselves in Central Asia, which is a zone of interest to India. Discuss the implications, in this context, of India's joining the Ashgabat Agreement, 2018.", section: 'Central Asian Republics', year: 2018 },
  { questionText: 'In what ways would the ongoing US-Iran Nuclear Pact Controversy affect the national interest of India? How should India respond to this situation?', section: 'US-Iran', year: 2018 },
  { questionText: "'China is using its economic relations and positive trade surplus as tools to develop potential military power status in Asia', In the light of this statement, discuss its impact on India as her neighbor.", section: 'China', year: 2017 },
  { questionText: 'The proposed withdrawal of International Security Assistance Force (ISAF) from Afghanistan in 2014 is fraught with major security implications for the countries of the region. Examine in light of the fact that India is faced with a plethora of challenges and needs to safeguard its own strategic interests.', section: C4, year: 2013 },

  { questionText: "What do you understand by 'The String of Pearls'? How does it impact India? Briefly outline the steps taken by India to counter this.", section: C4, year: 2013 },

  { questionText: "'The expansion and strengthening of NATO and a stronger US-Europe strategic partnership works well in India.' What is your opinion about this statement? Give reasons and examples to support your answer.", section: C3, year: 2023 },

  { questionText: 'Indian diaspora has scaled new heights in the West. Describe its economic and political benefits for India.', section: 'Indian Diaspora', year: 2023 },
  { questionText: "'Indian diaspora has a decisive role to play in the politics and economy of America and European Countries'. Comment with examples.", section: 'Indian Diaspora', year: 2020 },
  { questionText: "Indian Diaspora has an important role to play in South-East Asian countries' economy and society. Appraise the role of Indian Diaspora in South-East Asia in this context.", section: 'Indian Diaspora', year: 2017 },

  { questionText: "'The USA is facing an existential threat in the form of a China, that is much more challenging than the erstwhile Soviet Union.' Explain.", section: C4, year: 2021 },

  // Syllabus 20: International institutions, agencies and fora
  { questionText: "'The reform process in the United Nations remains unresolved, because of the delicate imbalance of East and West and entanglement of the USA vs. Russo-Chinese alliance.' Examine and critically evaluate the East-West policy confrontations in this regard.", section: 'UNSC', year: 2025 },
  { questionText: "Terrorism has become a significant threat to global peace and security'. Evaluate the effectiveness of the United Nations Security Council's Counter-Terrorism Committee (CTC) and its associated bodies in addressing and mitigating this threat at the international level.", section: 'UNSC', year: 2024 },
  { questionText: "'Sea is an important Component of the Cosmos'. Discuss in the light of the above statement the role of the IMO (International Maritime Organisation) in protecting environment and enhancing maritime safety and security.", section: C5, year: 2023 },
  { questionText: 'Critically examine the role of WHO in providing global health security during the Covid-19 pandemic.', section: 'WHO', year: 2020 },
  { questionText: "'Too little cash, too much politics, leaves UNESCO fighting for life.' Discuss the statement in the light of US' withdrawal and its accusation of the cultural body as being 'anti-Israel bias'.", section: C5, year: 2019 },
  { questionText: 'What are the main functions of the United Nations Economic and Social Council (ECOSOC)? Explain different functional commissions attached to it.', section: C5, year: 2017 },
  { questionText: "What are the aims and objectives of the McBride Commission of the UNESCO? What is India's position on these?", section: C5, year: 2016 },
  { questionText: 'Discuss the impediments India is facing in its pursuit of a permanent seat in UN Security Council.', section: 'UNSC', year: 2015 },

  { questionText: 'India has recently signed to become founding a New Development Bank (NDB) and also the Asian Infrastructure Investment Bank (AIIB). How will the role of the two Banks be different? Discuss the significance of these two Banks for India.', section: C5, year: 2014 },
  { questionText: 'Some of the International funding agencies have special terms for economic participation stipulating a substantial component of the aid to be used for sourcing equipment from the leading countries. Discuss on merits of such terms and if, there exists a strong case not to accept such conditions in the Indian context.', section: C5, year: 2014 },
  { questionText: 'The World Bank and the IMF, collectively known as the Bretton Woods Institutions, are the two inter-governmental pillars supporting the structure of the world\'s economic and financial order. Superficially, the World Bank and the IMF exhibit many common characteristics, yet their role, functions and mandate are distinctly different. Elucidate.', section: 'IMF', year: 2013 },

  { questionText: "What are the key areas of reform if the WTO has to survive in the present context of 'Trade War', especially keeping in mind the interest of India?", section: C5, year: 2018 },
  { questionText: 'The broader aims and objectives of WTO are to manage and promote international trade in the era of globalization. But the Doha round of negotiations seem doomed due to differences between the developed and the developing countries. Discuss in the Indian perspective.', section: C5, year: 2016 },
  { questionText: 'The aim of Information Technology Agreements (ITAs) is to lower all taxes and tariffs on information technology products by signatories to zero. What impact should such agreements have on India\'s interests?', section: C5, year: 2014 },
  { questionText: 'WTO is an important international institution where decisions taken affect countries in profound manner. What is the mandate of WTO and how binding are their decisions? Critically analyse India\'s stand on the latest round of talks on Food security.', section: C5, year: 2014 }
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

  // ---- Checklist (Topics + ProgressQuestions) ----
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

  // ---- PYQs ----
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

  // ---- Enable progress tracking on the MMF course (shows the card + unlocks the file picker) ----
  if (!course.progressEnabled) {
    course.progressEnabled = true;
    await course.save();
    console.log('Enabled progressEnabled on the MMF course.');
  } else {
    console.log('progressEnabled was already true on the MMF course.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

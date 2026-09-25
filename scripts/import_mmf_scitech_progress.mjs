// One-time import of Progress checklist + PYQ data for the "MMF - Science and Tech" file inside
// the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-11) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Governance imports. `tag` on each sub-heading is a short clean keyword for
// precise PYQ matching. Older/classic-syllabus PYQs with no dedicated sub-heading in this
// current-affairs-driven book (digital signatures, 3D printing, cricket DRS, FRP composites,
// electronic toll collection, Bose-Einstein statistics, S-400, cloud hosting security, Novartis/
// Glivec patent case, robotics-for-labour) fall back to the closest relevant chapter.
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
const TARGET_FILE_NAME = 'MMF - Science and Tech';

const C1 = 'Chapter 1: Space Technology';
const C2 = 'Chapter 2: Nuclear Technology & Energy';
const C3 = 'Chapter 3: Defence Technology';
const C4 = 'Chapter 4: Biotechnology';
const C5 = 'Chapter 5: Health & Medical Technology';
const C6 = 'Chapter 6: Emerging IT & Digital Technologies';
const C7 = 'Chapter 7: Nanotechnology';
const C8 = 'Chapter 8: Environment & Energy Technology';
const C9 = 'Chapter 9: Intellectual Property Rights';
const C10 = 'Chapter 10: Science & Technology Policy & Institutions';
const C11 = 'Chapter 11: Eminent Scientists & Institution Builders';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: "1.1 India's Space Technology & Socio-Economic Development", pageNumber: 3, tag: 'Space Programs x IND' },
  { topicName: C1, questionText: '1.2 Gaganyaan Mission: Tangible & Intangible Benefits', pageNumber: 3, tag: 'Space Programs x IND' },
  { topicName: C1, questionText: '1.3 Role of ISRO in National Development', pageNumber: 4, tag: 'Space Programs x IND' },

  { topicName: C2, questionText: '2.1 Small Modular Reactors (SMRs): Clean Energy & Climate Goals', pageNumber: 6, tag: 'Nuclear Energy' },

  { topicName: C3, questionText: '3.1 Indigenising the Defence Sector: Challenges & Government Initiatives', pageNumber: 7, tag: 'Defence' },
  { topicName: C3, questionText: '3.2 Defence Indigenisation under Atmanirbhar Bharat: Achievements & Bottlenecks', pageNumber: 7, tag: 'Defence' },
  { topicName: C3, questionText: '3.3 Private Sector in Defence: Opportunities & Challenges', pageNumber: 8, tag: 'Defence' },
  { topicName: C3, questionText: '3.4 IGMDP: Developmental Milestones & Evolution of Aerial Warfare', pageNumber: 9, tag: 'Defence' },
  { topicName: C3, questionText: '3.5 Scramjet Engine: Working Principle & Strategic Significance', pageNumber: 10, tag: '' },
  { topicName: C3, questionText: "3.6 India's Potential as a Global Drone Manufacturing Hub", pageNumber: 10, tag: '' },

  { topicName: C4, questionText: '4.1 BioE3 Policy: Strengthening the Biomanufacturing Ecosystem', pageNumber: 12, tag: 'Biotechnology' },
  { topicName: C4, questionText: '4.2 Bio-RIDE Scheme: Research, Innovation & Entrepreneurship', pageNumber: 12, tag: 'Biotechnology' },
  { topicName: C4, questionText: '4.3 Gene Therapy: Mechanism, Advantages & Risks', pageNumber: 13, tag: 'Biotechnology' },
  { topicName: C4, questionText: '4.4 mRNA Vaccines: Principle & Non-Communicable Disease Applications', pageNumber: 14, tag: 'Vaccines' },
  { topicName: C4, questionText: '4.5 Genome-Edited Rice Varieties: Process, Benefits, Challenges', pageNumber: 14, tag: 'Biotechnology' },

  { topicName: C5, questionText: '5.1 Wearable Health Tech & Biosensors: Applications, Privacy, Equity', pageNumber: 16, tag: '' },
  { topicName: C5, questionText: '5.2 Brain-Computer Interface (BCI): Applications & Risks', pageNumber: 16, tag: '' },
  { topicName: C5, questionText: '5.3 Brain-Computer Interface (BCI): Applications & Challenges', pageNumber: 17, tag: '' },
  { topicName: C5, questionText: '5.4 Neurotechnology: Applications & Risks', pageNumber: 18, tag: '' },
  { topicName: C5, questionText: '5.5 NAP-AMR 2.0: Features, Improvements over NAP 1.0, Challenges', pageNumber: 18, tag: 'Medical and Health Technologies' },
  { topicName: C5, questionText: '5.6 Traditional Medicine: Significance & Integration Challenges', pageNumber: 19, tag: 'IPR' },

  { topicName: C6, questionText: '6.1 6G vs 5G: Technical Advantages & Rural-Urban Digital Divide', pageNumber: 21, tag: '' },
  { topicName: C6, questionText: '6.2 Post-Quantum Cryptography (PQC): Urgency for India', pageNumber: 21, tag: '' },
  { topicName: C6, questionText: '6.3 Quantum Technologies in Manufacturing', pageNumber: 22, tag: '' },
  { topicName: C6, questionText: '6.4 AI for Socio-Economic Development: Applications, Hurdles, Measures', pageNumber: 22, tag: 'AI' },
  { topicName: C6, questionText: '6.5 Vehicle-to-Vehicle (V2V) Communication: Principle, Working, Advantages, Challenges', pageNumber: 23, tag: '' },

  { topicName: C7, questionText: '7.1 Nanotechnology: Combating Pollution & Environmental Sustainability', pageNumber: 25, tag: 'Nanotechnology' },

  { topicName: C8, questionText: '8.1 Waste-to-Energy (WTE): Concept & Technologies', pageNumber: 26, tag: '' },
  { topicName: C8, questionText: '8.2 Alternative Technologies for Freshwater Scarcity', pageNumber: 26, tag: 'Tech in Crisis Management' },
  { topicName: C8, questionText: '8.3 Electric Vehicles: Advantages over ICE Vehicles; FCEV vs BEV', pageNumber: 27, tag: '' },

  { topicName: C9, questionText: '9.1 Intellectual Property Rights (IPRs) in India: Types & Government Initiatives', pageNumber: 28, tag: 'IPR' },
  { topicName: C9, questionText: "9.2 IPR & Life Materials: Global Scenario and India's Commercialization Gap", pageNumber: 28, tag: 'IPR' },
  { topicName: C9, questionText: "9.3 Geographical Indications (GI): Gaps in India's Ecosystem", pageNumber: 29, tag: '' },

  { topicName: C10, questionText: '10.1 Union Budget 2025-26: Measures for Research & Innovation', pageNumber: 31, tag: '' },
  { topicName: C10, questionText: '10.2 Structural & Functional Challenges of Public R&D Institutions', pageNumber: 31, tag: 'Achievements of Indians in S & T' },

  { topicName: C11, questionText: '11.1 Contributions of Dr. Vikram Sarabhai & Dr. Homi Bhabha', pageNumber: 33, tag: 'Achievements of Indians in S & T' },
  { topicName: C11, questionText: '11.2 Dr. Verghese Kurien: Dairy Sector & Rural Empowerment', pageNumber: 33, tag: 'Achievements of Indians in S & T' }
];

// ================= PYQs, classified against the checklist tags above (or Chapter fallback) =================
const PYQ_ROWS = [
  // 15. Developments in S&T and their Applications and Effects in Everyday Life
  { questionText: 'What is digital signature? What does its authentication mean? Giver various salient built in features of a digital signature.', section: C6, year: 2013 },
  { questionText: 'How does the 3D printing technology work? List out the advantages and disadvantages of the technology.', section: C6, year: 2013 },

  { questionText: 'Each year a large amount of plant material, cellulose, is deposited on the surface of Planet Earth. What are the natural processes this cellulose undergoes before yielding carbon dioxide, water and other end products?', section: C4, year: 2022 },

  { questionText: 'Stem cell therapy is gaining popularity in India to treat a wide variety of medical conditions including Leukaemia, Thalassemia, damaged cornea and several burns. Describe briefly what stem cell therapy is and what advantages it has over other treatments?', section: 'Medical and Health Technologies', year: 2017 },
  { questionText: "Can overuse and the availability of antibiotics without doctor's prescription, the contributors to the emergence of drug-resistant diseases in India? What are the available mechanisms for monitoring and control? Critically discuss the various issues involved.", section: 'Medical and Health Technologies', year: 2014 },
  { questionText: 'What do you understand by fixed dose drug combinations (FDCs)? Discuss their merits and demerits.', section: 'Medical and Health Technologies', year: 2013 },

  { questionText: 'The Nobel Prize in Physics of 2014 was jointly awarded to Akasaki, Amano and Nakamura for the invention of Blue LEDs in 1990s. How has this invention impacted the everyday life of human beings?', section: C6, year: 2021 },

  { questionText: 'What do you understand by Umpire decision review in cricket? Discuss its various components. Explain how silicon tape on the edge of a bat may fool the system?', section: C6, year: 2013 },
  { questionText: 'What is an FRP composite material? How are they manufactured? Discuss their applications in aviation and automobile industry', section: C3, year: 2013 },

  { questionText: 'The world is facing an acute shortage of clean and safe freshwater. What are the alternative technologies which can solve this crisis? Briefly discuss any three such technologies citing their key merits and demerits.', section: 'Tech in Crisis Management', year: 2024 },

  { questionText: 'What is the technology being employed for electronic toll collection on highways? What are its advantages and limitations? What are the proposed changes that will make this process seamless? Would this transition carry any potential hazards?', section: C6, year: 2024 },
  { questionText: 'How is science interwoven deeply with our lives? What are the striking changes in agriculture triggered off by the science-based technologies?', section: C4, year: 2020 },

  { questionText: 'What is the basic principle behind vaccine development? How do vaccines work? What approaches were adopted by the Indian vaccine manufacturers to produce COVID-19 vaccines?', section: 'Vaccines', year: 2022 },

  // 16. Achievements of Indians in S&T; Indigenization of Technology
  { questionText: 'How was India benefited from the contributions of Sir M.Visvesvaraya and Dr. M. S. Swaminathan in the fields of water engineering and agricultural science respectively?', section: 'Achievements of Indians in S & T', year: 2019 },
  { questionText: "Discuss the work of 'Bose-Einstein Statistics' done by Prof. Satyendra Nath Bose and show how it revolutionized the field of Physics.", section: 'Achievements of Indians in S & T', year: 2018 },
  { questionText: 'Scientific research in Indian universities is declining, because a career in science is not as attractive as our business operations, engineering or administration, and the universities are becoming consumer oriented. Critically comment.', section: C10, year: 2014 },

  { questionText: "The fusion energy programme in India has steadily evolved over the past few decades. Mention India's contributions to the international fusion energy project International Thermonuclear Experimental Reactor (ITER). What will be the implications of the success of this project for the future of global energy?", section: 'Nuclear Energy', year: 2025 },
  { questionText: 'With growing energy needs should India keep on expanding its nuclear energy programme? Discuss the facts and fears associated with nuclear energy.', section: 'Nuclear Energy', year: 2018 },
  { questionText: 'Give an account of the growth and development of nuclear science and technology in India. What is the advantage of fast breeder reactor programme in India?', section: 'Nuclear Energy', year: 2017 },

  // 17. IT, Space, Computers, Robotics, Nanotechnology, Bio-technology, IPR
  { questionText: 'Introduce the concept of Artificial Intelligence (AI). How does AI help clinical diagnosis? Do you perceive any threat to privacy of the individual in the use of AI in healthcare?', section: 'AI', year: 2023 },

  { questionText: 'How is S-400 air defence system technically superior to any other system presently available in the world?', section: 'Defence', year: 2021 },

  { questionText: 'Discuss the advantage and security implications of cloud hosting of server vis-a-vis inhouse machine-based hosting for government businesses.', section: C6, year: 2015 },

  { questionText: 'How can India achieve energy independence through clean technology by 2047? How can biotechnology play a crucial role in this endeavour?', section: 'Biotechnology', year: 2025 },
  { questionText: 'Discuss several ways in which microorganisms can help in meeting the current fuel shortage.', section: 'Biotechnology', year: 2023 },
  { questionText: 'What are the research and developmental achievements in applied biotechnology? How will these achievements help to uplift the poorer sections of society?', section: 'Biotechnology', year: 2021 },
  { questionText: 'How can biotechnology improve the living standards of farmers?', section: 'Biotechnology', year: 2019 },
  { questionText: 'Why is there so much activity in the field of biotechnology in our country? How has this activity benefitted the field of biopharma?', section: 'Biotechnology', year: 2018 },

  { questionText: 'What is the present world scenario of intellectual property rights with respect to life materials? Although, India is second in the world to file patents, still only a few have been commercialized. Explain the reasons behind this less commercialization.', section: 'IPR', year: 2024 },
  { questionText: 'How is the government of India protecting traditional knowledge of medicine from patenting by pharmaceutical companies?', section: 'IPR', year: 2019 },
  { questionText: "India's Traditional Knowledge Digital Library (TKDL) which has a database containing formatted information on more than 2 million medicinal formulations is proving a powerful weapon in the country's fight against erroneous patents. Discuss the pros and cons making this database publicly available under open-source licensing", section: 'IPR', year: 2015 },
  { questionText: 'In a globalised world, intellectual property rights assume significance and are a source of litigation. Broadly distinguish between the terms – copyrights, patents and trade secrets.', section: 'IPR', year: 2014 },
  { questionText: 'Bring out the circumstances in 2005 which forced amendment to section 3(d) in the Indian Patent Law, 1970. Discuss how it has been utilized by Supreme court in its judgment rejecting Novartis patent application for "Glivec". Discuss briefly the pros and cons of the decision.', section: C9, year: 2013 },

  { questionText: 'What do you understand by nanotechnology and how is it helping in health sector?', section: 'Nanotechnology', year: 2020 },
  { questionText: "Why is nanotechnology one of the key technologies of the 21st century? Describe the salient features of Indian Government's Mission on Nanoscience and Technology and the scope of its application in the development process of the country.", section: 'Nanotechnology', year: 2016 },

  { questionText: 'What are the areas of prohibitive labour that can be sustainably managed by robots? Discuss the initiatives that can propel research in premier research institutes for substantive and gainful innovation.', section: C10, year: 2015 },

  { questionText: "What is the main task of India's third moon mission which could not be achieved in its earlier mission? List the countries that have achieved this task. Introduce the subsystems in the spacecraft launched and explain the role of the Virtual Launch Control Centre at the Vikram Sarabhai Space Centre which contributed to the successful launch from Srihari Kota.", section: 'Space Programs x IND', year: 2023 },
  { questionText: "What is India's plan to have its own space station and how will it benefit our space programme?", section: 'Space Programs x IND', year: 2019 },
  { questionText: 'India has achieved remarkable successes in unmanned space missions including the Chandrayaan and Mars Orbitter Mission, but has not ventured into manned space mission, both in terms of technology and logistics? Explain critically.', section: 'Space Programs x IND', year: 2017 },
  { questionText: "Discuss India's achievements in the field of Space Science and Technology. How the application of this technology has helped India in its socio-economic development?", section: 'Space Programs x IND', year: 2016 },
  { questionText: "What do you understand by 'Standard Positioning Systems' and 'Protection Positioning Systems' in the GPS era? Discuss the advantages India perceives from its ambitious IRNSS programme employing just seven satellites.", section: 'Space Programs x IND', year: 2015 },

  { questionText: 'Launched on 25th December, 2021, James Webb Space Telescope has been much in the news since then. What are its unique features which make it superior to its predecessor Space Telescopes? What are the key goals of this mission? What potential benefits does it hold for the human race?', section: C1, year: 2022 },

  { questionText: 'What are asteroids? How real is the threat of them causing extinction of life? What strategies have been developed to prevent such a catastrophe?', section: C1, year: 2024 },

  { questionText: 'COVID-19 pandemic has caused unprecedented devastation worldwide. However, technological advancements are being availed readily to win over the crisis. Give an account of how technology was sought to aid management to the pandemic.', section: 'Tech in Crisis Management', year: 2020 }
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

// One-time import of Progress checklist + PYQ data for the "MMF-Security" file inside the
// existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-11) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Governance imports. `tag` on each sub-heading is a short clean keyword for
// precise PYQ matching, mostly reusing the PYQ document's own microtheme labels. Chapters 9-11
// (Human Security, Emerging Technologies and Security, National Security Strategy) have no PYQs
// in this batch; "mob violence" and DPDP Act/Srikrishna Committee PYQs have no dedicated
// sub-heading and fall back to the closest relevant chapter.
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
const TARGET_FILE_NAME = 'MMF-Security';

const C1 = 'Chapter 1: Left-Wing Extremism and Naxalism';
const C2 = 'Chapter 2: North-East Insurgency and Illegal Migration';
const C3 = 'Chapter 3: Organised Crime–Terrorism Nexus and Terror Financing';
const C4 = 'Chapter 4: Non-State Actors and External Threats';
const C5 = 'Chapter 5: Cyber Security and Emerging Digital Threats';
const C6 = 'Chapter 6: Maritime Security';
const C7 = 'Chapter 7: Border Management';
const C8 = 'Chapter 8: Security Forces and Institutional Coordination';
const C9 = 'Chapter 9: Human Security';
const C10 = 'Chapter 10: Emerging Technologies and Security';
const C11 = 'Chapter 11: National Security Strategy and the Global Order';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Left-Wing Extremism: Reasons for Continuation and Strategies to Address It', pageNumber: 3, tag: 'LWE' },
  { topicName: C1, questionText: '1.2 Naxal-Free India by March 2026: Remaining Challenges and Measures Beyond Security', pageNumber: 3, tag: 'LWE' },
  { topicName: C1, questionText: '1.3 Land Alienation and Socio-Economic Marginalisation as Drivers of Internal Security Challenges', pageNumber: 4, tag: 'LWE' },
  { topicName: C1, questionText: '1.4 Role of Development Programmes in Reducing Extremist Influence in the Red Corridor', pageNumber: 5, tag: 'LWE' },
  { topicName: C1, questionText: '1.5 Community Engagement and Participatory Development in Countering Extremism', pageNumber: 6, tag: 'LWE' },

  { topicName: C2, questionText: '2.1 Reasons for the Continuation of Armed Insurgency in the North-East', pageNumber: 7, tag: 'North East Insurgency' },
  { topicName: C2, questionText: '2.2 Illegal Migration: Demographic, Resource, and Security Impact in the Northeast', pageNumber: 7, tag: 'Illegal Migration' },

  { topicName: C3, questionText: '3.1 The Organised Crime-Terrorism Nexus and Measures to Tackle It', pageNumber: 9, tag: 'Organized Crime and Terrorism' },
  { topicName: C3, questionText: "3.2 Cross-Border Terrorism-Organised Crime Nexus and India's PRAHAAR Policy", pageNumber: 9, tag: 'Organized Crime and Terrorism' },
  { topicName: C3, questionText: '3.3 Narco-Terrorism as an Emerging Threat and Measures to Counter It', pageNumber: 10, tag: 'Narco-Terrorism' },
  { topicName: C3, questionText: '3.4 Money Laundering: National and Global Initiatives to Curb the Menace', pageNumber: 11, tag: 'Money Laundering' },
  { topicName: C3, questionText: "3.5 Evolving Sources of Terrorist Financing and India's Institutional Mechanisms", pageNumber: 11, tag: 'Terror Financing' },
  { topicName: C3, questionText: '3.6 White-Collar Terrorism as an Emerging Concern', pageNumber: 12, tag: '' },

  { topicName: C4, questionText: "4.1 Non-State Actors and the Challenges They Pose to India's Internal Security", pageNumber: 14, tag: 'External State and Non-State Actors' },
  { topicName: C4, questionText: '4.2 Evolution of Threats from Conventional to Asymmetric Conflicts: Role of External Actors', pageNumber: 14, tag: 'External State and Non-State Actors' },

  { topicName: C5, questionText: '5.1 Types of Cybercrimes and Measures Required to Fight the Menace', pageNumber: 16, tag: 'Cyber Security' },
  { topicName: C5, questionText: '5.2 Security Challenges from Social Media and Encrypted Messaging, and Government Measures', pageNumber: 16, tag: 'Digital Media and Security Threats' },
  { topicName: C5, questionText: '5.3 Cyber Warfare in the Grey Zone and Challenges to National Security Doctrines', pageNumber: 17, tag: 'Cyber Security' },
  { topicName: C5, questionText: "5.4 Cyber Security Threats from Digitalisation and India's Preparedness", pageNumber: 17, tag: 'Cyber Security' },
  { topicName: C5, questionText: '5.5 Grey-Zone Warfare and the Challenge to Traditional Sovereignty and Conflict', pageNumber: 18, tag: '' },
  { topicName: C5, questionText: '5.6 Research Security: Meaning and Key Challenges in India', pageNumber: 19, tag: '' },

  { topicName: C6, questionText: "6.1 Maritime Piracy and India's Measures to Combat It in the Indian Ocean", pageNumber: 20, tag: 'Maritime Security Challenges' },
  { topicName: C6, questionText: '6.2 Key Maritime Security Challenges and Government Measures', pageNumber: 20, tag: 'Maritime Security Challenges' },
  { topicName: C6, questionText: "6.3 SAGAR and the Indian Navy's Role in the Indian Ocean Region", pageNumber: 21, tag: '' },
  { topicName: C6, questionText: '6.4 Maritime Zones under UNCLOS: Security Implications and Challenges for Coastal States', pageNumber: 21, tag: '' },
  { topicName: C6, questionText: "6.5 Evolution of India's Maritime Security Strategy in the Indo-Pacific", pageNumber: 23, tag: '' },

  { topicName: C7, questionText: "7.1 Conflicting Issues along India's China and Pakistan Borders, and Development under BADP/BIM", pageNumber: 24, tag: 'Border Area Management' },
  { topicName: C7, questionText: '7.2 Border Management as a Security and Developmental Challenge', pageNumber: 24, tag: 'Border Area Management' },
  { topicName: C7, questionText: '7.3 CAPFs in Border Management: Role and Problems of Infrastructure and Personnel Management', pageNumber: 25, tag: 'Border Area Management;Security Forces' },

  { topicName: C8, questionText: "8.1 Role of CAPFs in India's Security Framework, Challenges, and Reforms", pageNumber: 27, tag: 'Security Forces' },
  { topicName: C8, questionText: '8.2 Institutional Mechanisms for Union-State Coordination in Internal Security', pageNumber: 27, tag: 'Security Forces' },

  { topicName: C9, questionText: '9.1 Human Security: Definition and Key Dimensions', pageNumber: 29, tag: '' },

  { topicName: C10, questionText: "10.1 Role of Private Sector in Strengthening India's Internal Security", pageNumber: 30, tag: '' },
  { topicName: C10, questionText: '10.2 Artificial Intelligence Modifying the Nature of Security Threats and Responses', pageNumber: 30, tag: '' },
  { topicName: C10, questionText: '10.3 Emerging Technologies Amplifying External Threats: Proactive Policy, Legal, and Institutional Response', pageNumber: 31, tag: '' },

  { topicName: C11, questionText: '11.1 Key Arguments in Favour of a National Security Strategy (NSS) for India', pageNumber: 33, tag: '' },
  { topicName: C11, questionText: '11.2 Shift from Arms Control to Strategic Competition in the Global Nuclear Order', pageNumber: 33, tag: '' }
];

// ================= PYQs, classified against the checklist tags above (or Chapter fallback) =================
const PYQ_ROWS = [
  // 20. Linkages between Development and Spread of Extremism
  { questionText: 'The Government of India recently stated that Left Wing Extremism (LWE) will be eliminated by 2026. What do you understand by LWE and how are the people affected by it? What measures have been taken by the government to eliminate LWE?', section: 'LWE', year: 2025 },
  { questionText: 'Naxalism is a social, economic and developmental issue manifesting as a violent internal security threat. In this context, discuss the emerging issues and suggest a multilayered strategy to tackle the menace of Naxalism.', section: 'LWE', year: 2022 },
  { questionText: 'What are the sound determinants of left-wing extremism in Eastern part of India? What strategy should Government of India, civil administration and security forces adopt to counter the threat in the affected areas?', section: 'LWE', year: 2020 },
  { questionText: "Left Wing Extremism (LWE) is showing a downward trend, but still affects many parts of the country. Briefly explain the Government of India's approach to counter the challenges posed by LWE.", section: 'LWE', year: 2018 },
  { questionText: 'The persisting drives of the government for development of large industries in backward areas have resulted in isolating the tribal population and the farmers who face multiple displacements with Malkangiri and Naxalbari foci, discuss the corrective strategies needed to win the left wing extremism (LWE) doctrine affected citizens back into the mainstream of social and economic growth.', section: 'LWE', year: 2015 },
  { questionText: 'Article 244 of Indian Constitution relates to Administration of Scheduled areas and tribal areas. Analyze the impact of non-implementation of the provisions of Fifth Schedule on the growth of Left Wing Extremism', section: 'LWE', year: 2013 },

  { questionText: 'What are the major challenges to internal security and peace process in the North-Eastern States? Map the various peace accords and agreements initiated by the government in the past decade.', section: 'North East Insurgency', year: 2025 },
  { questionText: 'The north-eastern region of India has been infested with insurgency for a very long time. Analyze the major reasons for the survival of armed insurgency in this region.', section: 'North East Insurgency', year: 2017 },

  // 21. Role of External State and Non-state Actors
  { questionText: 'Analyse the multidimensıonal challenges posed by external state and non-state actors, to the internal security of India. Also, discuss measures required to be taken to combat these threats', section: 'External State and Non-State Actors', year: 2021 },
  { questionText: "The China-Pakistan Economic Corridor (CPEC) is viewed as a cardinal subset of China's larger 'One Belt One Road' initiative. Give a brief description of CPEC and enumerate the reasons why India has distanced itself from the same.", section: 'External State and Non-State Actors', year: 2018 },
  { questionText: 'Use of Internet and social media by non-state actors for subversive activities is a major concern. How have these have misused in the recent past? Suggest effective guidelines to curb the above threat.', section: 'External State and Non-State Actors', year: 2016 },
  { questionText: 'The diverse nature of India as a multireligious and multi-ethnic society is not immune to the impact of radicalism which has been in her neighbourhood. Discuss along with the strategies to be adopted to counter this environment.', section: 'External State and Non-State Actors', year: 2014 },
  { questionText: "China and Pakistan have entered into an agreement for development of an economic corridor. What thread does it dispose for India's security? Critically examine.", section: 'External State and Non-State Actors', year: 2014 },

  // 22. Communication Networks, Media, Social Networking, Cyber Security, Money-Laundering
  { questionText: 'What are the different elements of cyber security? Keeping in view the challenges in cyber security, examine the extent to which India has successfully developed a comprehensive National Cyber Security Strategy.', section: 'Cyber Security', year: 2022 },
  { questionText: "Keeping in view India's internal security, analyse the impact of cross-border cyber attacks. Also, discuss defensive measures against these sophisticated attacks.", section: 'Cyber Security', year: 2021 },
  { questionText: 'Discuss different types of cyber crimes and measures required to be taken to fight the menace', section: 'Cyber Security', year: 2020 },
  { questionText: 'What is the CyberDome Project? Explain how it can be useful in controlling internet crimes in India', section: 'Cyber Security', year: 2019 },
  { questionText: 'Discuss the potential threats of Cyber attack and the security framework to prevent it.', section: 'Cyber Security', year: 2017 },
  { questionText: 'Considering the threats cyberspace poses for the country, India needs a "Digital Armed Force" to prevent crimes. Critically evaluate the National Cyber Security Policy, 2013 outlining the challenges perceived in its effective implementation.', section: 'Cyber Security', year: 2015 },
  { questionText: 'Cyber warfare is considered by some defense analysts to be a larger threat than even Al Qaeda or terrorism. What do you understand by Cyber warfare? Outline the cyber threats which India is vulnerable to and bring out the state of the country\'s preparedness to deal with the same.', section: 'Cyber Security', year: 2013 },

  { questionText: 'Describe the context and salient features of the Digital Personal Data Protection Act, 2023', section: C5, year: 2024 },
  { questionText: 'Data security has assumed significant importance in the digitized world due to rising cyber crimes. The Justice B. N. Srikrishna Committee Report addresses issues related to data security. What, in your view, are the strengths and weaknesses of the Report relating to protection of personal data in cyber space?', section: C5, year: 2018 },

  { questionText: 'Mob violence is emerging as a serious law and order problem in India. By giving suitable examples, analyze the causes and consequences of such violence.', section: C3, year: 2017 },

  { questionText: 'Social media and encrypting messaging services pose a serious security challenge. What measures have been adopted at various levels to address the security implications of social media? Also suggest any other remedies to address the problem.', section: 'Digital Media and Security Threats', year: 2024 },
  { questionText: 'Religious indoctrination via digital media has resulted in Indian youth joining the ISIS. What is ISIS and its mission? How can ISIS be dangerous for the internal security of our country?', section: 'Digital Media and Security Threats', year: 2015 },
  { questionText: 'What are social networking site and what security implications do these sites present?', section: 'Digital Media and Security Threats', year: 2013 },

  { questionText: "India's proximity to two of the world's biggest illicit opium-growing states has enhanced her internal security concerns. Explain the linkages between drug trafficking and other illicit activities such as gunrunning, money laundering and human trafficking. What counter-measures should be taken to prevent the same?", section: 'Narco-Terrorism', year: 2018 },

  { questionText: 'Discuss how emerging technologies and globalisation contribute to money laundering. Elaborate measures to tackle the problem of money laundering both at national and international levels.', section: 'Money Laundering', year: 2021 },
  { questionText: "Money laundering poses a serious threat to country's economic sovereignty. What is its significance for India and what steps are required to be taken to control this menace?", section: 'Money Laundering', year: 2013 },

  // 23. Border Areas, Organised Crime-Terrorism linkages
  { questionText: 'India has a long and troubled border with China and Pakistan fraught with contentious issues. Examine the conflicting issues and security challenges along the border. Also give out the development being undertaken in these areas under the Border Area Development Programme (BADP) and Border Infrastructure and Management (BIM) Scheme.', section: 'Border Area Management', year: 2024 },
  { questionText: 'The use of unmanned aerial vehicles (UAVs) by our adversaries across the borders to ferry arms / ammunitions, drugs, etc., is a serious threat to internal security. Comment on the measures being taken to tackle this threat.', section: 'Border Area Management', year: 2023 },
  { questionText: 'For effective border area management, discuss the steps required to be taken to deny local support to militants and also suggest ways to manage favourable perception among locals', section: 'Border Area Management', year: 2020 },
  { questionText: 'Cross-border movement of insurgents is only one of the several security challenges facing the policing of the border in North-East India. Examine the various challenges currently emanating across the India-Myanmar border. Also, discuss the steps to counter the challenges.', section: 'Border Area Management', year: 2019 },
  { questionText: 'Border management is a complex task due to difficult terrain and hostile relations with some countries. Elucidate the challenges and strategies for effective border management.', section: 'Border Area Management', year: 2016 },
  { questionText: "How illegal transborder migration does pose a threat to India's security? Discuss the strategies to curb this, bring out the factors which give impetus to such migration.", section: 'Illegal Migration', year: 2014 },
  { questionText: "How far are India's internal security challenges linked with border management, particularly in view of the long porous borders with most countries of South Asia and Myanmar?", section: 'Border Area Management', year: 2013 },

  { questionText: "Why is maritime security vital to protect India's sea trade? Discuss maritime and coastal security challenges and the way forward.", section: 'Maritime Security Challenges', year: 2025 },
  { questionText: 'What are the maritime security challenges in India? Discuss the organisational, technical and procedural initiatives taken to improve the maritime security.', section: 'Maritime Security Challenges', year: 2022 },
  { questionText: "In 2012, the longitudinal marking of the high-risk areas for piracy was moved from 65° East to 78° east in the Arabian Sea by International Maritime organisation. What impact does this have on India's maritime security concerns?", section: 'Maritime Security Challenges', year: 2014 },

  { questionText: 'Terrorism is a global scourge. How has it manifested in India? Elaborate with contemporary examples. What are the counter measures adopted by the State? Explain.', section: 'Organized Crime and Terrorism', year: 2025 },
  { questionText: 'Explain how narco-terrorism has emerged as a serious threat across the country. Suggest suitable measures to counter narco-terrorism.', section: 'Narco-Terrorism', year: 2024 },
  { questionText: "Give out the major sources of terror funding in India and the efforts being made to curtail these sources. In the light of this, also discuss the aim and objective of the 'No Money for Terror (NMFT)' Conference recently held at New Delhi in November 2022.", section: 'Terror Financing', year: 2023 },
  { questionText: "Winning of 'Hearts and Minds' in terrorism-affected areas is an essential step in restoring the trust of the population. Discuss the measures adopted by the Government in this respect as part of the conflict resolution in Jammu and Kashmir.", section: 'Organized Crime and Terrorism', year: 2023 },
  { questionText: 'Discuss the types of organised crimes. Describe the linkages between terrorists and organised crime that exist at the national and transnational levels.', section: 'Organized Crime and Terrorism', year: 2022 },
  { questionText: 'Analyse the complexity and intensity of terrorism, its causes, linkages and obnoxious nexus. Also, suggest measures required to be taken to eradicate the menace of terrorism', section: 'Organized Crime and Terrorism', year: 2021 },
  { questionText: "The banning of 'Jamaat-e – islaami' in Jammu and Kashmir brought into focus the role of over-ground workers (OGWs) in assisting terrorist organizations. Examine the role played by OGWs in assisting terrorist organizations in insurgency affected areas. Discuss measures to neutralize the influence of OGWs.", section: 'Organized Crime and Terrorism', year: 2019 },
  { questionText: 'The scourge of terrorism is a grave challenge to national security. What solutions do you suggest to curb this growing menace? What are the major sources of terrorist funding?', section: 'Terror Financing', year: 2017 },
  { questionText: "The terms 'Hot Pursuit' and 'Surgical Strikes' are often used in connection with armed action against terrorist attacks. Discuss the strategic impact of such actions.", section: 'Organized Crime and Terrorism', year: 2016 },
  { questionText: 'Terrorism is emerging as a competitive industry over the last few decades. Analyse the above statement.', section: 'Organized Crime and Terrorism', year: 2016 },

  // 24. Various Security Forces and Agencies and their Mandate
  { questionText: 'Indian government has recently strengthened the anti-terrorism laws by amending the unlawful activities (Prevention) Act (UAPA), 1967 and the NIA Act. Analyze the changes in the context of prevailing security environment while discussing the scope and reasons for opposing the UAPA by human rights organizations.', section: 'Security Forces', year: 2019 },
  { questionText: 'Human rights activists constantly highlight the view that the Armed Forces (Special Powers) Act, 1958 (AFSPA) is a draconian act leading to cases of human rights abuses by the security forces. What sections of AFSPA are opposed by the activists? Critically evaluate the requirement with reference to the view held by the Apex Court.', section: 'Security Forces', year: 2015 },

  { questionText: 'What are the internal security challenges being faced by India? Give out the role of Central Intelligence and Investigative Agencies tasked to counter such threats.', section: 'Security Forces', year: 2023 },
  { questionText: 'Analyze internal security threats and transborder crimes along Myanmar, Bangladesh and Pakistan borders including Line of Control (LoC). Also discuss the role played by various security forces in this regard', section: 'Security Forces', year: 2020 }
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

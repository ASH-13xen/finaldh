// One-time import of Progress checklist + PYQ data for the "MMF - Governance" file inside the
// existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-9) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society imports. Unlike other subjects, this book's own chapters (current-affairs
// driven: Federalism, Judiciary, RPA/Electoral Reforms, e-Governance, Civil Services,
// Development Industry) don't 1:1 match the older-institution PYQ set given (CAG, Finance
// Commission, National Commissions NHRC/NCW/Lokpal/CCI, Tribunals) - this book has no dedicated
// chapter for those specific bodies. Those PYQs fall back broadly: Finance Commission + CBI
// (explicitly about "federal character") -> Chapter 1 (Federalism & Centre-State Relations);
// everything else institution-related -> Chapter 4 (Statutory, Regulatory & Quasi-Judicial
// Bodies), the closest thematic match even without a dedicated item. Syllabus-10 "Government
// Policies & Interventions" PYQs (Gati-Shakti, LPG reforms, FDI, PURA, etc.) also have no
// dedicated chapter and fall back to Chapter 7 (Development Processes) or the e-Governance tag
// where digital-scheme-flavored.
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
const TARGET_FILE_NAME = 'MMF - Governance';

const C1 = 'Chapter 1: Federalism & Centre-State Relations';
const C2 = 'Chapter 2: Separation of Powers & Judiciary';
const C3 = 'Chapter 3: Representation of the People Act & Electoral Reforms';
const C4 = 'Chapter 4: Statutory, Regulatory & Quasi-Judicial Bodies';
const C5 = 'Chapter 5: Governance, Transparency, Accountability & e-Governance';
const C6 = 'Chapter 6: Role of Civil Services in a Democracy';
const C7 = 'Chapter 7: Development Processes & Development Industry';
const C8 = 'Chapter 8: Welfare Schemes for Vulnerable Sections';
const C9 = 'Chapter 9: Social Sector - Health & Education';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Inter-State River Water Disputes Act, 1956 – Need for Amendment', pageNumber: 3, tag: '' },

  { topicName: C2, questionText: '2.1 Impeachment of SC/HC Judges & Separation of Powers', pageNumber: 4, tag: '' },
  { topicName: C2, questionText: '2.2 Separation of Powers – Judicial Shaping through Case Law', pageNumber: 4, tag: '' },
  { topicName: C2, questionText: '2.3 Article 142 – Judicial Dynamism vs Overreach', pageNumber: 5, tag: '' },

  { topicName: C3, questionText: '3.1 RPA 1951 – Disqualifications & Remedies', pageNumber: 7, tag: '' },
  { topicName: C3, questionText: '3.2 Corrupt Practices under RPA 1951 & Remedial Measures', pageNumber: 7, tag: '' },
  { topicName: C3, questionText: '3.3 Repeal of Section 8(4) RPA 1951 & Criminalization of Politics', pageNumber: 8, tag: '' },
  { topicName: C3, questionText: '3.4 Electoral Bonds – SC Judgment & Corruption Risk', pageNumber: 9, tag: '' },
  { topicName: C3, questionText: '3.5 Electoral Roll Preparation & Revision under RPA 1950', pageNumber: 9, tag: '' },
  { topicName: C3, questionText: '3.6 Section 53(2) RPA 1951 – Constitutionality of Uncontested Elections', pageNumber: 10, tag: '' },

  { topicName: C4, questionText: '4.1 Online Gaming – Regulatory Challenges & Evolving Legal Framework', pageNumber: 12, tag: '' },

  { topicName: C5, questionText: '5.1 Social Audit – Objectives & Significance', pageNumber: 13, tag: '' },
  { topicName: C5, questionText: '5.2 e-Governance – Role & Enhancement Measures', pageNumber: 14, tag: 'e-Governance' },
  { topicName: C5, questionText: '5.3 Interactive Service Model (ISM) of e-Governance', pageNumber: 15, tag: 'e-Governance;Interactive Service Model' },
  { topicName: C5, questionText: '5.4 RTI Act – Transparency vs Political & Administrative Hurdles', pageNumber: 16, tag: 'RTI Act' },
  { topicName: C5, questionText: '5.5 Public Sector Reliance on External Consultancy Firms', pageNumber: 17, tag: '' },
  { topicName: C5, questionText: "5.6 Citizens' Charter – Hindering Factors & Measures", pageNumber: 18, tag: 'Citizens Charter' },
  { topicName: C5, questionText: '5.7 Digital India Mission – Achievements & Future Outlook', pageNumber: 19, tag: 'e-Governance' },
  { topicName: C5, questionText: '5.8 Government Process Re-engineering – Efficiency, Transparency, Accountability', pageNumber: 19, tag: '' },
  { topicName: C5, questionText: "5.9 Citizen's Charter – Shortcomings & Ways to Improve Impact", pageNumber: 20, tag: 'Citizens Charter' },

  { topicName: C6, questionText: '6.1 Civil Service Challenges & Reforms', pageNumber: 22, tag: 'Civil Services' },
  { topicName: C6, questionText: '6.2 Lateral Entry into Civil Services – Reform vs Controversy', pageNumber: 22, tag: '' },
  { topicName: C6, questionText: '6.3 Civil Servants – Efficiency and Empathy', pageNumber: 23, tag: 'Civil Services' },
  { topicName: C6, questionText: '6.4 Civil Services in the Digital Governance Era', pageNumber: 24, tag: 'Civil Services' },

  { topicName: C7, questionText: '7.1 Civil Society & its Significance', pageNumber: 26, tag: 'Civil Society' },
  { topicName: C7, questionText: '7.2 SHGs – Rural Development Role & Govt Initiatives', pageNumber: 26, tag: 'SHGs' },
  { topicName: C7, questionText: '7.3 NGO-Government Collaboration Challenges & Solutions', pageNumber: 27, tag: 'NGOs;Civil Society' },
  { topicName: C7, questionText: '7.4 Industry & Business Associations in Socio-Economic Development', pageNumber: 29, tag: '' },
  { topicName: C7, questionText: '7.5 Public Charitable Trusts & Inclusive Development', pageNumber: 29, tag: 'Donor Agencies' },
  { topicName: C7, questionText: '7.6 Co-operatives – Role & Challenges', pageNumber: 30, tag: '' },
  { topicName: C7, questionText: "7.7 Microfinancing of Women SHGs – Breaking the Gender-Poverty-Malnutrition Cycle", pageNumber: 31, tag: 'Microfinancing Women SHGs' },
  { topicName: C7, questionText: '7.8 Faith-Based Organizations – Alternative Public Service Delivery Model', pageNumber: 32, tag: '' },
  { topicName: C7, questionText: '7.9 SBLP – Effectiveness in Poverty Alleviation', pageNumber: 33, tag: 'SBLP' },
  { topicName: C7, questionText: "7.10 Shift from 'Provider State' to 'Enabler State'", pageNumber: 33, tag: 'Provider to Enabler State' },

  { topicName: C8, questionText: '8.1 Mid-Day Meal Scheme (PM POSHAN) – Achievement of Objectives', pageNumber: 35, tag: '' },

  { topicName: C9, questionText: '9.1 NEP 2020 – Vocationalisation, Digital Learning, Multilingualism vs SDG-4', pageNumber: 36, tag: '' },
  { topicName: C9, questionText: '9.2 ASHAs – Role in Maternal/Newborn Health & Challenges', pageNumber: 36, tag: '' }
];

// ================= PYQs, classified against the checklist tags above (or Chapter fallback) =================
const PYQ_ROWS = [
  // 09. Appointment to Constitutional posts; Constitutional/Statutory/Regulatory/Quasi-judicial bodies
  { questionText: '"The duty of the Comptroller and Auditor General is not merely to ensure the legality of expenditure but also its propriety." Comment.', section: C4, year: 2024 },
  { questionText: 'The Comptroller and Auditor General (CAG) has a very vital role to play. Explain how this is reflected in the method and terms of his appointment as well as the range of powers he can exercise.', section: C4, year: 2018 },
  { questionText: "Exercise of CAG's powers in relation to the accounts of the Union and the States is derived from Article 149 of the Indian Constitution. Discuss whether audit of the Government's Policy implementation could amount to overstepping its own (CAG) jurisdiction.", section: C4, year: 2016 },

  { questionText: 'The jurisdiction of the Central Bureau of Investigation (CBI) regarding lodging an FIR and conducting probe within a particular State is being questioned by various States. However, the power of the States to withhold consent to the CBI is not absolute. Explain with special reference to the federal character of India.', section: C1, year: 2021 },

  { questionText: 'How have the recommendations of the 14th Finance Commission of India enabled the States to improve their fiscal position?', section: C1, year: 2021 },
  { questionText: 'How is the Finance Commission of India constituted? What do you about the terms of reference of the recently constituted Finance Commission? Discuss.', section: C1, year: 2018 },
  { questionText: 'Discuss the recommendations of the 13th Finance Commission which have been a departure from the previous commissions for strengthening the local government finances.', section: C1, year: 2013 },

  { questionText: 'Discuss the role of the National Commission for Backward Classes in the wake of its transformation from a statutory body to a constitutional body.', section: C4, year: 2022 },
  { questionText: 'Whether National Commission for Scheduled Castes (NCSC) can enforce the implementation of constitutional reservation for the Scheduled Castes in the religious minority institutions? Examine.', section: C4, year: 2018 },

  { questionText: 'The National Commission for Protection of Child Rights has to address the challenges faced by children in the digital era. Examine the existing policies and suggest measures the Commission can initiate to tackle the issue.', section: C4, year: 2025 },
  { questionText: 'Discuss the role of the Competition Commission of India in containing the abuse of dominant position by the Multi-National Corporations in India. Refer to the recent decisions.', section: C4, year: 2023 },
  { questionText: 'Though the Human Rights Commissions have contributed immensely to the protection of human rights in India, yet they have failed to assert themselves against the mighty and powerful. Analyzing their structural and practical limitations, suggest remedial measures.', section: C4, year: 2021 },
  { questionText: 'Which steps are required for constitutionalization of a Commission? Do you think imparting constitutionality to the National Commission for Women would ensure greater gender justice and empowerment in India? Give reasons.', section: C4, year: 2020 },
  { questionText: 'Multiplicity of various commissions for the vulnerable sections or the society leads to problems or overlapping jurisdiction and duplication of functions. Is it better to merge all commissions into an umbrella Human Rights Commission? Argue your case.', section: C4, year: 2018 },
  { questionText: 'Is the National Commission for Women able to strategize and tackle the problems that women face at both public and private spheres? Give reasons in support of your answer.', section: C4, year: 2017 },
  { questionText: 'National Human Rights Commission (NHRC) in India can be most effective when its tasks are adequately supported by other mechanisms that ensure the accountability of a government. In light of the above observation assess the role of NHRC as an effective complement to the judiciary and other institutions in promoting and protecting human rights standards.', section: C4, year: 2014 },
  { questionText: "'A national Lokpal, however strong it may be, cannot resolve the problems of immorality in public affairs'. Discuss.", section: C4, year: 2013 },

  { questionText: 'For achieving the desired objectives, it is necessary to ensure that the regulatory institutions remain independent and autonomous. Discuss in the light of the experiences in recent past.', section: C4, year: 2015 },
  { questionText: 'The setting up of a Rail Tariff Authority to regulate fares will subject the cash strapped Indian Railways to demand subsidy for obligation to operate non-profitable routes and services. Taking into account the experience in the power sector, discuss if the proposed reform is expected to benefit the consumers, the Indian Railways or the private container operators.', section: C4, year: 2014 },
  { questionText: 'The product diversification of financial institutions and insurance companies, resulting in overlapping of products and services strengthens the case for the merger of the two regulatory agencies, namely SEBI and IRDA. Justify.', section: C4, year: 2013 },

  { questionText: '"The Central Administration Tribunal which was established for redressal of grievances and complaints by or against central government employees, nowadays is exercising its powers as an independent judicial authority." Explain.', section: C4, year: 2019 },
  { questionText: 'How far do you agree with the view that tribunals curtail the jurisdiction of ordinary courts? In view of the above, discuss the constitutional validity and competency of the tribunals in India.', section: C4, year: 2018 },
  { questionText: 'What is a quasi-judicial body? Explain with the help of concrete examples.', section: C4, year: 2016 },

  // 10. Government Policies & Interventions for development of various sectors
  { questionText: 'The Gati-Shakti Yojana needs meticulous coordination between the government and the private sector to achieve the goal of connectivity. Discuss.', section: 'e-Governance', year: 2022 },
  { questionText: 'Two parallel run schemes of the Government viz. the Adhaar Card and NPR, one as voluntary and the other as compulsory, have led to debates at national levels and also litigations. On merits, discuss whether or not both schemes need run concurrently. Analyse the potential of the schemes to achieve developmental benefits and equitable growth.', section: 'e-Governance', year: 2014 },
  { questionText: 'The basis of providing urban amenities in rural areas (PURA) is rooted in establishing connectivity. Comment.', section: C7, year: 2013 },

  { questionText: '"In contemporary development models, decision-making and problem-solving responsibilities are not located close to the source of information and execution, defeating the objectives of development." Critically evaluate.', section: C7, year: 2025 },
  { questionText: "The need for cooperation among various service sector has been an inherent component of development discourse. Partnership bridges bring the gap among the sectors. It also sets in motion a culture of 'Collaboration' and 'team spirit'. In the light of statements above examine India's Development process.", section: C7, year: 2019 },
  { questionText: "'In the context of neo-liberal paradigm of development planning, multi-level planning is expected to make operations cost effective and remove many implementation blockages.'-Discuss.", section: C7, year: 2019 },
  { questionText: "Policy contradictions among various competing sectors and stakeholders have resulted in inadequate 'protection and prevention of degradation' to environment. \" Comment with relevant illustration.", section: C7, year: 2018 },
  { questionText: 'Has the Indian governmental system responded adequately to the demands of Liberalization, Privatization and Globalization started in 1991? What can the government do to be responsive to this important change?', section: C7, year: 2016 },
  { questionText: 'Though 100 percent FDI is already allowed in non-news media like a trade publication and general entertainment channel, the Government is mulling over the proposal for increased FDI in news media for quite some time. What difference would an increase in FDI make? Critically evaluate the pros and cons.', section: C7, year: 2014 },

  // 11. Development processes and the development industry
  { questionText: 'Civil Society Organizations are often perceived as being anti-State actors rather than non-State actors. Do you agree? Justify.', section: 'Civil Society', year: 2025 },
  { questionText: "Discuss the contribution of civil society groups for women's effective and meaningful participation and representation in state legislatures in India.", section: 'Civil Society', year: 2023 },
  { questionText: 'Can Civil Society and Non-Governmental Organizations present an alternative model of public service delivery to benefit the common citizen? Discuss the challenges of this alternative model.', section: 'Civil Society', year: 2021 },
  { questionText: 'In the Indian governance system, the role of non-state actors has been only marginal. Critically examine this statement.', section: 'Civil Society', year: 2016 },
  { questionText: 'Examine critically the recent changes in the rules governing foreign funding of NGOs under the Foreign Contribution (Regulation) Act (FCRA), 1976.', section: 'NGOs', year: 2015 },
  { questionText: 'How can the role of NGOs be strengthened in India for development works relating to protection of the environment? Discuss throwing light on the major constraints.', section: 'NGOs', year: 2015 },

  { questionText: "Public charitable trusts have the potential to make India's development more inclusive as they relate to certain vital public issues. Comment.", section: 'Donor Agencies', year: 2024 },
  { questionText: 'Do you agree with the view that increasing dependence on donor agencies for development reduces the importance of community participation in the development process? Justify your answer.', section: 'Donor Agencies', year: 2022 },

  { questionText: 'Can the vicious cycle of gender inequality, poverty and malnutrition be broken through microfinancing of women SHGs? Explain with examples.', section: 'Microfinancing Women SHGs', year: 2021 },
  { questionText: '"Micro-Finance as an anti-poverty vaccine, is aimed at asset creation and income security of the rural poor in India". Evaluate the role of Self Help Groups in achieving the twin objectives along with empowering women in rural India.', section: 'SHGs', year: 2020 },
  { questionText: "'The emergence of Self Help Groups(SHGs) in contemporary times points to the slow but steady withdrawal of the state from developmental activities'. Examine the role of the SHGs in developmental activities and the measures taken by the Government of India to promote the SHGs.", section: 'Provider to Enabler State', year: 2017 },
  { questionText: "The Self-Help Group (SHG) Bank Linkage Programme (SBLP), which is India's own innovation, has proved to be one of the most effective poverty alleviation and women empowerment programmes. Elucidate.", section: 'SBLP', year: 2015 },
  { questionText: 'The penetration of Self Help Groups (SHGs) in rural areas in promoting participation in development programmes is facing socio-cultural hurdles. Examine.', section: 'SHGs', year: 2014 },
  { questionText: 'The legitimacy and accountability of Self Help Groups (SHGs) and their patrons, the micro-finance outfits, need systematic assessment and scrutiny for the sustained success of the concept. Discuss.', section: 'SHGs', year: 2013 },

  // 15. Transparency and accountability; Citizens Charter; E-Governance
  { questionText: "The Citizens'charter has been a land mark initiative in ensuring citizen-centric administration. But it is yet to reach its full potential. Identify the factors hindering the realisation of its promise and suggest measures to overcome them.", section: 'Citizens Charter', year: 2024 },
  { questionText: "Citizens' Charter is an ideal instrument of organizational transparency and accountability, but it has its own limitations. Identify the limitations and suggest measures for greater effectiveness or the Citizens Charter.", section: 'Citizens Charter', year: 2018 },
  { questionText: "Though Citizen's charters have been formulated by many public service delivery organizations, there is no corresponding improvement in the level of citizens' satisfaction and quality of services being provided. Analyze.", section: 'Citizens Charter', year: 2013 },

  { questionText: 'E-governance projects have a built-in bias towards technology and back-end integration than user-centric designs. Examine.', section: 'e-Governance', year: 2025 },
  { questionText: "e-governance is not just about the routine application of digital technology in service delivery process. It is as much about multifarious interactions for ensuring transparency and accountability. In this context evaluate the role of the 'Interactive Service Model' of e-governance.", section: 'Interactive Service Model', year: 2024 },
  { questionText: 'e-governance, as a critical tool of governance, has ushered in effectiveness, transparency and accountability in governments. What inadequacies hamper the enhancement of these features?', section: 'e-Governance', year: 2023 },
  { questionText: 'Has digital illiteracy, particularly in rural areas, coupled with lack of Information and Communication Technology (ICT) accessibility hindered socio-economic development? Examine with justification.', section: 'e-Governance', year: 2021 },
  { questionText: '"The emergence of Fourth Industrial Revolution (Digital Revolution) has initiated e-Governance as an integral part of government". Discuss.', section: 'e-Governance', year: 2020 },
  { questionText: 'Implementation of information and Communication Technology (ICT) based Projects / Programmes usually suffers in terms of certain vital factors. Identify these factors, and suggest measures for their effective implementation.', section: 'e-Governance', year: 2019 },
  { questionText: "E-Governance is not only about utilization of the power of new technology, but also much about critical importance of the 'use value' of information Explain.", section: 'e-Governance', year: 2018 },
  { questionText: 'Electronic cash transfer system for the welfare schemes is an ambitious project to minimize corruption, eliminate wastage and facilitate reforms. Comment.', section: 'e-Governance', year: 2013 },

  { questionText: 'What are the aims and objects of the recently passed and enforced, The Public Examination (Prevention of Unfair Means) Act, 2024? Whether University/State Education Board examinations, too, are covered under the Act?', section: C5, year: 2024 },
  { questionText: 'Reforming the government delivery system through the Direct Benefit Transfer Scheme is a progressive step, but it has its limitations too. Comment.', section: 'e-Governance', year: 2022 },
  { questionText: '"Recent amendments to the Right to Information Act will have profound impact on the autonomy and independence of the Information Commission". Discuss.', section: 'RTI Act', year: 2020 },
  { questionText: "Effectiveness of the government system at various levels and people's participation in the governance system are inter-dependent. Discuss their relationship with each other in context of India.", section: C5, year: 2016 },
  { questionText: 'In the integrity index of Transparency International, India stands very low. Discuss briefly the legal, political, economic, social and cultural factors that have caused the decline of public morality in India.', section: C5, year: 2016 },
  { questionText: 'In the light of the Satyam Scandal, discuss the changes brought in corporate governance to ensure transparency, accountability.', section: C5, year: 2015 },
  { questionText: 'If amendment bill to the Whistleblowers Act, 2011 tabled in the Parliament is passed, there may be no one left to protect. Critically evaluate.', section: C5, year: 2015 },

  // 16. Role of Civil Services in a democracy
  { questionText: 'The Doctrine of Democratic Governance makes it necessary that the public perception of the integrity and commitment of civil servants becomes absolutely positive. Discuss.', section: 'Civil Services', year: 2024 },
  { questionText: '"Institutional quality is a crucial driver of economic performance". In this context suggest reforms in Civil Service for strengthening democracy.', section: 'Civil Services', year: 2020 },
  { questionText: 'Initially Civil Services in India were designed to achieve the goals of neutrality and effectiveness, which seems to be lacking in the present context. Do you agree with the view that drastic reforms are required in Civil Services. Comment', section: 'Civil Services', year: 2017 },
  { questionText: 'Traditional bureaucratic structure and culture have hampered the process of socio-economic development in India. Comment.', section: 'Civil Services', year: 2016 },
  { questionText: 'Has the Cadre based Civil Services Organisation been the cause of slow change in India? Critically examine.', section: 'Civil Services', year: 2014 }
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

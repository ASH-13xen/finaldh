// One-time import of Progress checklist + PYQ data for the "MMF - GS-2" file inside the existing
// "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same course+fileIndex-scoped
// approach as import_mmf_ir_progress.mjs.
//
// CONSOLIDATED file bundling four subjects (Polity, Governance, Social Justice, International
// Relations), each with a brand-new, current-affairs-driven chapter/sub-heading index (with page
// numbers) materially different from the standalone MMF - Polity / MMF - Governance /
// MMF-Social Justice / MMF - International Relations files built earlier. Per the user's
// instruction, NO new PYQs were sourced: every PYQ here is reused verbatim (questionText + year)
// from those four standalone files' existing ProgressPyq data, re-classified against this new
// GS-2 index. Because this consolidated index has no exact counterpart for many older-institution
// topics (Tribunals, individual National Commissions, RTI Act, Citizens Charter, Emergency
// Provisions, DPSP, Amendment procedure, most bilateral/regional IR groupings), matching is
// allowed to cross the original subject boundary wherever a better-fitting chapter exists
// elsewhere in GS-2 (e.g. Governance's Finance Commission PYQs route to Polity's Chapter 3
// Federalism; Social Justice's NEP 2020 PYQ routes to Governance's own NEP 2020 item).
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
const TARGET_FILE_NAME = 'MMF - GS-2';

// ---- Indian Constitution & Polity ----
const P1 = 'Polity – Chapter 1: Historical Underpinnings & Evolution of the Constitution';
const P2 = 'Polity – Chapter 2: Salient Features, Basic Structure & Comparative Constitutions';
const P3 = 'Polity – Chapter 3: Union-State Relations & Federalism';
const P4 = 'Polity – Chapter 4: Parliament & State Legislatures';
const P5 = 'Polity – Chapter 5: Executive, Judiciary & Separation of Powers';
const P6 = 'Polity – Chapter 6: Constitutional, Statutory & Regulatory Bodies';
// ---- Governance & Civil Services ----
const Gv1 = 'Governance – Chapter 1: Government Policies, Schemes & e-Governance';
const Gv2 = 'Governance – Chapter 2: Transparency, Accountability & Civil Services Reform';
const Gv3 = 'Governance – Chapter 3: Development Processes, NGOs & SHGs';
// ---- Social Justice ----
const SJ1 = 'Social Justice – Chapter 1: Welfare Schemes & Vulnerable Sections';
const SJ2 = 'Social Justice – Chapter 2: Poverty, Hunger & Human Development';
// ---- International Relations ----
const IR1 = 'International Relations – Chapter 1: India & its Neighbourhood';
const IR2 = 'International Relations – Chapter 2: Bilateral, Regional & Global Groupings';
const IR3 = 'International Relations – Chapter 3: International Institutions & Global Governance';
const IR4 = 'International Relations – Chapter 4: Diaspora & Foreign Policy Machinery';

const CHECKLIST_ROWS = [
  { topicName: P1, questionText: '1.1 Pre-Independence Constitutional Drafts', pageNumber: 1, tag: 'Historical Background' },

  { topicName: P2, questionText: '2.1 India as a Secular State vs US Secularism', pageNumber: 1, tag: 'World Constitutions' },
  { topicName: P2, questionText: '2.2 106th Constitutional Amendment Act (Nari Shakti Vandan Adhiniyam)', pageNumber: 2, tag: '' },
  { topicName: P2, questionText: '2.3 Basic Tenets of India & UK Political Systems', pageNumber: 3, tag: 'World Constitutions' },
  { topicName: P2, questionText: "2.4 106th CAA, 2023 - Women's Reservation", pageNumber: 4, tag: '' },
  { topicName: P2, questionText: '2.5 Presidents of India and Sri Lanka Compared', pageNumber: 5, tag: '' },
  { topicName: P2, questionText: '2.6 Fraternity - Concept and Role in Social Harmony', pageNumber: 6, tag: '' },

  { topicName: P3, questionText: '3.1 State Finance Commissions: Functions & Challenges', pageNumber: 7, tag: 'Finance Commission' },
  { topicName: P3, questionText: "3.2 Sixth Schedule and Ladakh's Demand", pageNumber: 7, tag: '' },
  { topicName: P3, questionText: '3.3 GST - Cooperative Federalism vs Fiscal Autonomy', pageNumber: 8, tag: 'GST Council' },
  { topicName: P3, questionText: '3.4 Cooperation, Competition and Confrontation in Indian Federalism', pageNumber: 9, tag: 'Centre-State Relations' },
  { topicName: P3, questionText: '3.5 Centralisation vs Decentralisation in Development', pageNumber: 11, tag: 'Panchayati Raj & Local Government' },
  { topicName: P3, questionText: '3.6 Fiscal Federalism - From Correction to Co-Creation', pageNumber: 12, tag: 'Finance Commission' },
  { topicName: P3, questionText: "3.7 Fifth vs Sixth Schedule & Ladakh's Demand", pageNumber: 13, tag: '' },
  { topicName: P3, questionText: '3.8 73rd & 74th Constitutional Amendment Acts', pageNumber: 14, tag: 'Panchayati Raj & Local Government' },
  { topicName: P3, questionText: '3.9 Asymmetric Federal Arrangements in India', pageNumber: 15, tag: 'Centre-State Relations' },
  { topicName: P3, questionText: '3.10 16th Finance Commission - Departures from Previous Commissions', pageNumber: 16, tag: 'Finance Commission' },

  { topicName: P4, questionText: '4.1 Public Accounts Committee & Government Accountability', pageNumber: 18, tag: 'Parliamentary Committees' },
  { topicName: P4, questionText: '4.2 American Senate vs Rajya Sabha', pageNumber: 19, tag: 'World Constitutions' },
  { topicName: P4, questionText: '4.3 Anti-Defection Law - Circumvention & Reforms', pageNumber: 20, tag: 'Anti-Defection Law' },
  { topicName: P4, questionText: '4.4 Role & Removal of Speaker of Lok Sabha', pageNumber: 21, tag: 'Speaker of Lok Sabha' },
  { topicName: P4, questionText: '4.5 Parliamentary Estimates Committee - Evaluation', pageNumber: 22, tag: 'Parliamentary Committees' },

  { topicName: P5, questionText: "5.1 President's Election vs Impeachment: Role of State Legislatures", pageNumber: 22, tag: '' },
  { topicName: P5, questionText: '5.2 Synthesis of Parliamentary Sovereignty & Judicial Supremacy', pageNumber: 23, tag: '' },
  { topicName: P5, questionText: "5.3 Supreme Court & the Governor's Constitutional Limits", pageNumber: 24, tag: 'Governor' },
  { topicName: P5, questionText: '5.4 Right to Privacy (Article 21) & DNA Testing of an Unborn Child', pageNumber: 25, tag: 'Fundamental Rights' },
  { topicName: P5, questionText: "5.5 Preventive Detention - the 'Bermuda Triangle'", pageNumber: 25, tag: '' },
  { topicName: P5, questionText: '5.6 Constitutional Morality and Judicial Balance', pageNumber: 26, tag: 'Constitutional Morality' },
  { topicName: P5, questionText: '5.7 Civil vs Criminal Defamation', pageNumber: 27, tag: '' },
  { topicName: P5, questionText: '5.8 Public Interest Litigation - Role & Misuse', pageNumber: 29, tag: 'Judiciary (General)' },
  { topicName: P5, questionText: '5.9 Term Limits for the Office of Prime Minister', pageNumber: 30, tag: '' },
  { topicName: P5, questionText: '5.10 Right to Die with Dignity under Article 21', pageNumber: 30, tag: '' },
  { topicName: P5, questionText: '5.11 Essential Religious Practices (ERP) Doctrine', pageNumber: 31, tag: '' },

  { topicName: P6, questionText: '6.1 NCW and Challenges in the Digital Era', pageNumber: 32, tag: 'NCW' },
  { topicName: P6, questionText: '6.2 Special Intensive Revision (SIR) of Electoral Rolls', pageNumber: 33, tag: 'Election Commission' },
  { topicName: P6, questionText: '6.3 Delimitation Commission - Constitutional & Legal Provisions', pageNumber: 34, tag: '' },
  { topicName: P6, questionText: '6.4 Right to Vote and Right to Contest Elections', pageNumber: 35, tag: 'Election Commission' },

  { topicName: Gv1, questionText: '1.1 Three-Language Policy: Implementation Challenges', pageNumber: 37, tag: '' },
  { topicName: Gv1, questionText: '1.2 AI in Education & Healthcare Governance', pageNumber: 37, tag: '' },
  { topicName: Gv1, questionText: '1.3 Swachh Bharat Mission: Impact & Drawbacks', pageNumber: 38, tag: '' },
  { topicName: Gv1, questionText: "1.4 Digital India as a People's Movement", pageNumber: 39, tag: 'e-Governance' },
  { topicName: Gv1, questionText: '1.5 Marketisation of Public Education', pageNumber: 40, tag: '' },
  { topicName: Gv1, questionText: '1.6 Digital Addiction & Healthcare Governance Gaps', pageNumber: 41, tag: '' },
  { topicName: Gv1, questionText: '1.7 Digital Governance & Exclusion in Welfare Delivery', pageNumber: 42, tag: 'e-Governance' },
  { topicName: Gv1, questionText: '1.8 AI Governance Framework in India', pageNumber: 43, tag: '' },
  { topicName: Gv1, questionText: '1.9 NEP 2020 - Status of Implementation', pageNumber: 44, tag: 'NEP 2020' },

  { topicName: Gv2, questionText: '2.1 All India Judicial Services (AIJS)', pageNumber: 45, tag: '' },
  { topicName: Gv2, questionText: '2.2 Generalist Civil Services vs Scientific Expertise', pageNumber: 46, tag: 'Civil Services' },
  { topicName: Gv2, questionText: '2.3 Trust-Based Governance & Jan Vishwas Act, 2026', pageNumber: 46, tag: '' },

  { topicName: Gv3, questionText: '3.1 Role of NGOs in Development', pageNumber: 48, tag: 'NGOs' },
  { topicName: Gv3, questionText: '3.2 Civil Society Organisations - Anti-State or Non-State', pageNumber: 48, tag: 'Civil Society' },
  { topicName: Gv3, questionText: '3.3 Environmental Pressure Groups', pageNumber: 49, tag: 'Pressure Groups' },
  { topicName: Gv3, questionText: '3.4 FCRA Amendment Bill, 2026 & NGO Functioning', pageNumber: 51, tag: 'NGOs' },
  { topicName: Gv3, questionText: '3.5 Strengthening SHGs for Women-Led Development', pageNumber: 51, tag: 'SHGs;Microfinancing Women SHGs;SBLP;Provider to Enabler State' },

  { topicName: SJ1, questionText: "1.1 Legal Frameworks for Women's Safety in India", pageNumber: 54, tag: '' },
  { topicName: SJ1, questionText: '1.2 Right to Menstrual Health & Hygiene (MHH)', pageNumber: 54, tag: '' },
  { topicName: SJ1, questionText: '1.3 Constitutional & Legal Provisions for Scheduled Castes', pageNumber: 55, tag: '' },
  { topicName: SJ1, questionText: '1.4 PoSH Act, 2013 - Securing Safe Workplaces', pageNumber: 56, tag: '' },

  { topicName: SJ2, questionText: '2.1 Malnutrition Determinants & Nutrition Interventions', pageNumber: 57, tag: 'Poverty-Malnutrition Cycle' },
  { topicName: SJ2, questionText: '2.2 Overnutrition in Urban India', pageNumber: 58, tag: '' },
  { topicName: SJ2, questionText: '2.3 Paradox of Poverty and Resource Inequality', pageNumber: 59, tag: 'Multidimensional Poverty' },
  { topicName: SJ2, questionText: '2.4 Rising Non-Food Essential Expenditure Among Poor', pageNumber: 60, tag: 'Hunger' },
  { topicName: SJ2, questionText: '2.5 Growing Divergence Between Poverty and Hunger in India', pageNumber: 61, tag: 'Hunger' },

  { topicName: IR1, questionText: '1.1 India-China Strategic Competition & South Asia Policy', pageNumber: 63, tag: 'China' },
  { topicName: IR1, questionText: '1.2 Pragmatism in India-Afghanistan Relations', pageNumber: 63, tag: 'Afghanistan' },
  { topicName: IR1, questionText: '1.3 Geopolitical Significance of Bangladesh for India', pageNumber: 64, tag: 'Bangladesh' },
  { topicName: IR1, questionText: '1.4 India-Nepal Relations - Depth and Complexities', pageNumber: 65, tag: '' },

  { topicName: IR2, questionText: "2.1 Sahel Region Instability & India's Interests", pageNumber: 67, tag: '' },
  { topicName: IR2, questionText: "2.2 Energy Security and India's Foreign Policy", pageNumber: 68, tag: 'Energy Security' },
  { topicName: IR2, questionText: "2.3 Significance of BRICS & India's 2026 Chairship", pageNumber: 69, tag: '' },
  { topicName: IR2, questionText: "2.4 Integrating Economic Security into India's Foreign Policy", pageNumber: 70, tag: 'West Fostering India' },
  { topicName: IR2, questionText: '2.5 India-EU Relations & the India-EU FTA', pageNumber: 71, tag: '' },
  { topicName: IR2, questionText: '2.6 Quad - Shared Vision Tested by Transactional Geopolitics', pageNumber: 71, tag: 'Quad;AUKUS' },

  { topicName: IR3, questionText: '3.1 IAEA & the Peaceful Use of Nuclear Technology', pageNumber: 73, tag: '' },
  { topicName: IR3, questionText: '3.2 Sovereign Nationalism in the Post-Cold War World', pageNumber: 73, tag: 'Sovereign Nationalism' },
  { topicName: IR3, questionText: "3.3 IMO's MEPC and Marine Environment Protection", pageNumber: 74, tag: 'IMO' },
  { topicName: IR3, questionText: '3.4 Sovereign vs State in Contemporary World Politics', pageNumber: 76, tag: '' },
  { topicName: IR3, questionText: '3.5 WTO Limitations & Revitalisation', pageNumber: 76, tag: 'WTO' },

  { topicName: IR4, questionText: "4.1 Indian Diaspora's Contribution to Africa", pageNumber: 77, tag: 'Indian Diaspora;Africa' },
  { topicName: IR4, questionText: '4.2 MEA: Challenges & Reform Measures', pageNumber: 78, tag: '' }
];

// ================= PYQs, reused verbatim from the 4 standalone subject files =================
const PYQ_ROWS = [
  // ---- from MMF - Polity ----
  { questionText: 'Indian Constitution has conferred the amending power on the ordinary legislative institutions with a few procedural hurdles. In view of this statement, examine the procedural and substantive limitations on the amending power of the Parliament to change the Constitution.', section: P2, year: 2025 },
  { questionText: '"Parliament\'s power to amend the Constitution is a limited power and it cannot be enlarged into absolute power." In the light of this statement explain whether Parliament under Article 368 of the Constitution can destroy the Basic Structure of the Constitution by expanding its amending power?', section: P2, year: 2019 },
  { questionText: "Explain the salient features of the constitution (One Hundred and First Amendment) Act, 2016. Do you think it is efficacious enough 'to remove cascading effect of taxes and provide for common national market for goods and services'?", section: 'GST Council', year: 2017 },
  { questionText: 'The role of individual MPs (Members of Parliament) has diminished over the years and as a result healthy constructive debates on policy issues are not usually witnessed. How far can this be attributed to the anti-defection law, which was legislated but with a different intention?', section: 'Anti-Defection Law', year: 2013 },
  { questionText: 'The Attorney General of India plays a crucial role in guiding the legal framework of the Union Government and ensuring sound governance through legal counsel." Discuss his responsibilities, rights and limitations in this regard.', section: P5, year: 2025 },
  { questionText: '"The Attorney-General is the chief legal adviser and lawyer of the Government of India." Discuss.', section: P5, year: 2019 },
  { questionText: 'What was held in the Coelho case? In this context, can you say that judicial review is of key importance amongst the basic features of the Constitution?', section: P2, year: 2016 },
  { questionText: 'The Supreme Court of India keeps a check on arbitrary power of the Parliament in amending the Constitution. Discuss critically.', section: P2, year: 2013 },
  { questionText: '"The growth of cabinet system has practically resulted in the marginalisation of the parliamentary supremacy." Elucidate.', section: P5, year: 2024 },
  { questionText: 'The size of the cabinet should be as big as governmental work justifies and as big as the Prime Minister can manage as a team. How far the efficacy of a government then is inversely related to the size of the cabinet? Discuss.', section: P5, year: 2014 },
  { questionText: 'Examine the evolving pattern of Centre-State financial relations in the context of planned development in India. How far have the recent reforms impacted the fiscal federalism in India?', section: 'Centre-State Relations', year: 2025 },
  { questionText: 'What changes has the Union Government recently introduced in the domain of Centre-State relations? Suggest measures to be adopted to build the trust between the Centre and the States and for strengthening federalism.', section: 'Centre-State Relations', year: 2024 },
  { questionText: 'Indian Constitution exhibits centralising tendencies to maintain unity and integrity of the nation. Elucidate in the perspective of the Epidemic Diseases Act, 1897; The Disaster Management Act, 2005 and recently passed Farm Acts.', section: 'Centre-State Relations', year: 2020 },
  { questionText: 'How far do you think cooperation, competition and confrontation have shaped the nature of federation in India? Cite some recent examples to validate your answer.', section: 'Centre-State Relations', year: 2020 },
  { questionText: "From the resolution of contentious issues regarding distribution of legislative powers by the courts, 'Principle of Federal Supremacy' and 'Harmonious Construction' have emerged. Explain.", section: 'Centre-State Relations', year: 2019 },
  { questionText: 'The concept of cooperative federalism has been increasingly emphasized in recent years. Highlight the drawbacks in the existing structure and the extent to which cooperative federalism would answer the shortcomings.', section: 'Centre-State Relations', year: 2015 },
  { questionText: 'Though the federal principle is dominant in our Constitution and that principle is one of its basic features, but it is equally true that federalism under the Indian Constitution leans in favour of a strong Centre, a feature that militates against the concept of strong federalism. Discuss.', section: 'Centre-State Relations', year: 2014 },
  { questionText: 'Many State Governments further bifurcate geographical administrative areas like Districts and Talukas for better governance. In light of the above, can it also be justified that more number of smaller States would bring in effective governance at State level? Discuss.', section: 'Centre-State Relations', year: 2013 },
  { questionText: '"Constitutional morality is the fulcrum which acts as an essential check upon the high functionaries and citizens alike..." In view of the above observation of the Supreme Court, explain the concept of constitutional morality and its application to ensure balance between judicial independence and judicial accountability in India.', section: 'Constitutional Morality', year: 2025 },
  { questionText: "'Constitutional Morality' is rooted in the Constitution itself and is founded on its essential facets. Explain the doctrine of 'Constitutional Morality' with the help of relevant judicial decisions.", section: 'Constitutional Morality', year: 2021 },
  { questionText: 'Discuss the possible factors that inhibit India from enacting for its citizens a uniform civil code as provided for in the Directive Principles of State Policy.', section: P2, year: 2015 },
  { questionText: "Discuss the 'corrupt practices' for the purpose of the Representation of the People Act, 1951. Analyze whether the increase in the assets of the legislators and/or their associates, disproportionate to their known sources of income, would constitute 'undue influence' and consequently a corrupt practice.", section: 'Election Commission', year: 2025 },
  { questionText: 'Discuss the procedures to decide the disputes arising out of the election of a Member of the Parliament or State Legislature under The Representation of the People Act, 1951. What are the grounds on which the election of any returned candidate may be declared void? What remedy is available to the aggrieved party against the decision? Refer to the case laws.', section: 'Election Commission', year: 2022 },
  { questionText: '"There is a need for simplification of procedure for disqualification of persons found guilty of corrupt practices under the Representation of Peoples Act". Comment.', section: 'Election Commission', year: 2020 },
  { questionText: "On what grounds a people's representative can be disqualified under the Representation of People Act, 1951? Also mention the remedies available to such person against his disqualification.", section: 'Election Commission', year: 2019 },
  { questionText: 'Examine the need for electoral reforms as suggested by various committees with particular reference to "one nation-one election" principle.', section: 'Election Commission', year: 2024 },
  { questionText: 'In the light of recent controversy regarding the use of Electronic Voting Machines (EVM), what are the challenges before the Election Commission of India to ensure the trustworthiness of elections in India?', section: 'Election Commission', year: 2018 },
  { questionText: 'To enhance the quality of democracy in India the Election Commission of India has proposed electoral reforms in 2016. What are the suggested reforms and how far are they significant to make democracy successful?', section: 'Election Commission', year: 2017 },
  { questionText: "'Simultaneous election to the Lok Sabha and the State Assemblies will limit the amount of time and money spent in electioneering but it will reduce the government's accountability to the people' Discuss.", section: 'Election Commission', year: 2017 },
  { questionText: 'Account for the legal and political factors responsible for the reduced frequency of using Article 356 by the Union Governments since mid 1990s.', section: 'Centre-State Relations', year: 2023 },
  { questionText: 'Under what circumstances can the Financial Emergency be proclaimed by the President of India? What consequences follow when such a declaration remains in force?', section: 'Centre-State Relations', year: 2018 },
  { questionText: 'Right to privacy is intrinsic to life and personal liberty and is inherently protected under Article 21 of the Constitution. Explain. In this reference discuss the law relating to D.N.A. testing of a child in the womb to establish its paternity.', section: 'Fundamental Rights', year: 2024 },
  { questionText: 'Explain the constitutional perspectives of Gender Justice with the help of relevant Constitutional Provisions and case laws.', section: 'Fundamental Rights', year: 2023 },
  { questionText: '"The Constitution of India is a living instrument with capabilities of enormous dynamism. It is a constitution made for a progressive society". Illustrate with special reference to the expanding horizons of the right to life and personal liberty.', section: 'Fundamental Rights', year: 2023 },
  { questionText: 'Right of movement and residence throughout the territory of India are freely available to the Indian citizens, but these rights are not absolute. Comment', section: 'Fundamental Rights', year: 2022 },
  { questionText: 'Examine the scope of Fundamental Rights in the light of the latest judgement of the Supreme Court on Right to Privacy.', section: 'Fundamental Rights', year: 2017 },
  { questionText: 'Does the right to clean environment entail legal regulations on burning crackers during Diwali? Discuss in the light of Article 21 of the Indian Constitution and Judgement(s) of the Apex Court in this regard.', section: 'Fundamental Rights', year: 2015 },
  { questionText: 'What do you understand by the concept "freedom of speech and expression"? Does it cover hate speech also? Why do the films in India stand on a slightly different plane from other forms of expression? Discuss.', section: 'Fundamental Rights', year: 2014 },
  { questionText: 'Discuss Section 66A of IT Act, with reference to its alleged violation of Article 19 of the Constitution.', section: 'Fundamental Rights', year: 2013 },
  { questionText: 'Explain the significance of the 101st Constitutional Amendment Act. To what extent does it reflect the accommodative spirit of federalism?', section: 'GST Council', year: 2023 },
  { questionText: 'Whether the Supreme Court Judgement (July 2018) can settle the political tussle between the Lt. Governor and elected government of Delhi? Examine.', section: 'Governor', year: 2018 },
  { questionText: 'Discuss the essentials of the 69th Constitutional Amendment Act and anomalies, if any that have led to recent reported conflicts between the elected representatives and the institution of the Lieutenant Governor in the administration of Delhi. Do you think that this will give rise to a new trend in the functioning of the Indian federal politics?', section: 'Governor', year: 2016 },
  { questionText: 'Did the Government of India Act, 1935 lay down a federal constitution? Discuss.', section: 'Historical Background', year: 2016 },
  { questionText: 'Constitutional mechanisms to resolve the inter-state water disputes have failed to address and solve the problems. Is the failure due to structural or process inadequacy or both? Discuss.', section: P3, year: 2013 },
  { questionText: "Starting from inventing the 'basic structure' doctrine, the judiciary has played a highly proactive role in ensuring that India develops into a thriving democracy. In light of the statement, evaluate the role played by judicial activism in achieving the ideals of democracy.", section: P5, year: 2014 },
  { questionText: "Explain the reasons for the growth of public interest litigation in India. As a result of it, has the Indian Supreme Court emerged as the world's most powerful judiciary?", section: 'Judiciary (General)', year: 2024 },
  { questionText: '"Constitutionally guaranteed judicial independence is a prerequisite of democracy". Comment.', section: 'Judiciary (General)', year: 2023 },
  { questionText: 'Discuss the desirability of greater representation to women in the higher judiciary to ensure diversity, equity and inclusiveness.', section: 'Judiciary (General)', year: 2021 },
  { questionText: 'Judicial Legislation is antithetical to the doctrine of separation of powers as envisaged in the Indian Constitution. In this context justify the filing of large number of public interest petitions praying for issuing guidelines to executive authorities.', section: 'Judiciary (General)', year: 2020 },
  { questionText: 'Discuss the role of the Election Commission of India in the light of the evolution of the Model Code of Conduct', section: 'Election Commission', year: 2016 },
  { questionText: 'To what extent is Article 370 of the Indian Constitution, bearing marginal note "Temporary provision with respect to the State of Jammu and Kashmir", temporary? Discuss the future prospects of this provision in the context of Indian polity.', section: P3, year: 2016 },
  { questionText: "Recent directives from Ministry of Petroleum and Natural Gas are perceived by the `Nagas' as a threat to override the exceptional status enjoyed by the State. Discuss in light of Article 371A of the Indian Constitution.", section: P3, year: 2013 },
  { questionText: "'Once a Speaker, Always a Speaker'! Do you think this practice should be adopted to impart objectivity to the office of the Speaker of Lok Sabha? What could be its implications for the robust functioning of parliamentary business in India?", section: 'Speaker of Lok Sabha', year: 2020 },
  { questionText: 'Discuss the role of Presiding Officers of state legislatures in maintaining order and impartiality in conducting legislative work and in facilitating best democratic practices.', section: P4, year: 2023 },
  { questionText: 'While the national political parties in India favour centralisation, the regional parties are in favour of State autonomy. Comment.', section: P4, year: 2022 },
  { questionText: 'The Indian party system is passing through a phase of transition which looks to be full of contradictions and paradoxes." Discuss.', section: P4, year: 2016 },
  { questionText: 'Analyse the role of local bodies in providing good governance at local level and bring out the pros and cons merging the rural local bodies with the urban local bodies.', section: 'Panchayati Raj & Local Government', year: 2024 },
  { questionText: '"The states in India seem reluctant to empower urban local bodies both functionally as well as financially." Comment.', section: 'Panchayati Raj & Local Government', year: 2023 },
  { questionText: 'To what extent, in your opinion, has the decentralisation of power in India changed the governance landscape at the grassroots?', section: 'Panchayati Raj & Local Government', year: 2022 },
  { questionText: "The strength and sustenance of local institutions in India has shifted from their formative phase of 'Functions, Functionaries and Funds' to the contemporary stage of 'Functionality'. Highlight the critical challenges faced by local institutions in terms of their functionality in recent times.", section: 'Panchayati Raj & Local Government', year: 2020 },
  { questionText: '"The reservation of seats for women in the institutions of local self-government has had a limited impact on the patriarchal character of the Indian Political Process." Comment.', section: 'Panchayati Raj & Local Government', year: 2019 },
  { questionText: 'Assess the importance of Panchayat system in India as a part of local government. Apart from government grants, what sources the Panchayats can look out for financing developmental projects.', section: 'Panchayati Raj & Local Government', year: 2018 },
  { questionText: '"The local self-government system in India has not proved to be effective instrument of governance". Critically examine the statement and give your views to improve the situation.', section: 'Panchayati Raj & Local Government', year: 2017 },
  { questionText: "In absence of a well-educated and organized local level government system, `Panchayats' and 'Samitis' have remained mainly political institutions and not effective instruments of governance. Critically discuss.", section: 'Panchayati Raj & Local Government', year: 2015 },
  { questionText: 'To what extent, in your view, the Parliament is able to ensure accountability of the executive in India?', section: P4, year: 2021 },
  { questionText: "Individual Parliamentarian's role as the national lawmaker is on a decline, which in turn, has adversely impacted the quality of debates and their outcome. Discuss.", section: P4, year: 2019 },
  { questionText: 'The Indian Constitution has provisions for holding joint session of the two houses of the Parliament. Enumerate the occasions when this would normally happen and also the occasions when it cannot, with reasons thereof.', section: P4, year: 2017 },
  { questionText: "The 'Powers, Privileges and Immunities of Parliament and its Members' as envisaged in Article 105 of the Constitution leave room for a large number of un-codified and un-enumerated privileges to continue. Assess the reasons for the absence of legal codification of the 'parliamentary privileges'. How can this problem be addressed?", section: P4, year: 2014 },
  { questionText: 'Explain the structure of the Parliamentary Committee system. How far have the financial committees helped in the institutionalization of Indian Parliament?', section: 'Parliamentary Committees', year: 2023 },
  { questionText: 'Do Department-related Parliamentary Standing Committees keep the administration on its toes and inspire reverence for parliamentary control? Evaluate the working of such committees with suitable examples.', section: 'Parliamentary Committees', year: 2021 },
  { questionText: 'Why do you think the committees are considered to be useful for parliamentary work? Discuss, in this context, the role or the Estimates Committee.', section: 'Parliamentary Committees', year: 2018 },
  { questionText: 'Discuss the role of Public Accounts Committee in establishing accountability of the government to the people.', section: 'Parliamentary Committees', year: 2017 },
  { questionText: "Rajya Sabha has been transformed from a 'useless stepney tyre' to the most useful supporting organ in past few decades. Highlight the factors as well as the areas in which this transformation could be visible.", section: P4, year: 2020 },
  { questionText: "Discuss each adjective attached to the word 'Republic' in the preamble. Are they defendable in the present circumstances?", section: P2, year: 2016 },
  { questionText: 'Resorting to ordinances has always raised concern on violation of the spirit of separation of powers doctrine. While noting the rationales justifying the power to promulgate ordinances, analyze whether the decisions of the Supreme Court on the issue have further facilitated resorting to this power. Should the power to promulgate ordinances be repealed?', section: P5, year: 2015 },
  { questionText: "Instances of President's delay in commuting death sentences has come under public debate as denial of justice. Should there be a time limit specified for the President to accept/reject such petitions? Analyse.", section: P5, year: 2014 },
  { questionText: 'What are environmental pressure groups? Discuss their role in raising awareness, influencing policies and advocating for environmental protection in India.', section: 'Pressure Groups', year: 2025 },
  { questionText: '"Pressure groups play a vital role in influencing public policy making in India." Explain how the business associations contribute to public policies.', section: 'Pressure Groups', year: 2021 },
  { questionText: 'What are the methods used by the Farmers organizations to influence the policymakers in India and how effective are these methods?', section: 'Pressure Groups', year: 2019 },
  { questionText: 'How do pressure groups influence Indian political process? Do you agree with this view that informal pressure groups have emerged as powerful than formal pressure groups in recent years?', section: 'Pressure Groups', year: 2017 },
  { questionText: 'Khap Panchayats have been in the news for functioning as extra-constitutional authorities, often delivering pronouncements amounting to human rights violations. Discuss critically the actions taken by the legislative, executive and the judiciary to set the things right in this regard.', section: 'Pressure Groups', year: 2015 },
  { questionText: 'Pressure group politics is sometimes seen as the informal face of politics. With regards to the above, assess the structure and functioning of pressure groups in India.', section: 'Pressure Groups', year: 2013 },
  { questionText: "Do you think that constitution of India does not accept principle of strict separation of powers rather it is based on the principle of 'checks and balance'? Explain.", section: P2, year: 2019 },
  { questionText: 'Discuss the essential conditions for exercise of the legislative powers by the Governor. Discuss the legality of re-promulgation of ordinances by the Governor without placing them before the Legislature.', section: P4, year: 2022 },
  { questionText: 'Explain the constitutional provisions under which Legislative Councils are established. Review the working and current status of Legislative Councils with suitable illustrations.', section: P4, year: 2021 },
  { questionText: 'The most significant achievement of modern law in India in the constitutionalization of environmental problems by the Supreme Court. Discuss this statement with the help of relevant case laws.', section: P5, year: 2022 },
  { questionText: "Critically examine the Supreme Court's judgement on 'National Judicial Appointments Commission Act, 2014' with reference to appointment of judges of higher judiciary in India.", section: P5, year: 2017 },
  { questionText: 'Comment on the need for administrative tribunals as compared to the court system. Assess the impact of the recent tribal reforms through rationalisation of tribunals made in 2021.', section: P6, year: 2025 },
  { questionText: 'Explain and distinguish between Lok Adalats and Arbitration Tribunals. Whether they entertain civil as well as criminal cases?', section: P6, year: 2024 },
  { questionText: 'Who are entitled to receive free legal aid? Assess the role of the National Legal Services Authority (NALSA) in rendering free legal aid in India.', section: P6, year: 2023 },
  { questionText: "What are the major changes brought in the Arbitration and Conciliation Act, 1996 through the recent Ordinance promulgated by the President? How far will it improve India's dispute resolution mechanism? Discuss.", section: P6, year: 2015 },
  { questionText: 'Discuss the nature of Jammu and Kashmir Legislative Assembly after the Jammu and Kashmir Reorganization Act, 2019. Briefly describe the powers and functions of the Assembly of the Union Territory of Jammu and Kashmir.', section: P3, year: 2025 },
  { questionText: 'Discuss the role of the Vice-President of India as the Chairman of the Rajya Sabha.', section: P4, year: 2022 },
  { questionText: "Compare and contrast the President's power to pardon in India and in the USA. Are there any limits to it in both the countries? What are 'preemptive pardons'?", section: 'World Constitutions', year: 2025 },
  { questionText: 'Discuss the evolution of collegium system in India. Critically examine the advantages and disadvantages of the system on appointment of the Judges of the Supreme Court of India and that of the USA.', section: 'World Constitutions', year: 2025 },
  { questionText: 'Discuss India as a secular state and compare with the secular principles of the US constitution.', section: 'World Constitutions', year: 2024 },
  { questionText: 'Compare and contrast the British and Indian approaches to Parliamentary sovereignty.', section: 'World Constitutions', year: 2023 },
  { questionText: 'Critically examine the procedures through which the Presidents of India and France are elected.', section: 'World Constitutions', year: 2022 },
  { questionText: 'Analyze the distinguishing features of the notion of Right to Equality in the Constitutions of the USA and India.', section: 'World Constitutions', year: 2021 },
  { questionText: 'The judicial systems in India and UK seem to be converging as well as diverging in recent times. Highlight the key points of convergence and divergence between the two nations in terms of their judicial practices.', section: 'World Constitutions', year: 2020 },
  { questionText: "What can France learn from the Indian Constitution's approach to secularism?", section: 'World Constitutions', year: 2019 },
  { questionText: 'India and USA are two large democracies. Examine the basic tenets on which the two political systems are based.', section: 'World Constitutions', year: 2018 },

  // ---- from MMF - Governance ----
  { questionText: 'The jurisdiction of the Central Bureau of Investigation (CBI) regarding lodging an FIR and conducting probe within a particular State is being questioned by various States. However, the power of the States to withhold consent to the CBI is not absolute. Explain with special reference to the federal character of India.', section: 'Centre-State Relations', year: 2021 },
  { questionText: 'How have the recommendations of the 14th Finance Commission of India enabled the States to improve their fiscal position?', section: 'Finance Commission', year: 2021 },
  { questionText: 'How is the Finance Commission of India constituted? What do you about the terms of reference of the recently constituted Finance Commission? Discuss.', section: 'Finance Commission', year: 2018 },
  { questionText: 'Discuss the recommendations of the 13th Finance Commission which have been a departure from the previous commissions for strengthening the local government finances.', section: 'Finance Commission', year: 2013 },
  { questionText: 'The National Commission for Protection of Child Rights has to address the challenges faced by children in the digital era. Examine the existing policies and suggest measures the Commission can initiate to tackle the issue.', section: P6, year: 2025 },
  { questionText: '"The duty of the Comptroller and Auditor General is not merely to ensure the legality of expenditure but also its propriety." Comment.', section: P6, year: 2024 },
  { questionText: 'Discuss the role of the Competition Commission of India in containing the abuse of dominant position by the Multi-National Corporations in India. Refer to the recent decisions.', section: P6, year: 2023 },
  { questionText: 'Discuss the role of the National Commission for Backward Classes in the wake of its transformation from a statutory body to a constitutional body.', section: P6, year: 2022 },
  { questionText: 'Though the Human Rights Commissions have contributed immensely to the protection of human rights in India, yet they have failed to assert themselves against the mighty and powerful. Analyzing their structural and practical limitations, suggest remedial measures.', section: P6, year: 2021 },
  { questionText: 'Which steps are required for constitutionalization of a Commission? Do you think imparting constitutionality to the National Commission for Women would ensure greater gender justice and empowerment in India? Give reasons.', section: 'NCW', year: 2020 },
  { questionText: '"The Central Administration Tribunal which was established for redressal of grievances and complaints by or against central government employees, nowadays is exercising its powers as an independent judicial authority." Explain.', section: P6, year: 2019 },
  { questionText: 'The Comptroller and Auditor General (CAG) has a very vital role to play. Explain how this is reflected in the method and terms of his appointment as well as the range of powers he can exercise.', section: P6, year: 2018 },
  { questionText: 'How far do you agree with the view that tribunals curtail the jurisdiction of ordinary courts? In view of the above, discuss the constitutional validity and competency of the tribunals in India.', section: P6, year: 2018 },
  { questionText: 'Multiplicity of various commissions for the vulnerable sections or the society leads to problems or overlapping jurisdiction and duplication of functions. Is it better to merge all commissions into an umbrella Human Rights Commission? Argue your case.', section: P6, year: 2018 },
  { questionText: 'Whether National Commission for Scheduled Castes (NCSC) can enforce the implementation of constitutional reservation for the Scheduled Castes in the religious minority institutions? Examine.', section: P6, year: 2018 },
  { questionText: 'Is the National Commission for Women able to strategize and tackle the problems that women face at both public and private spheres? Give reasons in support of your answer.', section: 'NCW', year: 2017 },
  { questionText: "Exercise of CAG's powers in relation to the accounts of the Union and the States is derived from Article 149 of the Indian Constitution. Discuss whether audit of the Government's Policy implementation could amount to overstepping its own (CAG) jurisdiction.", section: P6, year: 2016 },
  { questionText: 'What is a quasi-judicial body? Explain with the help of concrete examples.', section: P6, year: 2016 },
  { questionText: 'For achieving the desired objectives, it is necessary to ensure that the regulatory institutions remain independent and autonomous. Discuss in the light of the experiences in recent past.', section: P6, year: 2015 },
  { questionText: 'The setting up of a Rail Tariff Authority to regulate fares will subject the cash strapped Indian Railways to demand subsidy for obligation to operate non-profitable routes and services. Taking into account the experience in the power sector, discuss if the proposed reform is expected to benefit the consumers, the Indian Railways or the private container operators.', section: P6, year: 2014 },
  { questionText: 'National Human Rights Commission (NHRC) in India can be most effective when its tasks are adequately supported by other mechanisms that ensure the accountability of a government. In light of the above observation assess the role of NHRC as an effective complement to the judiciary and other institutions in promoting and protecting human rights standards.', section: P6, year: 2014 },
  { questionText: 'The product diversification of financial institutions and insurance companies, resulting in overlapping of products and services strengthens the case for the merger of the two regulatory agencies, namely SEBI and IRDA. Justify.', section: P6, year: 2013 },
  { questionText: "'A national Lokpal, however strong it may be, cannot resolve the problems of immorality in public affairs'. Discuss.", section: P6, year: 2013 },
  { questionText: 'What are the aims and objects of the recently passed and enforced, The Public Examination (Prevention of Unfair Means) Act, 2024? Whether University/State Education Board examinations, too, are covered under the Act?', section: Gv2, year: 2024 },
  { questionText: "Effectiveness of the government system at various levels and people's participation in the governance system are inter-dependent. Discuss their relationship with each other in context of India.", section: Gv2, year: 2016 },
  { questionText: 'In the integrity index of Transparency International, India stands very low. Discuss briefly the legal, political, economic, social and cultural factors that have caused the decline of public morality in India.', section: Gv2, year: 2016 },
  { questionText: 'In the light of the Satyam Scandal, discuss the changes brought in corporate governance to ensure transparency, accountability.', section: Gv2, year: 2015 },
  { questionText: 'If amendment bill to the Whistleblowers Act, 2011 tabled in the Parliament is passed, there may be no one left to protect. Critically evaluate.', section: Gv2, year: 2015 },
  { questionText: '"In contemporary development models, decision-making and problem-solving responsibilities are not located close to the source of information and execution, defeating the objectives of development." Critically evaluate.', section: Gv3, year: 2025 },
  { questionText: "'In the context of neo-liberal paradigm of development planning, multi-level planning is expected to make operations cost effective and remove many implementation blockages.'-Discuss.", section: Gv3, year: 2019 },
  { questionText: "The need for cooperation among various service sector has been an inherent component of development discourse. Partnership bridges bring the gap among the sectors. It also sets in motion a culture of 'Collaboration' and 'team spirit'. In the light of statements above examine India's Development process.", section: Gv3, year: 2019 },
  { questionText: 'Policy contradictions among various competing sectors and stakeholders have resulted in inadequate \'protection and prevention of degradation\' to environment. " Comment with relevant illustration.', section: Gv3, year: 2018 },
  { questionText: 'Has the Indian governmental system responded adequately to the demands of Liberalization, Privatization and Globalization started in 1991? What can the government do to be responsive to this important change?', section: Gv3, year: 2016 },
  { questionText: 'Though 100 percent FDI is already allowed in non-news media like a trade publication and general entertainment channel, the Government is mulling over the proposal for increased FDI in news media for quite some time. What difference would an increase in FDI make? Critically evaluate the pros and cons.', section: Gv3, year: 2014 },
  { questionText: 'The basis of providing urban amenities in rural areas (PURA) is rooted in establishing connectivity. Comment.', section: Gv3, year: 2013 },
  { questionText: "The Citizens'charter has been a land mark initiative in ensuring citizen-centric administration. But it is yet to reach its full potential. Identify the factors hindering the realisation of its promise and suggest measures to overcome them.", section: Gv1, year: 2024 },
  { questionText: "Citizens' Charter is an ideal instrument of organizational transparency and accountability, but it has its own limitations. Identify the limitations and suggest measures for greater effectiveness or the Citizens Charter.", section: Gv1, year: 2018 },
  { questionText: "Though Citizen's charters have been formulated by many public service delivery organizations, there is no corresponding improvement in the level of citizens' satisfaction and quality of services being provided. Analyze.", section: Gv1, year: 2013 },
  { questionText: 'The Doctrine of Democratic Governance makes it necessary that the public perception of the integrity and commitment of civil servants becomes absolutely positive. Discuss.', section: 'Civil Services', year: 2024 },
  { questionText: '"Institutional quality is a crucial driver of economic performance". In this context suggest reforms in Civil Service for strengthening democracy.', section: 'Civil Services', year: 2020 },
  { questionText: 'Initially Civil Services in India were designed to achieve the goals of neutrality and effectiveness, which seems to be lacking in the present context. Do you agree with the view that drastic reforms are required in Civil Services. Comment', section: 'Civil Services', year: 2017 },
  { questionText: 'Traditional bureaucratic structure and culture have hampered the process of socio-economic development in India. Comment.', section: 'Civil Services', year: 2016 },
  { questionText: 'Has the Cadre based Civil Services Organisation been the cause of slow change in India? Critically examine.', section: 'Civil Services', year: 2014 },
  { questionText: 'Civil Society Organizations are often perceived as being anti-State actors rather than non-State actors. Do you agree? Justify.', section: 'Civil Society', year: 2025 },
  { questionText: "Discuss the contribution of civil society groups for women's effective and meaningful participation and representation in state legislatures in India.", section: 'Civil Society', year: 2023 },
  { questionText: 'Can Civil Society and Non-Governmental Organizations present an alternative model of public service delivery to benefit the common citizen? Discuss the challenges of this alternative model.', section: 'Civil Society', year: 2021 },
  { questionText: 'In the Indian governance system, the role of non-state actors has been only marginal. Critically examine this statement.', section: 'Civil Society', year: 2016 },
  { questionText: "Public charitable trusts have the potential to make India's development more inclusive as they relate to certain vital public issues. Comment.", section: Gv3, year: 2024 },
  { questionText: 'Do you agree with the view that increasing dependence on donor agencies for development reduces the importance of community participation in the development process? Justify your answer.', section: Gv3, year: 2022 },
  { questionText: "e-governance is not just about the routine application of digital technology in service delivery process. It is as much about multifarious interactions for ensuring transparency and accountability. In this context evaluate the role of the 'Interactive Service Model' of e-governance.", section: 'e-Governance', year: 2024 },
  { questionText: 'Can the vicious cycle of gender inequality, poverty and malnutrition be broken through microfinancing of women SHGs? Explain with examples.', section: 'SHGs', year: 2021 },
  { questionText: 'How can the role of NGOs be strengthened in India for development works relating to protection of the environment? Discuss throwing light on the major constraints.', section: 'NGOs', year: 2015 },
  { questionText: 'Examine critically the recent changes in the rules governing foreign funding of NGOs under the Foreign Contribution (Regulation) Act (FCRA), 1976.', section: 'NGOs', year: 2015 },
  { questionText: "'The emergence of Self Help Groups(SHGs) in contemporary times points to the slow but steady withdrawal of the state from developmental activities'. Examine the role of the SHGs in developmental activities and the measures taken by the Government of India to promote the SHGs.", section: 'SHGs', year: 2017 },
  { questionText: '"Recent amendments to the Right to Information Act will have profound impact on the autonomy and independence of the Information Commission". Discuss.', section: Gv2, year: 2020 },
  { questionText: "The Self-Help Group (SHG) Bank Linkage Programme (SBLP), which is India's own innovation, has proved to be one of the most effective poverty alleviation and women empowerment programmes. Elucidate.", section: 'SHGs', year: 2015 },
  { questionText: '"Micro-Finance as an anti-poverty vaccine, is aimed at asset creation and income security of the rural poor in India". Evaluate the role of Self Help Groups in achieving the twin objectives along with empowering women in rural India.', section: 'SHGs', year: 2020 },
  { questionText: 'The penetration of Self Help Groups (SHGs) in rural areas in promoting participation in development programmes is facing socio-cultural hurdles. Examine.', section: 'SHGs', year: 2014 },
  { questionText: 'The legitimacy and accountability of Self Help Groups (SHGs) and their patrons, the micro-finance outfits, need systematic assessment and scrutiny for the sustained success of the concept. Discuss.', section: 'SHGs', year: 2013 },
  { questionText: 'E-governance projects have a built-in bias towards technology and back-end integration than user-centric designs. Examine.', section: 'e-Governance', year: 2025 },
  { questionText: 'e-governance, as a critical tool of governance, has ushered in effectiveness, transparency and accountability in governments. What inadequacies hamper the enhancement of these features?', section: 'e-Governance', year: 2023 },
  { questionText: 'The Gati-Shakti Yojana needs meticulous coordination between the government and the private sector to achieve the goal of connectivity. Discuss.', section: 'e-Governance', year: 2022 },
  { questionText: 'Reforming the government delivery system through the Direct Benefit Transfer Scheme is a progressive step, but it has its limitations too. Comment.', section: 'e-Governance', year: 2022 },
  { questionText: 'Has digital illiteracy, particularly in rural areas, coupled with lack of Information and Communication Technology (ICT) accessibility hindered socio-economic development? Examine with justification.', section: 'e-Governance', year: 2021 },
  { questionText: '"The emergence of Fourth Industrial Revolution (Digital Revolution) has initiated e-Governance as an integral part of government". Discuss.', section: 'e-Governance', year: 2020 },
  { questionText: 'Implementation of information and Communication Technology (ICT) based Projects / Programmes usually suffers in terms of certain vital factors. Identify these factors, and suggest measures for their effective implementation.', section: 'e-Governance', year: 2019 },
  { questionText: "E-Governance is not only about utilization of the power of new technology, but also much about critical importance of the 'use value' of information Explain.", section: 'e-Governance', year: 2018 },
  { questionText: 'Two parallel run schemes of the Government viz. the Adhaar Card and NPR, one as voluntary and the other as compulsory, have led to debates at national levels and also litigations. On merits, discuss whether or not both schemes need run concurrently. Analyse the potential of the schemes to achieve developmental benefits and equitable growth.', section: 'e-Governance', year: 2014 },
  { questionText: 'Electronic cash transfer system for the welfare schemes is an ambitious project to minimize corruption, eliminate wastage and facilitate reforms. Comment.', section: 'e-Governance', year: 2013 },

  // ---- from MMF-Social Justice ----
  { questionText: 'Besides the welfare schemes, India needs deft management of inflation and unemployment to serve the poor and the underprivileged sections of the society. Discuss.', section: SJ1, year: 2022 },
  { questionText: "'Poverty Alleviation Programmes in India remain mere show pieces until and unless they are backed by political will'. Discuss with reference to the performance of the major poverty alleviation programmes in India.", section: SJ1, year: 2017 },
  { questionText: 'Hunger and Poverty are the biggest challenges for good governance in India still today. Evaluate how far successive governments have progressed in dealing with these humongous problems. Suggest measures for improvement.', section: SJ2, year: 2017 },
  { questionText: 'Though there have been several different estimates of poverty in India, all indicate reduction in poverty levels over time. Do you agree? Critically examine with reference to urban and rural poverty indicators.', section: SJ2, year: 2015 },
  { questionText: 'The concept of Mid Day Meal (MDM) scheme is almost a century old in India with early beginnings in Madras Presidency in pre-independent India. The scheme has again been given impetus in most states in the last two decades. Critically examine its twin objectives, latest mandates and success.', section: SJ2, year: 2013 },
  { questionText: "'To ensure effective implementation of policies addressing water, sanitation and hygiene needs, the identification of beneficiary segments is to be synchronized with the anticipated outcomes' Examine the statement in the context of the WASH scheme.", section: SJ1, year: 2017 },
  { questionText: 'Identify the Millennium Development Goals (MDGs) that are related to health. Discuss the success of the actions taken by the Government for achieving the same.', section: SJ2, year: 2013 },
  { questionText: 'Should the premier institutes like IITs/IIMs be allowed to retain premier status, allowed more academic independence in designing courses and also decide mode/criteria of selection of students. Discuss in light of the growing challenges.', section: SJ2, year: 2014 },
  { questionText: "Women's social capital complements in advancing empowerment and gender equity. Explain.", section: SJ1, year: 2025 },
  { questionText: '"Development and welfare schemes for the vulnerable, by its nature, are discriminatory in approach." Do you agree? Give reasons for your answer.', section: SJ1, year: 2023 },
  { questionText: '"Though women in post-Independent India have excelled in various fields, the social attitude towards women and feminist movement has been patriarchial." Apart from women education and women empowerment schemes, what interventions can help change this milieu?', section: SJ1, year: 2021 },
  { questionText: 'Performance of welfare schemes that are implemented for vulnerable sections is not so effective due to absence of their awareness and active involvement at all stages of policy process – Discuss.', section: SJ1, year: 2019 },
  { questionText: 'Professor Amartya Sen has advocated important reforms in the realms of primary education and primary health care. What are your suggestions to improve their status and performance?', section: SJ2, year: 2016 },
  { questionText: 'Examine the main provisions of the National Child Policy and throw light on the status of its implementation.', section: SJ1, year: 2016 },
  { questionText: "Do government's schemes for up-lifting vulnerable and backward communities by protecting required social resources for them, lead to their exclusion in establishing businesses in urban economics?", section: SJ1, year: 2014 },
  { questionText: "An athlete participates in Olympics for personal triumph and nation's glory; victors are showered with cash incentives by various agencies, on their return. Discuss the merit of state sponsored talent hunt and its cultivation as against the rationale of a reward mechanism as encouragement.", section: SJ2, year: 2014 },
  { questionText: 'The Central Government frequently complains on the poor performance of the State Governments in eradicating suffering of the vulnerable sections of the society. Restructuring of Centrally sponsored schemes across the sectors for ameliorating the cause of vulnerable sections of population aims at providing flexibility to the States in better implementation. Critically evaluate.', section: SJ1, year: 2013 },
  { questionText: 'Demographic Dividend in India will remain only theoretical unless our manpower becomes more educated, aware, skilled and creative. What measures have been taken by the government to enhance the capacity of our population to be more productive and employable?', section: SJ2, year: 2016 },
  { questionText: 'The Rights of Persons with Disabilities Act, 2016 remains only a legal document without intense sensitisation of government functionaries and citizens regarding disability. Comment.', section: SJ1, year: 2022 },
  { questionText: 'Does the Rights of Persons with Disabilities Act, 2016 ensure effective mechanism for empowerment and inclusion of the intended beneficiaries in the society? Discuss', section: SJ1, year: 2017 },
  { questionText: "The Right of Children to Free and Compulsory Education Act, 2009 remains inadequate in promoting incentive-based system for children's education without generating awareness about the importance of schooling. Analyse.", section: SJ2, year: 2022 },
  { questionText: 'The quality of higher education in India requires major improvements to make it internationally competitive. Do you think that the entry of foreign educational institutions would help improve the quality of higher and technical education in the country? Discuss.', section: SJ2, year: 2015 },
  { questionText: 'There is a growing divergence in the relationship between poverty and hunger in India. The shrinking of social expenditure by the government is forcing the poor to spend more on Non-Food essential items squeezing their food – budget. Elucidate.', section: 'Hunger', year: 2019 },
  { questionText: 'How far do you agree with the view that the focus on lack of availability of food as the main cause of hunger takes the attention away from ineffective human development policies in India?', section: 'Hunger', year: 2018 },
  { questionText: 'Despite Consistent experience of High growth, India still goes with the lowest indicators of human development. Examine the issues that make balanced and inclusive development elusive.', section: SJ2, year: 2019 },
  { questionText: 'In a crucial domain like the public healthcare system, the Indian State should play a vital role to contain the adverse impact of marketisation of the system. Suggest some measures through which the State can enhance the reach of public healthcare at the grassroots level.', section: SJ2, year: 2024 },
  { questionText: "Inequality in the ownership pattern of resources is one of the major causes of poverty. Discuss in the context of 'paradox of poverty'.", section: 'Multidimensional Poverty', year: 2025 },
  { questionText: '"The incidence and intensity of poverty are more important in determining poverty based on income alone". In this context analyse the latest United Nations Multidimensional Poverty Index Report.', section: 'Multidimensional Poverty', year: 2020 },
  { questionText: 'National Education Policy 2020 is in conformity with the Sustainable Development Goal-4. It intends to restructure and reorient education system in India. Critically examine the statement.', section: 'NEP 2020', year: 2020 },
  { questionText: 'Poverty and malnutrition create a vicious cycle, adversely affecting human capital formation. What steps can be taken to break the cycle?', section: 'Poverty-Malnutrition Cycle', year: 2024 },
  { questionText: '"Besides being a moral imperative of a Welfare State, primary health structure is a necessary precondition for sustainable development." Analyse.', section: SJ2, year: 2021 },
  { questionText: "Appropriate local community-level healthcare intervention is a prerequisite to achieve 'Health for All' in India. Explain.", section: SJ2, year: 2018 },
  { questionText: 'In order to enhance the prospects of social development, sound and adequate health care policies are needed particularly in the fields of geriatric and maternal health care. Discuss.', section: SJ2, year: 2020 },
  { questionText: 'Public health system has limitations in providing universal health coverage. Do you think that the private sector could help in bridging the gap? What other viable alternatives would you suggest?', section: SJ2, year: 2015 },
  { questionText: 'The crucial aspect of development process has been the inadequate attention paid to Human Resource Development in India. Suggest measures that can address this adequacy.', section: SJ2, year: 2023 },
  { questionText: 'Skill development programs have succeed in increasing human resources supply to various sectors. In the context of the statement analyze the linkages between education, skill and employment.', section: SJ2, year: 2023 },
  { questionText: "'Earn while you learn' scheme needs to be strengthened to make vocational education and skill training meaningful.\" Comment.", section: SJ2, year: 2021 },

  // ---- from MMF - International Relations ----
  { questionText: "The newly tri-nation partnership AUKUS is aimed at countering China's ambitions in the Indo-Pacific region. Is it going to supersede the existing partnerships in the region? Discuss the strength and impact of AUKUS in the present scenario.", section: 'Quad;AUKUS', year: 2021 },
  { questionText: 'India–Africa digital partnership is achieving mutual respect, co-development and long-term institutional partnerships. Elaborate.', section: IR2, year: 2025 },
  { questionText: "'If the last few decades were of Asia's growth story, the next few are expected to be of Africa's.' In the light of this statement, examine India's influence in Africa in recent years.", section: IR2, year: 2021 },
  { questionText: 'Increasing interest of India in Africa has its pros and cons. Critically examine.', section: IR2, year: 2015 },
  { questionText: 'Do you think that BIMSTEC is a parallel organisation like the SAARC? What are the similarities and dissimilarities between the two? How are Indian foreign policy objectives realized by forming this new organisation?', section: IR2, year: 2022 },
  { questionText: 'The protests in Shahbag Square in Dhaka in Bangladesh reveal a fundamental split in society between the nationalists and Islamic forces. What is its significance for India?', section: 'Bangladesh', year: 2013 },
  { questionText: "Critically analyse India's evolving diplomatic, economic and strategic relations with the Central Asian Republics (CARs) highlighting their increasing significance in regional and global geopolitics.", section: IR2, year: 2024 },
  { questionText: "A number of outside powers have entrenched themselves in Central Asia, which is a zone of interest to India. Discuss the implications, in this context, of India's joining the Ashgabat Agreement, 2018.", section: IR2, year: 2018 },
  { questionText: "Project 'Mausam' is considered a unique foreign policy initiative of the Indian Government to improve relationship with its neighbors. Does the project have a strategic dimension? Discuss.", section: IR1, year: 2015 },
  { questionText: 'Discuss the political developments in Maldives in the last two years. Should they be of any cause of concern to India?', section: IR1, year: 2013 },
  { questionText: "Discuss the geopolitical and geostrategic importance of Maldives for India with a focus on global trade and energy flows. Further also discuss how this relationship affects India's maritime security and regional stability amidst international competition?", section: IR1, year: 2024 },
  { questionText: "'The expansion and strengthening of NATO and a stronger US-Europe strategic partnership works well in India.' What is your opinion about this statement? Give reasons and examples to support your answer.", section: IR2, year: 2023 },
  { questionText: "How will I2U2 (India, Israel, UAE and USA) grouping transform India's position in global politics?", section: IR2, year: 2022 },
  { questionText: "What introduces friction into the ties between India and the United States is that Washington is still unable to find for India a position in its global strategy, which would satisfy India's National self-esteem and ambitions. Explain with suitable examples.", section: IR2, year: 2019 },
  { questionText: "'The time has come for India and Japan to build a strong contemporary relationship, one involving global and strategic partnership that will have a great significance for Asia and the world as a whole.' Comment.", section: IR2, year: 2019 },
  { questionText: "India's relations with Israel have, of late, acquired a depth and diversity, which cannot be rolled back. Discuss.", section: IR2, year: 2018 },
  { questionText: 'With respect to the South China sea, maritime territorial disputes and rising tension affirm the need for safeguarding maritime security to ensure freedom of navigation and over flight throughout the region. In this context, discuss the bilateral issues between India and China.', section: 'China', year: 2014 },
  { questionText: 'Economic ties between India and Japan, while growing in recent years, are still far below their potential. Elucidate the policy constraints which are inhibiting this growth.', section: IR2, year: 2013 },
  { questionText: 'With the waning of globalization, post-Cold War world is becoming a site of sovereign nationalism. Elucidate.', section: 'Sovereign Nationalism', year: 2025 },
  { questionText: "'The USA is facing an existential threat in the form of a China, that is much more challenging than the erstwhile Soviet Union.' Explain.", section: IR3, year: 2021 },
  { questionText: "'The long-sustained image of India as a leader of the oppressed and marginalised Nations has disappeared on account of its new found role in the emerging global order'. Elaborate.", section: IR3, year: 2019 },
  { questionText: "What do you understand by 'The String of Pearls'? How does it impact India? Briefly outline the steps taken by India to counter this.", section: IR1, year: 2013 },
  { questionText: 'The proposed withdrawal of International Security Assistance Force (ISAF) from Afghanistan in 2014 is fraught with major security implications for the countries of the region. Examine in light of the fact that India is faced with a plethora of challenges and needs to safeguard its own strategic interests.', section: 'Afghanistan', year: 2013 },
  { questionText: "'Sea is an important Component of the Cosmos'. Discuss in the light of the above statement the role of the IMO (International Maritime Organisation) in protecting environment and enhancing maritime safety and security.", section: 'IMO', year: 2023 },
  { questionText: "'Too little cash, too much politics, leaves UNESCO fighting for life.' Discuss the statement in the light of US' withdrawal and its accusation of the cultural body as being 'anti-Israel bias'.", section: IR3, year: 2019 },
  { questionText: "What are the key areas of reform if the WTO has to survive in the present context of 'Trade War', especially keeping in mind the interest of India?", section: 'WTO', year: 2018 },
  { questionText: 'What are the main functions of the United Nations Economic and Social Council (ECOSOC)? Explain different functional commissions attached to it.', section: IR3, year: 2017 },
  { questionText: "What are the aims and objectives of the McBride Commission of the UNESCO? What is India's position on these?", section: IR3, year: 2016 },
  { questionText: 'The broader aims and objectives of WTO are to manage and promote international trade in the era of globalization. But the Doha round of negotiations seem doomed due to differences between the developed and the developing countries. Discuss in the Indian perspective.', section: 'WTO', year: 2016 },
  { questionText: 'India has recently signed to become founding a New Development Bank (NDB) and also the Asian Infrastructure Investment Bank (AIIB). How will the role of the two Banks be different? Discuss the significance of these two Banks for India.', section: IR3, year: 2014 },
  { questionText: 'Some of the International funding agencies have special terms for economic participation stipulating a substantial component of the aid to be used for sourcing equipment from the leading countries. Discuss on merits of such terms and if, there exists a strong case not to accept such conditions in the Indian context.', section: IR3, year: 2014 },
  { questionText: 'The aim of Information Technology Agreements (ITAs) is to lower all taxes and tariffs on information technology products by signatories to zero. What impact should such agreements have on India\'s interests?', section: IR3, year: 2014 },
  { questionText: "WTO is an important international institution where decisions taken affect countries in profound manner. What is the mandate of WTO and how binding are their decisions? Critically analyse India's stand on the latest round of talks on Food security.", section: 'WTO', year: 2014 },
  { questionText: "'China is using its economic relations and positive trade surplus as tools to develop potential military power status in Asia', In the light of this statement, discuss its impact on India as her neighbor.", section: 'China', year: 2017 },
  { questionText: "Energy security constitutes the dominant kingpin of India's foreign policy, and is linked with India's overarching influence in Middle Eastern countries. How would you integrate energy security with India's foreign policy trajectories in the coming years?", section: 'Energy Security', year: 2025 },
  { questionText: "Clean energy is the order of the day. Describe briefly India's changing policy towards climate change in various international fora in the context of geopolitics.", section: 'Energy Security', year: 2022 },
  { questionText: "The question of India's Energy Security constitutes the most important part of India's economic progress. Analyze India's energy policy cooperation with West Asian Countries.", section: 'Energy Security', year: 2017 },
  { questionText: 'What is meant by Gujral doctrine? Does it have any relevance today? Discuss.', section: IR1, year: 2013 },
  { questionText: "The World Bank and the IMF, collectively known as the Bretton Woods Institutions, are the two inter-governmental pillars supporting the structure of the world's economic and financial order. Superficially, the World Bank and the IMF exhibit many common characteristics, yet their role, functions and mandate are distinctly different. Elucidate.", section: IR3, year: 2013 },
  { questionText: 'Indian diaspora has scaled new heights in the West. Describe its economic and political benefits for India.', section: 'Indian Diaspora', year: 2023 },
  { questionText: "'Indian diaspora has a decisive role to play in the politics and economy of America and European Countries'. Comment with examples.", section: 'Indian Diaspora', year: 2020 },
  { questionText: "Indian Diaspora has an important role to play in South-East Asian countries' economy and society. Appraise the role of Indian Diaspora in South-East Asia in this context.", section: 'Indian Diaspora', year: 2017 },
  { questionText: "Evaluate the economic and strategic dimensions of India's Look East Policy in the context of the post-Cold War international scenario.", section: IR2, year: 2016 },
  { questionText: "'Quadrilateral Security Dialogue (Quad)' is transforming itself into a trade bloc from a military alliance, in present times - Discuss.", section: 'Quad;AUKUS', year: 2020 },
  { questionText: 'What is the significance of Indo-US defence deals over Indo-Russian defence deals? Discuss with reference to stability in the Indo-Pacific region.', section: IR2, year: 2020 },
  { questionText: 'Increasing cross-border terrorist attacks in India and growing interference in the internal affairs of several member-states by Pakistan are not conducive for the future of SAARC (South Asian Association for Regional Cooperation). Explain with suitable examples.', section: IR2, year: 2016 },
  { questionText: "'Virus of Conflict is affecting the functioning of the SCO'. In the light of the above statement point out the role of India in mitigating problems.", section: IR2, year: 2023 },
  { questionText: 'Critically examine the aims and objectives of SCO. What importance does it hold for India?', section: IR2, year: 2021 },
  { questionText: 'Terrorist activities and mutual distrust have clouded India-Pakistan relations. To what extent the use of soft power like sports and cultural exchanges could help generate goodwill between the two countries? Discuss with suitable examples.', section: IR1, year: 2015 },
  { questionText: "India is an age-old friend of Sri Lanka.' Discuss India's role in the recent crisis in Sri Lanka in the light of the preceding statement.", section: IR1, year: 2022 },
  { questionText: 'In respect of India-Sri Lanka relations, discuss how domestic factors influence foreign policy.', section: IR1, year: 2013 },
  { questionText: "'The reform process in the United Nations remains unresolved, because of the delicate imbalance of East and West and entanglement of the USA vs. Russo-Chinese alliance.' Examine and critically evaluate the East-West policy confrontations in this regard.", section: IR3, year: 2025 },
  { questionText: "Terrorism has become a significant threat to global peace and security'. Evaluate the effectiveness of the United Nations Security Council's Counter-Terrorism Committee (CTC) and its associated bodies in addressing and mitigating this threat at the international level.", section: IR3, year: 2024 },
  { questionText: 'Discuss the impediments India is facing in its pursuit of a permanent seat in UN Security Council.', section: IR3, year: 2015 },
  { questionText: 'In what ways would the ongoing US-Iran Nuclear Pact Controversy affect the national interest of India? How should India respond to this situation?', section: IR2, year: 2018 },
  { questionText: 'Critically examine the role of WHO in providing global health security during the Covid-19 pandemic.', section: IR3, year: 2020 },
  { questionText: "The West is fostering India as an alternative to reduce dependence on China's supply chain and as a strategic ally to counter China's political and economic dominance.' Explain this statement with examples.", section: 'West Fostering India', year: 2024 }
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

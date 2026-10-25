// One-time import of Progress checklist + PYQ data for the "Mains Master File - Ethics" file
// inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index has 3 levels (Part -> X.Y sub-section -> X.Y.Z sub-sub-heading), each with its
// own page number. Both the X.Y and X.Y.Z levels are imported as checklist Questions (Topic =
// Part) since collapsing to only the leaf level would have thrown away real page numbers and
// meaningful standalone headings (e.g. "3.6 Moral Thinkers & Quotes" is a useful checkable item
// in its own right, not just a container for its 11 named-thinker children).
//
// `tag` values are short, clean, human-readable labels - NOT verbatim copies of the source
// PYQ document's "X x Y" microtheme jargon - because tag is rendered to students as a visible
// pill badge under each checklist row (see ProgressSection.jsx splitTagDisplay), and PYQ
// `section` is rendered as the group header in the PYQ side panel. Every PYQ's `section` reuses
// one of these same canonical labels so it matches its checklist row via tagMatcher.js's
// substring comparison. Thinkers quoted in PYQs with no dedicated TOC leaf (e.g. Abdul Kalam,
// Socrates, Kautilya) fall back to the "Moral Thinkers & Quotes" mid-level row's tag rather than
// getting their own noisy one-off badge.
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
const TARGET_FILE_NAME = 'Mains Master File - Ethics';

const P1 = 'Part 1: Ethics and Human Interface';
const P2 = 'Part 2: Attitude';
const P3 = 'Part 3: Aptitude and Foundational Values for Civil Service';
const P4 = 'Part 4: Civil Service Values & Ethics in Public Administration';
const P5 = 'Part 5: Probity in Governance';

const CHECKLIST_ROWS = [
  { topicName: P1, questionText: '1.1 Essence, Determinants & Consequences of Ethics', pageNumber: 2, tag: 'Essence of Ethics;Determinants of Ethics;Consequences of Ethics;Nature of Values' },
  { topicName: P1, questionText: '1.1.1 Values and Ethics – Importance with Professional Competence', pageNumber: 2, tag: '' },
  { topicName: P1, questionText: '1.1.2 Legal Compliance vs Ethical Behaviour', pageNumber: 2, tag: '' },
  { topicName: P1, questionText: '1.1.3 Ethics vs Law – Conflict and Relationship', pageNumber: 3, tag: '' },
  { topicName: P1, questionText: '1.1.4 Ethics as Foundation for Social Cohesion & Just Society', pageNumber: 4, tag: '' },
  { topicName: P1, questionText: '1.2 Human Values – Lessons from Lives of Great Leaders, Reformers, Administrators', pageNumber: 4, tag: 'Great Leaders;Crisis of Values' },
  { topicName: P1, questionText: '1.2.1 Nelson Mandela – Lessons for Administrators on Social Divisions', pageNumber: 4, tag: '' },
  { topicName: P1, questionText: '1.2.2 Pandita Ramabai – Lessons and Contemporary Relevance', pageNumber: 5, tag: '' },
  { topicName: P1, questionText: '1.2.3 Arya Samaj – Ethical Lessons for Present-Day India', pageNumber: 6, tag: '' },
  { topicName: P1, questionText: "1.2.4 Gandhiji's Philosophy of Means and Ends", pageNumber: 6, tag: 'Means vs Ends' },
  { topicName: P1, questionText: "1.2.5 Rights vs Duties – 'A Man Can Give Up a Right, But Not a Duty' (Gandhi)", pageNumber: 7, tag: '' },
  { topicName: P1, questionText: '1.3 Role of Family, Society, Educational Institutions in Inculcating Values', pageNumber: 7, tag: '' },
  { topicName: P1, questionText: '1.3.1 Role of Family, Society & Educational Establishments in Value Development', pageNumber: 8, tag: 'Educational Institutions' },
  { topicName: P1, questionText: "1.3.2 Role of Parents in Shaping Children's Value Orientation", pageNumber: 9, tag: '' },
  { topicName: P1, questionText: '1.3.3 Ethics Cannot Be Taught, It Must Be Cultivated – Role of Society', pageNumber: 9, tag: '' },
  { topicName: P1, questionText: '1.3.4 Religion & Development of Moral Values', pageNumber: 10, tag: '' },
  { topicName: P1, questionText: '1.3.5 Ethics in Public Life Grounded in Ethics in Private Life', pageNumber: 11, tag: 'Ethics in Public & Private Life' },

  { topicName: P2, questionText: '2.1 Content, Structure, Function; Influence on Thought & Behaviour', pageNumber: 12, tag: '' },
  { topicName: P2, questionText: '2.1.1 Attitude – Definition & Key Components', pageNumber: 12, tag: '' },
  { topicName: P2, questionText: '2.1.2 Attitude vs Aptitude & Expected Attitude of Civil Servants', pageNumber: 12, tag: 'Attitude of Civil Servants' },
  { topicName: P2, questionText: '2.1.3 Bureaucratic Attitude vs Democratic Attitude in Public Services', pageNumber: 13, tag: 'Bureaucratic vs Democratic Attitude;Practical Intelligence;Organisational Attitude' },
  { topicName: P2, questionText: '2.2 Moral & Political Attitudes; Social Influence and Persuasion', pageNumber: 14, tag: 'Political Attitude' },
  { topicName: P2, questionText: '2.2.1 Factors Affecting Attitude Formation Towards Social Problems', pageNumber: 14, tag: 'Attitude of Individuals' },
  { topicName: P2, questionText: '2.2.2 Persuasion – Definition & Elements of Effective Approach', pageNumber: 14, tag: 'Persuasion' },

  { topicName: P3, questionText: '3.1 Integrity, Impartiality, Non-partisanship', pageNumber: 16, tag: 'Integrity' },
  { topicName: P3, questionText: '3.1.1 Three Basic Values of Civil Services – Integrity, Impartiality, Commitment to Public Service', pageNumber: 16, tag: 'Foundational Values' },
  { topicName: P3, questionText: '3.1.2 Key Ethics Terms – Integrity, Impartiality, Objectivity, Codes', pageNumber: 17, tag: 'Key Ethics Terms' },
  { topicName: P3, questionText: '3.1.3 Political Neutrality of Civil Servants – Importance & Challenges', pageNumber: 17, tag: 'Impartiality' },
  { topicName: P3, questionText: '3.1.4 Political Interference and Civil Service Neutrality', pageNumber: 18, tag: 'Impartiality' },
  { topicName: P3, questionText: '3.2 Objectivity, Dedication to Public Service', pageNumber: 19, tag: 'Civil Service Values' },
  { topicName: P3, questionText: '3.2.1 Public Interest – Principles & Procedures for Civil Servants', pageNumber: 19, tag: 'Public Interest' },
  { topicName: P3, questionText: '3.2.2 Public Services Code – 2nd Administrative Reforms Commission Recommendations', pageNumber: 20, tag: 'Public Services Code' },
  { topicName: P3, questionText: '3.2.3 Public Service vs Public Employment – Distinction & Importance for Ethical Governance', pageNumber: 21, tag: 'Civil Service Values' },
  { topicName: P3, questionText: '3.2.4 Devotion to Duty – Sense of Responsibility & Personal Fulfilment as Civil Servant', pageNumber: 22, tag: 'Devotion to Duty;Trustworthiness' },
  { topicName: P3, questionText: '3.2.5 Civil Servant as Enabler & Facilitator of Holistic Development', pageNumber: 22, tag: 'Enabler and Facilitator' },
  { topicName: P3, questionText: '3.3 Empathy, Tolerance and Compassion towards Weaker Sections', pageNumber: 23, tag: 'Empathy & Compassion' },
  { topicName: P3, questionText: '3.3.1 Empathy & Compassion as Indispensable Qualities of a Civil Servant', pageNumber: 23, tag: 'Empathy & Compassion' },
  { topicName: P3, questionText: '3.3.2 Empathy vs Compassion & Role in Civil Services', pageNumber: 24, tag: 'Empathy & Compassion' },
  { topicName: P3, questionText: '3.3.3 Compassion in Governance as Administrative Wisdom', pageNumber: 24, tag: 'Empathy & Compassion' },
  { topicName: P3, questionText: '3.4 Emotional Intelligence – Concepts and Utility', pageNumber: 25, tag: 'Emotional Intelligence' },
  { topicName: P3, questionText: '3.4.1 Emotional Intelligence (EI) – Definition & Role in Administration', pageNumber: 25, tag: 'EI in Administration' },
  { topicName: P3, questionText: '3.4.2 Emotional Intelligence (EI) – Key Determinant of Personal & Professional Success', pageNumber: 26, tag: 'Emotional Intelligence' },
  { topicName: P3, questionText: '3.4.3 Emotional Intelligence Training & Citizen-Centric Policing', pageNumber: 27, tag: 'EI in Administration' },
  { topicName: P3, questionText: '3.4.4 Emotional Intelligence (EQ) vs IQ for Leadership', pageNumber: 27, tag: 'EQ vs IQ' },
  { topicName: P3, questionText: '3.4.5 Emotional Intelligence (EI) – Enhancing Leadership, Collaboration, and Conflict Resolution', pageNumber: 28, tag: 'Emotional Intelligence' },
  { topicName: P3, questionText: '3.5 Conscience as Source of Ethical Guidance', pageNumber: 29, tag: 'Conscience' },
  { topicName: P3, questionText: '3.5.1 Conscience vs Laws & Regulations as Guide for Ethical Decision-Making', pageNumber: 29, tag: 'Laws & Conscience' },
  { topicName: P3, questionText: '3.6 Moral Thinkers & Quotes', pageNumber: 30, tag: 'Moral Thinkers & Quotes' },
  { topicName: P3, questionText: "3.6.1 Aristotle's Quote – Excellence as Habit", pageNumber: 30, tag: 'Aristotle' },
  { topicName: P3, questionText: "3.6.2 Mother Teresa's Quote – Small Things with Great Love", pageNumber: 31, tag: '' },
  { topicName: P3, questionText: "3.6.3 Einstein's Quote – Peace Through Understanding", pageNumber: 31, tag: '' },
  { topicName: P3, questionText: '3.6.4 Tagore Quote – Transforming Adversity into Opportunity', pageNumber: 32, tag: '' },
  { topicName: P3, questionText: "3.6.5 'Experience is the only teacher we have' - Swami Vivekananda", pageNumber: 33, tag: 'Swami Vivekananda' },
  { topicName: P3, questionText: "3.6.6 'The price good men pay for indifference to public affairs is to be ruled by evil men.' - Plato", pageNumber: 34, tag: 'Plato' },
  { topicName: P3, questionText: "3.6.7 'A human being can alter his life by altering his attitudes.' - William James", pageNumber: 35, tag: 'William James' },
  { topicName: P3, questionText: "3.6.8 'Love and Compassion are Pillars of World Peace' - Dalai Lama", pageNumber: 36, tag: 'Dalai Lama' },
  { topicName: P3, questionText: "3.6.9 'Justice is the Constant and Perpetual Will to Render to Each His Due' - Cicero", pageNumber: 36, tag: '' },
  { topicName: P3, questionText: "3.6.10 'The Man Who Moves a Mountain Begins by Carrying Away Small Stones' - Confucius", pageNumber: 37, tag: '' },
  { topicName: P3, questionText: "3.6.11 'Democracy is Not a Form of Government, But a Form of Social Organisation' - Dr. B.R. Ambedkar", pageNumber: 37, tag: '' },
  { topicName: P3, questionText: '3.7 Other Foundational/Ethical Concepts', pageNumber: 38, tag: '' },
  { topicName: P3, questionText: '3.7.1 Universal Rights – Why Some Rights are Universal', pageNumber: 38, tag: '' },
  { topicName: P3, questionText: '3.7.2 Is Lying Always Morally Wrong?', pageNumber: 39, tag: '' },
  { topicName: P3, questionText: '3.7.3 Ethical Dilemma – Definition & Examples for Civil Servants', pageNumber: 39, tag: 'Ethical Dilemma' },
  { topicName: P3, questionText: '3.7.4 Leadership as a Foundational Value in Public Services', pageNumber: 40, tag: '' },
  { topicName: P3, questionText: '3.7.5 Emerging Technologies & Risk to Human Thinking', pageNumber: 41, tag: 'Ethics & Technology' },

  { topicName: P4, questionText: '4.1 Ethical Concerns in International Relations / Funding', pageNumber: 42, tag: 'International Relations Ethics' },
  { topicName: P4, questionText: '4.1.1 International Sanctions and Conditional Aid – Ethical Responsibilities', pageNumber: 42, tag: 'International Relations Ethics' },
  { topicName: P4, questionText: '4.1.2 Israel-Hamas Conflict – Key Ethical Issues', pageNumber: 42, tag: 'International Relations Ethics' },
  { topicName: P4, questionText: '4.2 Laws, Rules, Regulations as Sources of Ethical Guidance; Corruption', pageNumber: 43, tag: 'Laws & Conscience' },
  { topicName: P4, questionText: '4.2.1 Code of Conduct vs Code of Ethics in Public Administration', pageNumber: 43, tag: 'Code of Ethics' },
  { topicName: P4, questionText: '4.2.2 Corruption – Why It Persists & Role of Value Systems', pageNumber: 44, tag: 'Corruption' },
  { topicName: P4, questionText: '4.3 Accountability and Ethical Governance', pageNumber: 44, tag: 'Ethical Governance' },
  { topicName: P4, questionText: '4.3.1 Ethical Governance – Meaning & Measures', pageNumber: 44, tag: 'Ethical Governance;Constitutional Morality;Public Funds' },
  { topicName: P4, questionText: '4.3.2 Quality of Service in Governance – Parameters', pageNumber: 45, tag: 'Quality of Service' },
  { topicName: P4, questionText: '4.3.3 Work Culture – Public vs Private Sector', pageNumber: 46, tag: 'Work Culture' },
  { topicName: P4, questionText: '4.3.4 Ethical Work Culture – Value-based & Compliance-based Measures', pageNumber: 47, tag: 'Work Culture' },
  { topicName: P4, questionText: '4.3.5 Compliance vs Internalisation in Ethical Governance', pageNumber: 47, tag: 'Ethical Governance' },
  { topicName: P4, questionText: '4.3.6 News Fatigue – Strategies to Ethically Re-engage Citizens', pageNumber: 48, tag: '' },
  { topicName: P4, questionText: '4.3.7 Misinformation as a Governance Failure – Role of Transparency Deficits', pageNumber: 49, tag: '' },
  { topicName: P4, questionText: '4.4 Strengthening of Ethical & Moral Values in Governance', pageNumber: 49, tag: 'Ethical Governance' },
  { topicName: P4, questionText: '4.4.1 Social Audits – Participatory and Accountable Governance', pageNumber: 50, tag: 'Ethical Governance' },
  { topicName: P4, questionText: "4.4.2 Citizen's Charters – Transforming Citizens from Passive Recipients to Rights-Bearing Stakeholders", pageNumber: 50, tag: 'Citizens Charter' },
  { topicName: P4, questionText: '4.4.3 Section 44(3) DPDPA 2023 – Impact on RTI Framework', pageNumber: 51, tag: 'RTI' },
  { topicName: P4, questionText: '4.5 Ethics in Private/Corporate Institutions', pageNumber: 52, tag: 'Corporate Governance' },
  { topicName: P4, questionText: '4.5.1 Corporate Governance vs Ethical Culture', pageNumber: 52, tag: 'Corporate Governance' },
  { topicName: P4, questionText: '4.5.2 Corporate Governance – Core Principles & Laws', pageNumber: 52, tag: 'Corporate Governance' },
  { topicName: P4, questionText: '4.5.3 Corporate Governance – Balancing Economic, Social, Individual, and Communal Goals', pageNumber: 53, tag: 'Corporate Governance' },
  { topicName: P4, questionText: '4.5.4 Ethical Issues in Outsourcing Strategic Decision-Making in Public Sector Enterprises', pageNumber: 54, tag: 'Corporate Governance' },
  { topicName: P4, questionText: '4.6 Environmental Ethics', pageNumber: 54, tag: 'Environmental Ethics' },
  { topicName: P4, questionText: '4.6.1 Environmental Ethics – Importance & Air Pollution (Delhi-NCR)', pageNumber: 54, tag: 'Environmental Ethics' },
  { topicName: P4, questionText: '4.6.2 Environmental Ethics – Definition & Values', pageNumber: 55, tag: 'Environmental Ethics' },

  { topicName: P5, questionText: '5.1 Concept of Public Service; Philosophical Basis of Governance & Probity', pageNumber: 57, tag: 'Probity' },
  { topicName: P5, questionText: '5.1.1 Probity in Public Life – Definition, Difficulties & Measures', pageNumber: 57, tag: 'Probity' },
  { topicName: P5, questionText: '5.1.2 Probity – Foundation of Ethical Public Administration', pageNumber: 57, tag: 'Probity' },
  { topicName: P5, questionText: '5.1.3 Probity in Public Life – Consistency Between Declared Values and Actual Conduct', pageNumber: 58, tag: 'Probity' },
  { topicName: P5, questionText: '5.1.4 Probity in Governance – Transparency & Accountability', pageNumber: 59, tag: 'Probity' },
  { topicName: P5, questionText: '5.2 Information Sharing and Transparency in Government', pageNumber: 59, tag: 'RTI' },
  { topicName: P5, questionText: '5.2.1 Transparency as a Moral Imperative in Governance', pageNumber: 59, tag: 'RTI' }
];

// ================= PYQs, classified against the canonical tag labels above =================
const PYQ_ROWS = [
  // 01. Ethics and Human Interface
  { questionText: 'Q2 (b) Keeping the national security in mind, examine the ethical dilemmas related to controversies over environmental clearance of development projects in ecologically sensitive border areas in the country.', section: 'Environmental Ethics', year: 2025 },
  { questionText: 'Global warming and climate change are the outcomes of human greed in the name of development, indicating the direction in which extinction of organisms including human beings is heading towards loss of life on Earth. How do you put an end to this to protect life and bring equilibrium between the society and the environment?', section: 'Environmental Ethics', year: 2024 },
  { questionText: 'Suppose the Government of India is thinking of constructing a dam in a mountain valley bound by forests and inhabited by ethnic communities. What rational policy should it resort to in dealing with unforeseen contingencies?', section: 'Environmental Ethics', year: 2018 },
  { questionText: "What is meant by 'environmental ethics'? Why is it important to study? Discuss any one environmental issue from the viewpoint of environmental ethics.", section: 'Environmental Ethics', year: 2015 },

  { questionText: 'Q1 (a) In the present digital age, social media has revolutionised our way of communication and interaction. However, it has raised several ethical issues and challenges. Describe the key ethical dilemmas in this regard.', section: 'Ethics & Technology', year: 2025 },
  { questionText: 'The application of Artificial Intelligence as a dependable source of input for administrative rational decision-making is a debatable issue. Critically examine the statement from the ethical point of view.', section: 'Ethics & Technology', year: 2024 },
  { questionText: "Online methodology is being used for day-to-day meetings, institutional approvals in the administration and for teaching and learning in education sector to the extent telemedicine in the health sector is getting popular with the approvals of the competent authority. No doubt it has advantages and disadvantages for both the beneficiaries and system at large. Describe and discuss the ethical issues involved in the use of online method particularly to vulnerable section of society.", section: 'Ethics & Technology', year: 2022 },
  { questionText: 'Impact of digital technology as a reliable source of input for rational decision making is a debatable issue. Critically evaluate with a suitable example.', section: 'Ethics & Technology', year: 2021 },
  { questionText: 'The current internet expansion has instilled a different set of cultural values which are in conflict with traditional values. Discuss.', section: 'Ethics & Technology', year: 2020 },

  { questionText: '"The concept of Just and Unjust is contextual. What was just a year back, may turn out to be unjust in today\'s context. Changing context should be constantly under scrutiny to prevent miscarriage of justice." Examine the above statement with suitable examples.', section: 'Determinants of Ethics', year: 2024 },
  { questionText: '"Ethics encompasses several key dimensions that are crucial in guiding individuals and organizations towards morally responsible behaviour." Explain the key dimensions of ethics that influence human actions. Discuss how these dimensions shape ethical decision-making in the professional context.', section: 'Determinants of Ethics', year: 2024 },
  { questionText: 'Without commonly shared and widely entrenched moral values and obligations, neither the law, nor democratic government, nor even the market economy will function properly. What do you understand by this statement? Explain with illustration in the contemporary times.', section: 'Determinants of Ethics', year: 2017 },
  { questionText: 'Some people feel that values keep changing with time and situation, while others strongly believe that there are certain universal and eternal human values. Give your perception in this regard with due justification.', section: 'Determinants of Ethics', year: 2013 },

  { questionText: 'Distinguish between laws and rules. Discuss the role of ethics in formulating them.', section: 'Essence of Ethics', year: 2020 },
  { questionText: "It is often said that 'politics' and 'ethics' do not go together. What is your opinion in this regard? Justify your answer with illustrations.", section: 'Essence of Ethics', year: 2013 },

  { questionText: "In the context of defence services, 'patriotism' demands readiness to even lay down one's life in protecting the nation. According to you, what does patriotism imply in everyday civil life? Explain with illustrations and justify your answer.", section: 'Ethics in Public & Private Life', year: 2014 },
  { questionText: 'What does ethics seek to promote in human life? Why is it all the more important in public administration?', section: 'Ethics in Public & Private Life', year: 2014 },
  { questionText: "What do you understand by 'values' and 'ethics'? In what way is it important to be ethical along with being professionally competent?", section: 'Ethics in Public & Private Life', year: 2013 },
  { questionText: 'The good of an individual is contained in the good of all. What do you understand by this statement? How can this principle be implemented in public life?', section: 'Ethics in Public & Private Life', year: 2013 },

  { questionText: 'It is believed that adherence to ethics in human actions would ensure in smooth functioning of an organization/system. If so, what does ethics seek to promote in human life? How do ethical values assist in the resolution of conflicts faced by him in his day-to-day functioning?', section: 'Consequences of Ethics', year: 2022 },
  { questionText: 'Discuss the role of ethics and values in enhancing the following three major components of Comprehensive National Power (CNP) viz. human capital, soft power (culture and policies), and social harmony.', section: 'Consequences of Ethics', year: 2020 },
  { questionText: 'Increased national wealth did not result in equitable distribution of its benefits. It has created only some "enclaves of modernity and prosperity for a small minority at the cost of the majority." Justify.', section: 'Consequences of Ethics', year: 2017 },
  { questionText: 'Explain how ethics contributes to social and human well-being.', section: 'Consequences of Ethics', year: 2016 },
  { questionText: 'The current society is plagued with widespread trust-deficit. What are the consequences of this situation for personal well-being and for societal well-being? What can you do at the personal level to make yourself trustworthy?', section: 'Consequences of Ethics', year: 2014 },

  { questionText: 'With regard to morality of actions, one view is that means are of paramount importance and the other view is that the ends justify the means. Which view do you think is more appropriate? Justify your answer.', section: 'Means vs Ends', year: 2018 },
  { questionText: "Human beings should always be treated as 'ends' in themselves and never as merely 'means'. Explain the meaning and significance of this statement, giving its implications in the modern techno-economic society.", section: 'Means vs Ends', year: 2014 },

  { questionText: "Differentiate 'moral intuition' from 'moral reasoning' with suitable examples.", section: 'Key Ethics Terms', year: 2023 },
  { questionText: 'Write short notes on the following in 30 words each: (i) Constitutional morality (ii) Conflict of interest (iii) Probity in public life (iv) Challenges of digitalization (v) Devotion to duty', section: 'Key Ethics Terms', year: 2022 },
  { questionText: 'Examine the relevance of the following in the context of civil service: (a) Transparency (b) Accountability (c) Fairness and justice (d) Courage of conviction (e) Spirit of service.', section: 'Key Ethics Terms', year: 2017 },
  { questionText: 'Differentiate between the following; a) Law and Ethics; b) Ethical management and Management of ethics; c) Discrimination and Preferential treatment; d) Personal ethics and Professional ethics', section: 'Key Ethics Terms', year: 2015 },
  { questionText: 'What do you understand by the following terms in the context of public service? (5 terms x 3 marks each: a) Integrity b) Perseverance c) Spirit of service d) Commitment e) Courage of conviction f) Personal opinion', section: 'Key Ethics Terms', year: 2013 },

  // 02. Human Values
  { questionText: '"Corruption is the manifestation of the failure of core values in the society." In your opinion, what measures can be adopted to uplift the core values in the society?', section: 'Crisis of Values', year: 2023 },
  { questionText: 'The crisis of ethical values in modern times is traced to a narrow perception of the good life. Discuss.', section: 'Crisis of Values', year: 2017 },
  { questionText: 'We are witnessing increasing instances of sexual violence against women in the country. Despite existing legal provisions against it, the number of such incidences is on the rise. Suggest some innovative measures to tackle this menace.', section: 'Crisis of Values', year: 2014 },

  { questionText: 'Social values are more important than economic values. Discuss the above statement with examples in the context of inclusive growth of a nation.', section: 'Nature of Values', year: 2015 },
  { questionText: 'All human beings aspire for happiness. Do you agree? What does happiness mean to you? Explain with examples.', section: 'Nature of Values', year: 2014 },

  { questionText: '"Education is not an injunction, it is an effective and pervasive tool for all-round development of an individual and social transformation". Examine the New Education Policy, 2020 (NEP, 2020) in light of the above statement.', section: 'Educational Institutions', year: 2020 },

  { questionText: 'Q4 (b) What are the major teachings of Mahavir? Explain their relevance in the contemporary world.', section: 'Great Leaders', year: 2025 },
  { questionText: 'What were the major teachings of Guru Nanak? Explain their relevance in the contemporary world.', section: 'Great Leaders', year: 2023 },
  { questionText: 'What are the main factors responsible for gender inequality in India? Discuss the contribution of Savitribai Phule in this regard.', section: 'Great Leaders', year: 2020 },
  { questionText: 'What teachings of Buddha are most relevant today and why? Discuss.', section: 'Great Leaders', year: 2020 },
  { questionText: '"Great ambition is the passion of a great character. Those endowed with it may perform very good or very bad acts. All depends on the principles which direct them." – Napoleon Bonaparte. Stating examples mention the rulers (i) who have harmed society and country, (ii) who worked for the development of society and country.', section: 'Great Leaders', year: 2017 },
  { questionText: "Discuss Mahatma Gandhi's concept of seven sins.", section: 'Great Leaders', year: 2016 },
  { questionText: 'Which eminent personality has inspired you the most in the context of ethical conduct in life? Give the gist of his/her teachings giving specific examples, describe how you have been able to apply these teachings for your own ethical development.', section: 'Great Leaders', year: 2014 },

  // 03. Attitude
  { questionText: 'Q5 (b) To achieve holistic development goal, a civil servant acts as an enabler and active facilitator of growth rather than a regulator. What specific measures would you suggest to achieve this goal?', section: 'Enabler and Facilitator', year: 2025 },
  { questionText: 'Attitude is an important component that goes as input in the development of human beings. How to build a suitable attitude needed for a public servant?', section: 'Attitude of Civil Servants', year: 2021 },
  { questionText: 'A positive attitude is considered to be an essential characteristic of a civil servant who is often required to function under extreme stress. What contributes a positive attitude in person?', section: 'Attitude of Civil Servants', year: 2020 },
  { questionText: 'Our attitudes towards life, work, other people and society are generally shaped unconsciously by the family and social surroundings in which we grow up. Some of these unconsciously acquired attitudes and values are often undesirable in the citizens of modern democratic and egalitarian society. (a) Discuss such undesirable values prevalent in today\'s educated Indians. (b) How can such undesirable attitudes be changed and socio-ethical values be cultivated in the aspiring and serving civil servants?', section: 'Attitude of Civil Servants', year: 2016 },

  { questionText: "'Hatred is destructive of a person's wisdom and conscience that can poison a nation's spirit. Do you agree with this view? Justify your answer.", section: 'Attitude of Individuals', year: 2020 },
  { questionText: "What factors affect the formation of a person's attitude towards social problems? In our society, contrasting attitudes are prevalent about many social problems. What contrasting attitudes do you notice about the caste system in our society? How do you explain the existence of these contrasting attitudes?", section: 'Attitude of Individuals', year: 2014 },

  { questionText: 'Mindless addiction to Form, ignoring the Substance of the matter, results in rendering of injustice. A perceptive civil servant is one who ignores such literalness and carries out true intent. Examine the above statement with suitable illustrations.', section: 'Practical Intelligence', year: 2024 },
  { questionText: 'The Rules and Regulations provided to all the civil servants are same, yet there is difference in the performance. Positive minded officers are able to interpret the Rules and Regulations in favour of the case and achieve success, whereas negative minded officers are unable to achieve goals by interpreting the same Rules and Regulations against the case. Discuss with illustrations.', section: 'Practical Intelligence', year: 2022 },
  { questionText: 'Two different kinds of attitudes exhibited by public servants towards their work have been identified as the bureaucratic attitude and the democratic attitude. A) Distinguish between these two terms and write their merits and demerits. B) Is it possible to balance the two to create a better administration for the faster development of our country?', section: 'Bureaucratic vs Democratic Attitude', year: 2015 },

  { questionText: 'Young people with ethical conduct are not willing to come forward to join active politics. Suggest steps to motivate them to come forward.', section: 'Political Attitude', year: 2017 },

  { questionText: "In the context of work environment, differentiate between 'coercion' and 'undue influence' with suitable examples.", section: 'Organisational Attitude', year: 2023 },
  { questionText: 'Discipline generally implies following the order and subordination. However, it may be counter-productive for the organisation. Discuss.', section: 'Organisational Attitude', year: 2017 },

  { questionText: 'Q4 (a) "For any kind of social re-engineering by successfully implementing welfare schemes, a civil servant must use reason and critical thinking in an ethical framework." Justify this statement with suitable examples.', section: 'Persuasion', year: 2025 },
  { questionText: 'How could social influence and persuasion contribute to the success of Swatchh Bharat Abhiyan?', section: 'Persuasion', year: 2016 },

  // 04. Emotional Intelligence
  { questionText: 'How will you apply emotional intelligence in administrative practices?', section: 'EI in Administration', year: 2017 },
  { questionText: 'What are the main components of emotional intelligence (EI)? Can they be learned? Discuss.', section: 'Emotional Intelligence', year: 2020 },
  { questionText: '"Emotional Intelligence is the ability to make your emotions work for you instead of against you." Do you agree with this view? Discuss.', section: 'Emotional Intelligence', year: 2019 },
  { questionText: 'Anger is a harmful negative emotion. It is injurious to both personal life and work life. (a) Discuss how it leads to negative emotions and undesirable behaviours. (b) How can it be managed and controlled?', section: 'Emotional Intelligence', year: 2016 },
  { questionText: "What is 'emotional intelligence' and how can it be developed in people? How does it help an individual in taking ethical decisions?", section: 'Emotional Intelligence', year: 2013 },
  { questionText: 'In case of a crisis of conscience does emotional intelligence help to overcome the same without compromising the ethical and moral stand that you are likely to follow? Critically examine.', section: 'Conscience', year: 2021 },
  { questionText: '"What really matters for success, character, happiness and lifelong achievements is a definite set of emotional skills – your EQ – not just purely cognitive abilities that are measured by conventional IQ tests." Do you agree with this view? Give reasons in support of your answer.', section: 'EQ vs IQ', year: 2023 },

  // 05. Contributions of Moral Thinkers and Philosophers
  { questionText: '"If a country is to be corruption free and become a nation of beautiful minds, I strongly feel there are three key societal members who can make a difference. They are the father, the mother and the teacher." – Abdul Kalam.', section: 'Moral Thinkers & Quotes', year: 2022 },
  { questionText: '"Where there is righteousness in the heart, there is beauty in the character. When there is beauty in the character, there is harmony in the home. When there is harmony in the home, there is order in the nation. When there is order in the nation, there is peace in the world." – A.P.J. Abdul Kalam', section: 'Moral Thinkers & Quotes', year: 2019 },
  { questionText: '"If a country is to be corruption free and become a nation of beautiful minds, I strongly feel there are three key societal members who can make a difference. they are father, the mother and the teacher." – A. P. J. Abdul Kalam. Analyse.', section: 'Moral Thinkers & Quotes', year: 2017 },
  { questionText: 'The true rule, in determining to embrace, or reject any thing, is not whether it has any evil in it; but whether it has more evil than good. There are few things wholly evil or wholly good. Almost every thing, especially of governmental policy, is an inseprarable compound of the two; so that our best judgement of the preponderance between them is continually demand. - Abraham Lincoln.', section: 'Moral Thinkers & Quotes', year: 2018 },
  { questionText: "Nearly all men can withstand adversity, but if you want to test a man's character, give him power.—Abraham Lincoln", section: 'Moral Thinkers & Quotes', year: 2013 },
  { questionText: 'I count him braver who overcomes his desires than him who overcomes his enemies.—Aristotle', section: 'Aristotle', year: 2013 },
  { questionText: '"Judge your success by what you had to give up in order to get it." Dalai Lama.', section: 'Dalai Lama', year: 2022 },
  { questionText: '"We can never obtain peace in the outer world until and unless we obtain peace within ourselves" – Dalai Lama', section: 'Dalai Lama', year: 2021 },
  { questionText: '"Life doesn\'t make any sense without interdependence. We need each other, and the sooner we learn that it is better for us all" – Erik Erikson', section: 'Moral Thinkers & Quotes', year: 2021 },
  { questionText: '"In law, a man is guilty when he violates the rights of others. In ethics, he is guilty if he only thinks of doing so." — Immanuel Kant', section: 'Moral Thinkers & Quotes', year: 2024 },
  { questionText: '(b) "To awaken the people, it is the women who must be awakened. Ones she is on the move, the family moves, the village moves, the nation moves." – Jawaharlal Nehru', section: 'Moral Thinkers & Quotes', year: 2023 },
  { questionText: "Analyse John Rawls's concept of social justice in the Indian context.", section: 'Moral Thinkers & Quotes', year: 2016 },
  { questionText: "Corruption causes misuse of government treasury, Administrative inefficiency and obstruction in the path of national Development. Discuss Kautilya's views.", section: 'Moral Thinkers & Quotes', year: 2016 },
  { questionText: '(a) "The simplest acts of kindness are by far more powerful than a thousand heads bowing in prayer." – Mahatma Gandhi', section: 'Moral Thinkers & Quotes', year: 2023 },
  { questionText: '"The best way to find yourself is to lose yourself in service of others." Mahatma Gandhi.', section: 'Moral Thinkers & Quotes', year: 2020 },
  { questionText: '"A man is but the product of his thoughts. What he thinks, he becomes." – M.K.Gandhi', section: 'Moral Thinkers & Quotes', year: 2019 },
  { questionText: 'Anger and intolerance are the enemies of correct understanding. -Mahatma Gandhi', section: 'Moral Thinkers & Quotes', year: 2018 },
  { questionText: '"The weak can never forgive; forgiveness is the attribute of the strong."', section: 'Moral Thinkers & Quotes', year: 2015 },
  { questionText: "There is enough on this earth for every one's need but for no one's greed. Mahatma Gandhi.", section: 'Moral Thinkers & Quotes', year: 2013 },
  { questionText: 'We can easily forgive a child who is afraid of the dark; the real tragedy of life is when men are afraid of the light.', section: 'Plato', year: 2015 },
  { questionText: "Ethics is knowing the difference between what you have the right to do and what is right to do.'-Potter Stewart.", section: 'Moral Thinkers & Quotes', year: 2022 },
  { questionText: '"Faith is of no avail in the absence of strength. Faith and strength, both are essential to accomplish any great work." — Sardar Patel', section: 'Moral Thinkers & Quotes', year: 2024 },
  { questionText: '"A system of morality which is based on relative emotional values is a mere illusion, a thoroughly vulgar conception which has nothing sound in it and nothing true." – Socrates.', section: 'Moral Thinkers & Quotes', year: 2020 },
  { questionText: '"An unexamined life is not worth living." – Socrates', section: 'Moral Thinkers & Quotes', year: 2019 },
  { questionText: 'Q3 (c) "The strength of a society is not in its laws, but in the morality of its people." – Swami Vivekananda (Answer in 150 words, 10 marks)', section: 'Swami Vivekananda', year: 2025 },
  { questionText: '"Learn everything that is good from others, but bring it in, and in your own way absorb it, do not become others." — Swami Vivekananda', section: 'Swami Vivekananda', year: 2024 },
  { questionText: '(c) Do not hate anybody, because that hatred that comes out from you must, in the long run, come back to you. If you love, that love will come back to you, completing the circle." – Swami Vivekanand.', section: 'Swami Vivekananda', year: 2023 },
  { questionText: 'Every work has got to pass through hundreds of difficulties before succeeding. Those that persevere will see the light, sooner or later" – Swami Vivekananda', section: 'Swami Vivekananda', year: 2021 },
  { questionText: '"Condemn none: if you can stretch out a helping hand do so. If not fold your hands, bless your brothers and let them go their own way." – Swami Vivekanand.', section: 'Swami Vivekananda', year: 2020 },
  { questionText: 'Q3 (a) "Those who in trouble untroubled are, Will trouble trouble itself." – Thiruvalluvar (Answer in 150 words, 10 marks)', section: 'Moral Thinkers & Quotes', year: 2025 },
  { questionText: 'Falsehood takes the place of truth when it results in unblemished common good. -Tirukkural', section: 'Moral Thinkers & Quotes', year: 2018 },
  { questionText: 'Q3 (b) "The greatest discovery of my generation is that a human being can alter his life by altering his attitudes." – William James (Answer in 150 words, 10 marks)', section: 'William James', year: 2025 },

  // 06. Aptitude and Foundational Values for Civil Service
  { questionText: 'Apart from intellectual competency and moral qualities, empathy and compassion are some of the other vital attributes that facilitate the civil servants to be more competent in tackling the crucial issues or taking critical decisions. Explain with suitable illustrations.', section: 'Empathy & Compassion', year: 2022 },
  { questionText: 'Identify ten essential values that are needed to be an effective public servant. Describe the ways and means to prevent non-ethical behaviour in public servants.', section: 'Foundational Values', year: 2021 },
  { questionText: 'Identify five ethical traits on which one can plot the performance of a civil servant. Justify their inclusion in the matrix.', section: 'Foundational Values', year: 2021 },
  { questionText: "What do you understand by the term 'public servant'? Reflect on the expected role of a public servant.", section: 'Foundational Values', year: 2019 },
  { questionText: 'What are the basic principles of public life? Illustrate any three of these with suitable examples.', section: 'Foundational Values', year: 2019 },
  { questionText: 'State the three basic values, universal in nature, in the context of civil services and bring out their importance.', section: 'Foundational Values', year: 2018 },
  { questionText: 'Indicate two more attributes which you consider important for public service. Justify your answer. (10 marks | 100 words)', section: 'Foundational Values', year: 2013 },

  { questionText: 'Should impartial and being non-partisan be considered indispensable qualities to make a successful civil servant? Discuss with illustrations.', section: 'Impartiality', year: 2021 },
  { questionText: 'Why should impartiality and non-partisanship be considered as foundational values in public services, especially in the present day socio-political context? Illustrate your answer with examples.', section: 'Impartiality', year: 2016 },

  { questionText: "'Integrity is a value that empowers the human being''. Justify with suitable illustration.", section: 'Integrity', year: 2021 },
  { questionText: 'One of the tests of integrity is complete refusal to be compromised. Explain with reference to a real life example.', section: 'Integrity', year: 2017 },
  { questionText: 'Integrity without knowledge is weak and useless, but knowledge without integrity is dangerous and dreadful. What do you understand by this statement? Explain your stand with illustrations from the modern context.', section: 'Integrity', year: 2014 },
  { questionText: 'In looking for people to hire, you look for three qualities: integrity, intelligence and energy. And if they do not have the first, the other two will you. - Warren Buffett. What do you understand by this statement in the present-day scenario? Explain.', section: 'Integrity', year: 2018 },

  { questionText: 'How do the virtues of trustworthiness and fortitude get manifested in public service? Explain with examples.', section: 'Trustworthiness', year: 2015 },

  // 07. Public/Civil Service Values and Ethics in Public Administration
  { questionText: 'Explain the term social capital. How does it enhance good governance?', section: 'Ethical Governance', year: 2023 },
  { questionText: "What do you understand by term 'good governance'? How far recent initiatives in terms of e-Governance steps taken by the State have helped the beneficiaries? Discuss with suitable examples.", section: 'Ethical Governance', year: 2022 },
  { questionText: 'An independent and empowered social audit mechanism is an absolute must in every sphere of public service, including the judiciary, to ensure performance, accountability and ethical conduct. Elaborate.', section: 'Ethical Governance', year: 2021 },
  { questionText: "What do you understand by the terms 'governance', 'good governance' and 'ethical governance'?", section: 'Ethical Governance', year: 2016 },
  { questionText: "What does 'accountability' mean in the context of public service? What measures can be adopted to ensure individual and collective accountability of public servants?", section: 'Ethical Governance', year: 2014 },

  { questionText: 'What is meant by conflict of interest? Illustrate with examples, the difference between the actual and potential conflicts of interest.', section: P4, year: 2018 },
  { questionText: 'Conflict of interest in the public sector arises when (a) official duties, (b) public interest, and (c) personal interest are taking priority one above the other. How can this conflict in administration be resolved? Describe with an example.', section: P4, year: 2017 },
  { questionText: "Public servants are likely to confront with the issues of 'Conflict of Interest'. What do you understand by the term 'Conflict of Interest' and how does it manifest in the decision making by public servants? If faced with the conflict of interest situation, how would you resolve it? Explain with the help of examples.", section: P4, year: 2015 },

  { questionText: 'Q1 (b) "Constitutional morality is not a natural sentiment but a product of civil education and adherence of the rule of law." Examine the significance of constitutional morality for public servant highlighting the role in promoting good governance and ensuring accountability in public administration.', section: 'Constitutional Morality', year: 2025 },
  { questionText: 'What is meant by constitutional morality? How does one uphold constitutional morality?', section: 'Constitutional Morality', year: 2019 },

  { questionText: "What do you understand by 'moral integrity' and 'professional efficiency' in the context of corporate governance in India? Illustrate with suitable examples.", section: 'Corporate Governance', year: 2023 },
  { questionText: "In contemporary world, corporate sector's contribution in generating wealth and employment is increasing. In doing so, they are bringing in unprecedented onslaught on the climate, environmental sustainability and living conditions of human beings. In this background, do you find that Corporate Social Responsibility (CSR) is efficient and sufficient enough to fulfill the social roles and responsibilities needed in the corporate world for which the CSR is mandated? Critically examine.", section: 'Corporate Governance', year: 2022 },
  { questionText: 'Corporate social responsibility makes companies more profitable and sustainable. Analyse.', section: 'Corporate Governance', year: 2017 },

  { questionText: 'Besides domain knowledge, a public official needs innovativeness and creativity of a high order as well, while resolving ethical dilemmas. Discuss with a suitable example.', section: 'Ethical Dilemma', year: 2021 },
  { questionText: 'Explain the process of resolving ethical dilemmas in Public Administration.', section: 'Ethical Dilemma', year: 2018 },

  { questionText: 'Carl von Clausewitz once said, "War is a diplomacy by other means." Critically analyse the above statement in the present context of contemporary geo-political conflict.', section: 'International Relations Ethics', year: 2025 },
  { questionText: '"It is not enough to talk about peace, one must believe in it; and it is not enough to believe in it, one must act upon it" In the present context, the major weapon industries of the developed nations are adversely influencing continuation of number of wars for their own self-interest, all around the world. What are the ethical considerations of the powerful nations in today\'s international arena to stop continuation of ongoing conflicts?', section: 'International Relations Ethics', year: 2024 },
  { questionText: "'International aid' is an accepted form of helping 'resource-challenged' nations. Comment on 'ethics in contemporary international aid'. Support your answer with suitable examples.", section: 'International Relations Ethics', year: 2023 },
  { questionText: 'Russia and Ukraine war has been going on for the last seven months. Different countries have taken independent stands and actions keeping in view their own national interests. We are all aware that war has its own impact on the different aspects of society, including human tragedy. What are those ethical issues that are crucial to be considered while launching the war and its continuation so far? Illustrate with justification the ethical issues involved in the given state of affair.', section: 'International Relations Ethics', year: 2022 },
  { questionText: '"Refugees should not be turned back to the country where they would face prosecution or human rights violation." Examine the statement with reference to the ethical dimension being violated by the nation claiming to be democratic with an open society.', section: 'International Relations Ethics', year: 2021 },
  { questionText: "'The will to power exits, but it can be tamed and be guided by rationality and principles of moral duty.' Examine this statement in the context of international relations.", section: 'International Relations Ethics', year: 2020 },
  { questionText: 'Strength, peace and security are considered to be the pillars of international relations. Elucidate.', section: 'International Relations Ethics', year: 2017 },
  { questionText: "At the international level, the bilateral relations between most nations are governed on the policy of promoting one's own national interest without any regard for the interest of other nations. This leads to conflicts and tensions between the nations. How can ethical consideration help resolve such tensions? Discuss with specific examples.", section: 'International Relations Ethics', year: 2015 },

  { questionText: 'The soul of the new law, Bharatiya Nyaya Sanhita (BNS) is Justice, Equality and Impartiality based on Indian culture and ethos. Discuss this in the light of major shift from a doctrine of punishment to justice in the present judicial system.', section: 'Laws & Conscience', year: 2024 },
  { questionText: 'Is conscience a more reliable guide when compared to laws, rules and regulations in the context of ethical decision making? Discuss.', section: 'Laws & Conscience', year: 2023 },
  { questionText: "What is meant by 'crisis of conscience'? How does it manifest itself in the public domain?", section: 'Laws & Conscience', year: 2019 },
  { questionText: 'Law and ethics are considered to be the two tools for controlling human conduct so as to make it conducive to civilized social existence. (a) Discuss how they achieve this objective. (b) Giving examples, show how the two differ in their approaches.', section: 'Laws & Conscience', year: 2016 },
  { questionText: 'A mere compliance with law is not enough, the public servant also has to have a well-developed sensibility to ethical issues for effective discharge of duties." Do you agree? Explain with the help of two examples, where (i) an act is ethically right, but not legally and (ii) an act is legally right, but not ethically.', section: 'Laws & Conscience', year: 2015 },
  { questionText: "What do you understand by the term 'voice of conscience'? How do you prepare yourself to heed to the voice of conscience?", section: 'Laws & Conscience', year: 2013 },
  { questionText: "What is meant by 'crisis of conscience'? Narrate one incident in your life when you were faced with such a crisis and how you resolved the same.", section: 'Laws & Conscience', year: 2013 },

  { questionText: 'Q5 (a) "One who is devoted to one\'s duty attains highest perfection in life." Analyse this statement with reference to sense of responsibility and personal fulfilment as a civil servant.', section: 'Devotion to Duty', year: 2025 },
  { questionText: '"Non-performance of duty by a public servant is a form of corruption" Do you agree with this view? Justify your answer', section: 'Corruption', year: 2019 },
  { questionText: 'In doing a good thing, everything is permitted which is not prohibited expressly or by clear implication. Examine the statement with suitable examples in the context of a public servant discharging his/her duties.', section: 'Civil Service Values', year: 2018 },
  { questionText: 'What is meant by public interest? What are the principles and procedures to be followed by the civil servants in public interest?', section: 'Public Interest', year: 2018 },
  { questionText: 'Max Weber said that it is not wise to apply to public administration the sort of moral and ethical norms we apply to matters of personal conscience. It is important to realise that the State bureaucracy might possess its own independent bureaucratic morality. Critically analyse this statement.', section: 'Civil Service Values', year: 2016 },

  // 08. Probity in Governance
  { questionText: "Explain the basic principles of citizens' charter movement and bring out its importance.", section: 'Citizens Charter', year: 2019 },
  { questionText: "The 'Code of Conduct' and 'Code of Ethics' are the sources of guidance in public administration. There is code of conduct already in operation, whereas code of ethics is not yet put in place. Suggest a suitable mode for code of ethics to maintain integrity, probity and transparency in governance.", section: 'Code of Ethics', year: 2024 },
  { questionText: 'Distinguish between "Code of ethics" and "Code of conduct" with suitable examples.', section: 'Code of Ethics', year: 2018 },
  { questionText: 'Discuss the Public Services Code as recommended by the 2nd Administrative Reforms Commission.', section: 'Public Services Code', year: 2016 },

  { questionText: 'Whistle blower, who reports corruption and illegal activities, wrongdoing and misconduct to the concerned authorities, runs the risk of being exposed to grave danger, physical harm and victimization by the vested interests, accused persons and his team. What policy measures would you suggest to strengthen protection mechanism to safeguard the whistle blower?', section: 'Corruption', year: 2022 },
  { questionText: 'It is often said that poverty leads to corruption. However, there is no dearth of instances where affluent and powerful people indulge in corruption in a big way. What are the basic causes of corruption among people? Support your answer with examples.', section: 'Corruption', year: 2014 },

  { questionText: '"In Indian culture and value system, an equal opportunity has been provided irrespective of gender identity. The number of women in public service has been steadily increasing over the years." Examine the gender specific challenges faced by female public servants and suggest to increase their efficiency in discharging their duties and maintaining high standards of probity.', section: 'Probity', year: 2024 },
  { questionText: "'Probity is essential for an effective system of governance and socio-economic development.' Discuss.", section: 'Probity', year: 2023 },
  { questionText: 'What do you understand by probity in governance? Based on your understanding of the term, suggest measures for ensuring probity in government.', section: 'Probity', year: 2019 },
  { questionText: "What do you understand by 'probity' in public life? What are the difficulties in practicing it in the present times? How can these difficulties be overcome?", section: 'Probity', year: 2014 },

  { questionText: 'Mission Karmayogi is aiming for maintaining a very high standard of conduct and behaviour to ensure efficiency for serving citizens and in developing oneself. How will this scheme empower the civil servants in enhancing productive efficiency and delivering the services at the grassroots level?', section: 'Quality of Service', year: 2024 },
  { questionText: 'Wisdom lies in knowing what to reckon with and what to overlook. An officer being engrossed with the periphery, ignoring the core issues before him, is no rare in the bureaucracy. Do you agree that such preoccupation of an administrator leads to travesty of justice to the cause of effective service delivery and good governance? Critically evaluate.', section: 'Quality of Service', year: 2022 },

  { questionText: 'There is a view that the official secrets act is an obstacle to the implementation of the Rights to Information act. Do you agree with the view? Discuss', section: 'RTI', year: 2019 },
  { questionText: "The Right to Information Act is not all about citizens' empowerment alone, it essentially redefines the concept of accountability. Discuss.", section: 'RTI', year: 2018 },
  { questionText: 'Today we find that in spite of various measures like prescribing codes of conduct, setting up vigilance cells/commissions, RTI, active media and strengthening of legal mechanisms, corrupt practices are not coming under control. A) Evaluate the effectiveness of these measures with justifications. B) Suggest more effective strategies to tackle this menace.', section: 'RTI', year: 2015 },
  { questionText: 'Some recent developments such as introduction of RTI Act, media and judicial activism, etc., are proving helpful in bringing about greater transparency and accountability in the functioning of the government. However, it is also being observed that at times the mechanisms are misused. Another negative effect is that the officers are now afraid to take prompt decisions. Analyze this situation in detail and suggest how this dichotomy can be resolved. Suggest how these negative impacts can be minimized.', section: 'RTI', year: 2015 },

  { questionText: 'Q6 (b) India is an emerging economic power of the world as it has recently secured the status of fourth largest economy of the world as per IMF projection. However, it has been observed that in some sectors, allocated funds remain either under-utilised or misutilised. What specific measures would you recommend for ensuring accountability in this regard to stop leakages and gaining the status of third largest economy of the world in near future?', section: 'Public Funds', year: 2025 },
  { questionText: 'Effective utilisation of public funds is crucial to meet development goals. Critically examine the reasons for under-utilization and mis-utilisation of public funds and their implications.', section: 'Public Funds', year: 2019 },
  { questionText: 'There is a heavy ethical responsibility on the public servants because they occupy positions of power, handle huge amounts of public funds, and their decisions have wide-ranging impact on society and environment. What steps have you taken to improve your ethical competence to handle such responsibility?', section: 'Public Funds', year: 2014 },

  { questionText: 'Q6 (a) It is said that for an ethical work culture, there must be code of ethics in place in every organisation. To ensure value-based and compliance-based work culture, what suitable measures would you adopt in your work place?', section: 'Work Culture', year: 2025 }
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

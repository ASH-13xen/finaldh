// One-time import of Progress checklist + PYQ data for the "Mains Master File - Polity" file
// inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is PART (roman numeral, e.g. "PART-I Constitutional Framework") -> a labelled
// sub-group (e.g. "Salient Features of the Constitution") -> single numbered content items with
// no page numbers given. Topic = Part; Question = each numbered item; `tag` = the sub-group
// label the item sits under. That sub-group label doubles as a precise PYQ-matching key because
// it already lines up closely with this PYQ document's own microtheme names (e.g. "Federalism",
// "Pressure Groups", "Amendment") - see tagMatcher.js's substring comparison. Some abbreviated
// for a cleaner badge (SEBI, NHRC, CAG, ...) since `tag` renders as a visible pill under each
// checklist row. Part numbering (I,II,III,IV,V,VII,VIII,IX,XI,XIV, skipping VI/X/XII/XIII) is
// kept exactly as the source document has it.
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
const TARGET_FILE_NAME = 'Mains Master File - Polity';

const T1 = 'PART-I: Constitutional Framework';
const T2 = 'PART-II: System of Government';
const T3 = 'PART-III: Central Government';
const T4 = 'PART-IV: State Government';
const T5 = 'PART-V: Local Government';
const T6 = 'PART-VII: Judiciary';
const T7 = 'PART-VIII: Constitutional Bodies';
const T8 = 'PART-IX: Non-Constitutional Bodies';
const T9 = 'PART-XI: Political Dynamics';
const T10 = 'PART-XIV: Comparison of the Constitutions';

const CHECKLIST_ROWS = [
  { topicName: T1, questionText: '1. Similarities and differences between the Government of India Act 1935 and the Indian Constitution', pageNumber: null, tag: 'Historical Background' },
  { topicName: T1, questionText: '2. The principle of separation of powers (checks and balances)', pageNumber: null, tag: 'Salient Features of the Constitution' },
  { topicName: T1, questionText: "3. The Indian Constitution as a 'borrowed Constitution'", pageNumber: null, tag: 'Salient Features of the Constitution' },
  { topicName: T1, questionText: '4. Approach to secularism – comparative analysis of India and France', pageNumber: null, tag: 'Salient Features of the Constitution' },
  { topicName: T1, questionText: '5. Constitutional provisions safeguarding linguistic pluralism', pageNumber: null, tag: 'Salient Features of the Constitution' },
  { topicName: T1, questionText: '6. Importance of a constitution for a modern nation-state', pageNumber: null, tag: 'Concept of the Constitution' },
  { topicName: T1, questionText: '7. Significance of the amendment(s) made to the Preamble', pageNumber: null, tag: 'Preamble of the Constitution' },
  { topicName: T1, questionText: '8. Reorganization of states as a parliamentary prerogative', pageNumber: null, tag: 'Union and its Territory' },
  { topicName: T1, questionText: '9. Reasons the DPSP were made non-justiciable', pageNumber: null, tag: 'DPSP' },
  { topicName: T1, questionText: '10. Article 19(1)(a) – Freedom of speech and expression', pageNumber: null, tag: 'Fundamental Rights' },
  { topicName: T1, questionText: '11. Article 21 and its expansive interpretation', pageNumber: null, tag: 'Fundamental Rights' },
  { topicName: T1, questionText: '12. Rule of law and its constitutional provisions', pageNumber: null, tag: 'Fundamental Rights' },
  { topicName: T1, questionText: '13. The DPDP Act, 2023 and the right to privacy', pageNumber: null, tag: 'Fundamental Rights' },
  { topicName: T1, questionText: '14. State regulation of religious endowments (Waqf)', pageNumber: null, tag: 'Fundamental Rights' },
  { topicName: T1, questionText: '15. Significance and criticism of the DPSP', pageNumber: null, tag: 'DPSP' },
  { topicName: T1, questionText: '16. "Material resources" under Article 39(b) – Property Owners Association (2024)', pageNumber: null, tag: 'DPSP' },
  { topicName: T1, questionText: '17. Procedure under Article 368 and its criticisms', pageNumber: null, tag: 'Amendment of the Constitution' },
  { topicName: T1, questionText: '18. Balance of flexibility and rigidity', pageNumber: null, tag: 'Amendment of the Constitution' },
  { topicName: T1, questionText: '19. Role of the Kesavananda Bharati judgment', pageNumber: null, tag: 'Basic Structure of the Constitution' },
  { topicName: T1, questionText: "20. The 'basic structure' doctrine and its significance", pageNumber: null, tag: 'Basic Structure of the Constitution;Constitutional Morality' },

  { topicName: T2, questionText: '21. Factors behind adopting the parliamentary form', pageNumber: null, tag: 'Parliamentary System' },
  { topicName: T2, questionText: '22. Special powers and utility of the Rajya Sabha', pageNumber: null, tag: 'Parliamentary System' },
  { topicName: T2, questionText: '23. Parliamentary vs presidential forms of government', pageNumber: null, tag: 'Parliamentary System' },
  { topicName: T2, questionText: "24. India's quasi-federal nature vs US rigid federalism", pageNumber: null, tag: 'Federal System' },
  { topicName: T2, questionText: '25. When Parliament can legislate on State List subjects', pageNumber: null, tag: 'Centre-State Relations' },
  { topicName: T2, questionText: '26. Concept of residuary powers', pageNumber: null, tag: 'Centre-State Relations' },
  { topicName: T2, questionText: '27. Areas of contention in Centre-State relations', pageNumber: null, tag: 'Centre-State Relations' },
  { topicName: T2, questionText: '28. The Inter-State Council and federal disputes', pageNumber: null, tag: 'Inter-State Relations' },
  { topicName: T2, questionText: '29. Financial Emergency (Article 360)', pageNumber: null, tag: 'Emergency Provisions' },
  { topicName: T2, questionText: '30. National Emergency – federal relations and Fundamental Rights', pageNumber: null, tag: 'Emergency Provisions' },

  { topicName: T3, questionText: '31. Pardoning powers of the President and the Governor', pageNumber: null, tag: 'President' },
  { topicName: T3, questionText: '32. Legislative powers (Article 123) and re-promulgation of ordinances', pageNumber: null, tag: 'President' },
  { topicName: T3, questionText: '33. Role as Chairman of the Rajya Sabha and removal', pageNumber: null, tag: 'Vice-President' },
  { topicName: T3, questionText: '34. Removal vs the President; roles beyond chairing the Rajya Sabha', pageNumber: null, tag: 'Vice-President' },
  { topicName: T3, questionText: '35. Powers and responsibilities of the PM', pageNumber: null, tag: 'Prime Minister' },
  { topicName: T3, questionText: '36. Functions of the CoM – collective and individual responsibility', pageNumber: null, tag: 'Central Council of Ministers' },
  { topicName: T3, questionText: '37. Has the cabinet system diminished parliamentary supremacy?', pageNumber: null, tag: 'Cabinet Committees' },
  { topicName: T3, questionText: '38. Parliamentary privileges and their significance', pageNumber: null, tag: 'Parliament' },
  { topicName: T3, questionText: '39. Need for codification of parliamentary privileges', pageNumber: null, tag: 'Parliament' },
  { topicName: T3, questionText: '40. Role of Parliament in budget scrutiny', pageNumber: null, tag: 'Parliament' },
  { topicName: T3, questionText: '41. Reforming the whip system', pageNumber: null, tag: 'Parliament' },
  { topicName: T3, questionText: '42. Committee system and the role of DRSCs', pageNumber: null, tag: 'Parliamentary Committees' },
  { topicName: T3, questionText: "43. Importance of DRSCs for Parliament's effectiveness", pageNumber: null, tag: 'Parliamentary Committees' },
  { topicName: T3, questionText: '44. Effectiveness of Joint Parliamentary Committees (JPCs)', pageNumber: null, tag: 'Parliamentary Committees' },

  { topicName: T4, questionText: '45. Dual role of the Governor', pageNumber: null, tag: 'Governor' },
  { topicName: T4, questionText: '46. Creation and abolition of Legislative Councils', pageNumber: null, tag: 'State Legislature' },
  { topicName: T4, questionText: '47. Governor and President in the promulgation of state legislation', pageNumber: null, tag: 'State Legislature' },

  { topicName: T5, questionText: '48. Role of the 73rd and 74th Amendments', pageNumber: null, tag: 'Panchayati Raj & Local Government' },
  { topicName: T5, questionText: '49. Measures to strengthen Urban Local Bodies', pageNumber: null, tag: 'Panchayati Raj & Local Government' },
  { topicName: T5, questionText: '50. Challenges faced by State Finance Commissions', pageNumber: null, tag: 'Panchayati Raj & Local Government' },
  { topicName: T5, questionText: '51. Limited success of PRIs and measures to strengthen them', pageNumber: null, tag: 'Panchayati Raj & Local Government' },
  { topicName: T5, questionText: '52. Revenue sources of PRIs and their sufficiency', pageNumber: null, tag: 'Panchayati Raj & Local Government' },

  { topicName: T6, questionText: '53. Quasi-judicial bodies and their significance', pageNumber: null, tag: 'Judiciary (General)' },
  { topicName: T6, questionText: '54. Sealed cover jurisprudence and judicial credibility', pageNumber: null, tag: 'Judiciary (General)' },
  { topicName: T6, questionText: '55. Under-representation of women in the higher judiciary', pageNumber: null, tag: 'Judiciary (General)' },
  { topicName: T6, questionText: '56. Evolution of the appointment of Supreme Court judges', pageNumber: null, tag: 'Supreme Court' },
  { topicName: T6, questionText: '57. Integration of environmental concerns into the constitutional framework', pageNumber: null, tag: 'Supreme Court' },
  { topicName: T6, questionText: '58. Tribunals – significance and challenges', pageNumber: null, tag: 'Tribunals' },
  { topicName: T6, questionText: '59. Lok Adalats vs Arbitration Tribunals', pageNumber: null, tag: 'Tribunals' },
  { topicName: T6, questionText: '60. Judicial activism and judicial overreach', pageNumber: null, tag: 'Judicial Activism' },

  { topicName: T7, questionText: '61. Evolution of the Election Commission of India', pageNumber: null, tag: 'Election Commission' },
  { topicName: T7, questionText: "62. Constitutional safeguards for the ECI's autonomy", pageNumber: null, tag: 'Election Commission' },
  { topicName: T7, questionText: '63. Independence of the UPSC and measures to improve it', pageNumber: null, tag: 'UPSC' },
  { topicName: T7, questionText: '64. Finance Commission – appointment, composition, functions', pageNumber: null, tag: 'Finance Commission' },
  { topicName: T7, questionText: '65. Finance Commission and fiscal federalism', pageNumber: null, tag: 'Finance Commission' },
  { topicName: T7, questionText: '66. Finance Commission vs GST Council', pageNumber: null, tag: 'GST Council' },
  { topicName: T7, questionText: '67. Functions and powers of the NCSC', pageNumber: null, tag: 'NCSC' },
  { topicName: T7, questionText: '68. Role, appointment and functions of the CAG', pageNumber: null, tag: 'CAG' },
  { topicName: T7, questionText: '69. Issues in the appointment and functions of the CAG', pageNumber: null, tag: 'CAG' },
  { topicName: T7, questionText: '70. Appointment, duties, functions and restrictions of the AG', pageNumber: null, tag: 'Attorney General' },

  { topicName: T8, questionText: '71. Steps for constitutionalizing a Commission', pageNumber: null, tag: '' },
  { topicName: T8, questionText: '72. NHRC – limitations and reforms', pageNumber: null, tag: 'NHRC' },
  { topicName: T8, questionText: '73. Role, functions, limitations and challenges of the NHRC', pageNumber: null, tag: 'NHRC' },
  { topicName: T8, questionText: '74. Effectiveness of the NCW', pageNumber: null, tag: 'NCW' },
  { topicName: T8, questionText: '75. Role of SEBI in regulating markets and protecting investors', pageNumber: null, tag: 'SEBI' },
  { topicName: T8, questionText: '76. Challenges faced by SEBI', pageNumber: null, tag: 'SEBI' },
  { topicName: T8, questionText: '77. Constitutional status for the CIC and the RTI regime', pageNumber: null, tag: 'CIC' },
  { topicName: T8, questionText: '78. Functions of the CBI and overlap with state police', pageNumber: null, tag: 'CBI' },
  { topicName: T8, questionText: '79. Jurisdiction, functions, powers and challenges of the Lokpal', pageNumber: null, tag: 'Lokpal and Lokayuktas' },
  { topicName: T8, questionText: '80. Factors behind the establishment of the NGT', pageNumber: null, tag: 'NGT' },
  { topicName: T8, questionText: '81. Role of the NGT and its challenges', pageNumber: null, tag: 'NGT' },
  { topicName: T8, questionText: '82. Delimitation – importance and challenges', pageNumber: null, tag: 'Delimitation Commission' },

  { topicName: T9, questionText: '83. The Model Code of Conduct (MCC)', pageNumber: null, tag: 'Electoral Reforms;Model Code of Conduct' },
  { topicName: T9, questionText: '84. Structural weaknesses of the Tenth Schedule', pageNumber: null, tag: 'Anti-Defection Law' },
  { topicName: T9, questionText: '85. Pressure groups in India – types and vs political parties', pageNumber: null, tag: 'Pressure Groups' },
  { topicName: T9, questionText: '86. Role of pressure groups in influencing government', pageNumber: null, tag: 'Pressure Groups' },
  { topicName: T9, questionText: '87. Pressure groups in the digital era', pageNumber: null, tag: 'Pressure Groups' },
  { topicName: T9, questionText: '88. Role of farmer associations', pageNumber: null, tag: 'Pressure Groups' },

  { topicName: T10, questionText: '89. Parliamentary systems of India and the UK', pageNumber: null, tag: 'World Constitutions' },
  { topicName: T10, questionText: '90. Fundamental Rights (India) vs Bill of Rights (US)', pageNumber: null, tag: 'World Constitutions' },
  { topicName: T10, questionText: '91. Affirmative action – India vs the United States', pageNumber: null, tag: 'World Constitutions' },
  { topicName: T10, questionText: '92. Legislative processes of India, the USA and the UK', pageNumber: null, tag: 'World Constitutions' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  // 01. Historical underpinnings, features, amendments, basic structure
  { questionText: 'Indian Constitution has conferred the amending power on the ordinary legislative institutions with a few procedural hurdles. In view of this statement, examine the procedural and substantive limitations on the amending power of the Parliament to change the Constitution.', section: 'Amendment of the Constitution', year: 2025 },
  { questionText: '"Parliament\'s power to amend the Constitution is a limited power and it cannot be enlarged into absolute power." In the light of this statement explain whether Parliament under Article 368 of the Constitution can destroy the Basic Structure of the Constitution by expanding its amending power?', section: 'Amendment of the Constitution', year: 2019 },
  { questionText: "Explain the salient features of the constitution (One Hundred and First Amendment) Act, 2016. Do you think it is efficacious enough 'to remove cascading effect of taxes and provide for common national market for goods and services'?", section: 'Amendment of the Constitution', year: 2017 },

  { questionText: 'Explain the constitutional perspectives of Gender Justice with the help of relevant Constitutional Provisions and case laws.', section: 'Fundamental Rights', year: 2023 },
  { questionText: 'The most significant achievement of modern law in India in the constitutionalization of environmental problems by the Supreme Court. Discuss this statement with the help of relevant case laws.', section: 'Supreme Court', year: 2022 },
  { questionText: 'What was held in the Coelho case? In this context, can you say that judicial review is of key importance amongst the basic features of the Constitution?', section: 'Basic Structure of the Constitution', year: 2016 },

  { questionText: '"Constitutional morality is the fulcrum which acts as an essential check upon the high functionaries and citizens alike..." In view of the above observation of the Supreme Court, explain the concept of constitutional morality and its application to ensure balance between judicial independence and judicial accountability in India.', section: 'Constitutional Morality', year: 2025 },
  { questionText: "'Constitutional Morality' is rooted in the Constitution itself and is founded on its essential facets. Explain the doctrine of 'Constitutional Morality' with the help of relevant judicial decisions.", section: 'Constitutional Morality', year: 2021 },

  { questionText: 'Did the Government of India Act, 1935 lay down a federal constitution? Discuss.', section: 'Historical Background', year: 2016 },

  { questionText: 'Discuss the possible factors that inhibit India from enacting for its citizens a uniform civil code as provided for in the Directive Principles of State Policy.', section: 'DPSP', year: 2015 },

  { questionText: 'Right to privacy is intrinsic to life and personal liberty and is inherently protected under Article 21 of the Constitution. Explain. In this reference discuss the law relating to D.N.A. testing of a child in the womb to establish its paternity.', section: 'Fundamental Rights', year: 2024 },
  { questionText: '"The Constitution of India is a living instrument with capabilities of enormous dynamism. It is a constitution made for a progressive society". Illustrate with special reference to the expanding horizons of the right to life and personal liberty.', section: 'Fundamental Rights', year: 2023 },
  { questionText: 'Right of movement and residence throughout the territory of India are freely available to the Indian citizens, but these rights are not absolute. Comment', section: 'Fundamental Rights', year: 2022 },
  { questionText: 'Examine the scope of Fundamental Rights in the light of the latest judgement of the Supreme Court on Right to Privacy.', section: 'Fundamental Rights', year: 2017 },
  { questionText: 'Does the right to clean environment entail legal regulations on burning crackers during Diwali? Discuss in the light of Article 21 of the Indian Constitution and Judgement(s) of the Apex Court in this regard.', section: 'Fundamental Rights', year: 2015 },
  { questionText: 'What do you understand by the concept "freedom of speech and expression"? Does it cover hate speech also? Why do the films in India stand on a slightly different plane from other forms of expression? Discuss.', section: 'Fundamental Rights', year: 2014 },
  { questionText: 'Discuss Section 66A of IT Act, with reference to its alleged violation of Article 19 of the Constitution.', section: 'Fundamental Rights', year: 2013 },

  { questionText: "Discuss each adjective attached to the word 'Republic' in the preamble. Are they defendable in the present circumstances?", section: 'Preamble of the Constitution', year: 2016 },

  // 02. Union-State functions, federal structure issues
  { questionText: 'Account for the legal and political factors responsible for the reduced frequency of using Article 356 by the Union Governments since mid 1990s.', section: 'Emergency Provisions', year: 2023 },
  { questionText: 'Under what circumstances can the Financial Emergency be proclaimed by the President of India? What consequences follow when such a declaration remains in force?', section: 'Emergency Provisions', year: 2018 },

  { questionText: 'Examine the evolving pattern of Centre-State financial relations in the context of planned development in India. How far have the recent reforms impacted the fiscal federalism in India?', section: 'Centre-State Relations', year: 2025 },
  { questionText: 'What changes has the Union Government recently introduced in the domain of Centre-State relations? Suggest measures to be adopted to build the trust between the Centre and the States and for strengthening federalism.', section: 'Centre-State Relations', year: 2024 },
  { questionText: 'Explain the significance of the 101st Constitutional Amendment Act. To what extent does it reflect the accommodative spirit of federalism?', section: 'GST Council', year: 2023 },
  { questionText: 'How far do you think cooperation, competition and confrontation have shaped the nature of federation in India? Cite some recent examples to validate your answer.', section: 'Centre-State Relations', year: 2020 },
  { questionText: 'Indian Constitution exhibits centralising tendencies to maintain unity and integrity of the nation. Elucidate in the perspective of the Epidemic Diseases Act, 1897; The Disaster Management Act, 2005 and recently passed Farm Acts.', section: 'Centre-State Relations', year: 2020 },
  { questionText: "From the resolution of contentious issues regarding distribution of legislative powers by the courts, 'Principle of Federal Supremacy' and 'Harmonious Construction' have emerged. Explain.", section: 'Centre-State Relations', year: 2019 },
  { questionText: 'The concept of cooperative federalism has been increasingly emphasized in recent years. Highlight the drawbacks in the existing structure and the extent to which cooperative federalism would answer the shortcomings.', section: 'Centre-State Relations', year: 2015 },
  { questionText: 'Though the federal principle is dominant in our Constitution and that principle is one of its basic features, but it is equally true that federalism under the Indian Constitution leans in favour of a strong Centre, a feature that militates against the concept of strong federalism. Discuss.', section: 'Centre-State Relations', year: 2014 },
  { questionText: 'Many State Governments further bifurcate geographical administrative areas like Districts and Talukas for better governance. In light of the above, can it also be justified that more number of smaller States would bring in effective governance at State level? Discuss.', section: 'Centre-State Relations', year: 2013 },
  { questionText: 'Constitutional mechanisms to resolve the inter-state water disputes have failed to address and solve the problems. Is the failure due to structural or process inadequacy or both? Discuss.', section: 'Inter-State Relations', year: 2013 },

  { questionText: 'Discuss the essentials of the 69th Constitutional Amendment Act and anomalies, if any that have led to recent reported conflicts between the elected representatives and the institution of the Lieutenant Governor in the administration of Delhi. Do you think that this will give rise to a new trend in the functioning of the Indian federal politics?', section: 'Governor', year: 2016 },

  { questionText: 'To what extent is Article 370 of the Indian Constitution, bearing marginal note "Temporary provision with respect to the State of Jammu and Kashmir", temporary? Discuss the future prospects of this provision in the context of Indian polity.', section: T2, year: 2016 },
  { questionText: "Recent directives from Ministry of Petroleum and Natural Gas are perceived by the `Nagas' as a threat to override the exceptional status enjoyed by the State. Discuss in light of Article 371A of the Indian Constitution.", section: T2, year: 2013 },

  { questionText: 'Discuss the nature of Jammu and Kashmir Legislative Assembly after the Jammu and Kashmir Reorganization Act, 2019. Briefly describe the powers and functions of the Assembly of the Union Territory of Jammu and Kashmir.', section: 'Union and its Territory', year: 2025 },

  // 03. Separation of powers, dispute redressal
  { questionText: '"The growth of cabinet system has practically resulted in the marginalisation of the parliamentary supremacy." Elucidate.', section: 'Cabinet Committees', year: 2024 },
  { questionText: 'To what extent, in your view, the Parliament is able to ensure accountability of the executive in India?', section: 'Parliament', year: 2021 },
  { questionText: 'Resorting to ordinances has always raised concern on violation of the spirit of separation of powers doctrine. While noting the rationales justifying the power to promulgate ordinances, analyze whether the decisions of the Supreme Court on the issue have further facilitated resorting to this power. Should the power to promulgate ordinances be repealed?', section: 'President', year: 2015 },

  { questionText: 'Discuss the essential conditions for exercise of the legislative powers by the Governor. Discuss the legality of re-promulgation of ordinances by the Governor without placing them before the Legislature.', section: 'State Legislature', year: 2022 },

  { questionText: 'Whether the Supreme Court Judgement (July 2018) can settle the political tussle between the Lt. Governor and elected government of Delhi? Examine.', section: 'Governor', year: 2018 },

  { questionText: "Critically examine the Supreme Court's judgement on 'National Judicial Appointments Commission Act, 2014' with reference to appointment of judges of higher judiciary in India.", section: 'Supreme Court', year: 2017 },

  { questionText: 'Judicial Legislation is antithetical to the doctrine of separation of powers as envisaged in the Indian Constitution. In this context justify the filing of large number of public interest petitions praying for issuing guidelines to executive authorities.', section: 'Judiciary (General)', year: 2020 },
  { questionText: 'The Supreme Court of India keeps a check on arbitrary power of the Parliament in amending the Constitution. Discuss critically.', section: 'Basic Structure of the Constitution', year: 2013 },

  { questionText: '"Constitutionally guaranteed judicial independence is a prerequisite of democracy". Comment.', section: 'Judiciary (General)', year: 2023 },
  { questionText: "Do you think that constitution of India does not accept principle of strict separation of powers rather it is based on the principle of 'checks and balance'? Explain.", section: 'Salient Features of the Constitution', year: 2019 },

  // 04. Devolution to local levels
  { questionText: 'Analyse the role of local bodies in providing good governance at local level and bring out the pros and cons merging the rural local bodies with the urban local bodies.', section: 'Panchayati Raj & Local Government', year: 2024 },
  { questionText: '"The states in India seem reluctant to empower urban local bodies both functionally as well as financially." Comment.', section: 'Panchayati Raj & Local Government', year: 2023 },
  { questionText: 'To what extent, in your opinion, has the decentralisation of power in India changed the governance landscape at the grassroots?', section: 'Panchayati Raj & Local Government', year: 2022 },
  { questionText: "The strength and sustenance of local institutions in India has shifted from their formative phase of 'Functions, Functionaries and Funds' to the contemporary stage of 'Functionality'. Highlight the critical challenges faced by local institutions in terms of their functionality in recent times.", section: 'Panchayati Raj & Local Government', year: 2020 },
  { questionText: '"The reservation of seats for women in the institutions of local self-government has had a limited impact on the patriarchal character of the Indian Political Process." Comment.', section: 'Panchayati Raj & Local Government', year: 2019 },
  { questionText: 'Assess the importance of Panchayat system in India as a part of local government. Apart from government grants, what sources the Panchayats can look out for financing developmental projects.', section: 'Panchayati Raj & Local Government', year: 2018 },
  { questionText: '"The local self-government system in India has not proved to be effective instrument of governance". Critically examine the statement and give your views to improve the situation.', section: 'Panchayati Raj & Local Government', year: 2017 },
  { questionText: "In absence of a well-educated and organized local level government system, `Panchayats' and 'Samitis' have remained mainly political institutions and not effective instruments of governance. Critically discuss.", section: 'Panchayati Raj & Local Government', year: 2015 },

  // 05. Comparison with other constitutions
  { questionText: 'Discuss the evolution of collegium system in India. Critically examine the advantages and disadvantages of the system on appointment of the Judges of the Supreme Court of India and that of the USA.', section: 'World Constitutions', year: 2025 },
  { questionText: "Compare and contrast the President's power to pardon in India and in the USA. Are there any limits to it in both the countries? What are 'preemptive pardons'?", section: 'World Constitutions', year: 2025 },
  { questionText: 'Discuss India as a secular state and compare with the secular principles of the US constitution.', section: 'World Constitutions', year: 2024 },
  { questionText: 'Compare and contrast the British and Indian approaches to Parliamentary sovereignty.', section: 'World Constitutions', year: 2023 },
  { questionText: 'Critically examine the procedures through which the Presidents of India and France are elected.', section: 'World Constitutions', year: 2022 },
  { questionText: 'Analyze the distinguishing features of the notion of Right to Equality in the Constitutions of the USA and India.', section: 'World Constitutions', year: 2021 },
  { questionText: 'The judicial systems in India and UK seem to be converging as well as diverging in recent times. Highlight the key points of convergence and divergence between the two nations in terms of their judicial practices.', section: 'World Constitutions', year: 2020 },
  { questionText: "What can France learn from the Indian Constitution's approach to secularism?", section: 'World Constitutions', year: 2019 },
  { questionText: 'India and USA are two large democracies. Examine the basic tenets on which the two political systems are based.', section: 'World Constitutions', year: 2018 },

  // 06. Parliament and State Legislatures
  { questionText: 'Explain the structure of the Parliamentary Committee system. How far have the financial committees helped in the institutionalization of Indian Parliament?', section: 'Parliamentary Committees', year: 2023 },
  { questionText: 'Do Department-related Parliamentary Standing Committees keep the administration on its toes and inspire reverence for parliamentary control? Evaluate the working of such committees with suitable examples.', section: 'Parliamentary Committees', year: 2021 },
  { questionText: 'Why do you think the committees are considered to be useful for parliamentary work? Discuss, in this context, the role or the Estimates Committee.', section: 'Parliamentary Committees', year: 2018 },
  { questionText: 'Discuss the role of Public Accounts Committee in establishing accountability of the government to the people.', section: 'Parliamentary Committees', year: 2017 },

  { questionText: 'Explain the constitutional provisions under which Legislative Councils are established. Review the working and current status of Legislative Councils with suitable illustrations.', section: 'State Legislature', year: 2021 },
  { questionText: "Rajya Sabha has been transformed from a 'useless stepney tyre' to the most useful supporting organ in past few decades. Highlight the factors as well as the areas in which this transformation could be visible.", section: 'Parliamentary System', year: 2020 },
  { questionText: 'The Indian Constitution has provisions for holding joint session of the two houses of the Parliament. Enumerate the occasions when this would normally happen and also the occasions when it cannot, with reasons thereof.', section: 'Parliament', year: 2017 },

  { questionText: 'Discuss the role of Presiding Officers of state legislatures in maintaining order and impartiality in conducting legislative work and in facilitating best democratic practices.', section: T4, year: 2023 },
  { questionText: 'Discuss the role of the Vice-President of India as the Chairman of the Rajya Sabha.', section: 'Vice-President', year: 2022 },
  { questionText: "'Once a Speaker, Always a Speaker'! Do you think this practice should be adopted to impart objectivity to the office of the Speaker of Lok Sabha? What could be its implications for the robust functioning of parliamentary business in India?", section: T3, year: 2020 },

  { questionText: "The 'Powers, Privileges and Immunities of Parliament and its Members' as envisaged in Article 105 of the Constitution leave room for a large number of un-codified and un-enumerated privileges to continue. Assess the reasons for the absence of legal codification of the 'parliamentary privileges'. How can this problem be addressed?", section: 'Parliament', year: 2014 },

  { questionText: "Individual Parliamentarian's role as the national lawmaker is on a decline, which in turn, has adversely impacted the quality of debates and their outcome. Discuss.", section: 'Parliament', year: 2019 },
  { questionText: 'The role of individual MPs (Members of Parliament) has diminished over the years and as a result healthy constructive debates on policy issues are not usually witnessed. How far can this be attributed to the anti-defection law, which was legislated but with a different intention?', section: 'Anti-Defection Law', year: 2013 },

  // 07. Executive & Judiciary structure, pressure groups
  { questionText: 'Explain and distinguish between Lok Adalats and Arbitration Tribunals. Whether they entertain civil as well as criminal cases?', section: 'Tribunals', year: 2024 },
  { questionText: "Who are entitled to receive free legal aid? Assess the role of the National Legal Services Authority (NALSA) in rendering free legal aid in India.", section: 'Tribunals', year: 2023 },
  { questionText: "What are the major changes brought in the Arbitration and Conciliation Act, 1996 through the recent Ordinance promulgated by the President? How far will it improve India's dispute resolution mechanism? Discuss.", section: 'Tribunals', year: 2015 },

  { questionText: 'The Attorney General of India plays a crucial role in guiding the legal framework of the Union Government and ensuring sound governance through legal counsel." Discuss his responsibilities, rights and limitations in this regard.', section: 'Attorney General', year: 2025 },
  { questionText: '"The Attorney-General is the chief legal adviser and lawyer of the Government of India." Discuss.', section: 'Attorney General', year: 2019 },

  { questionText: 'Khap Panchayats have been in the news for functioning as extra-constitutional authorities, often delivering pronouncements amounting to human rights violations. Discuss critically the actions taken by the legislative, executive and the judiciary to set the things right in this regard.', section: 'Pressure Groups', year: 2015 },

  { questionText: "Explain the reasons for the growth of public interest litigation in India. As a result of it, has the Indian Supreme Court emerged as the world's most powerful judiciary?", section: 'Judiciary (General)', year: 2024 },
  { questionText: 'Discuss the desirability of greater representation to women in the higher judiciary to ensure diversity, equity and inclusiveness.', section: 'Judiciary (General)', year: 2021 },
  { questionText: "Starting from inventing the 'basic structure' doctrine, the judiciary has played a highly proactive role in ensuring that India develops into a thriving democracy. In light of the statement, evaluate the role played by judicial activism in achieving the ideals of democracy.", section: 'Judicial Activism', year: 2014 },

  { questionText: "Instances of President's delay in commuting death sentences has come under public debate as denial of justice. Should there be a time limit specified for the President to accept/reject such petitions? Analyse.", section: 'President', year: 2014 },

  { questionText: 'What are environmental pressure groups? Discuss their role in raising awareness, influencing policies and advocating for environmental protection in India.', section: 'Pressure Groups', year: 2025 },
  { questionText: '"Pressure groups play a vital role in influencing public policy making in India." Explain how the business associations contribute to public policies.', section: 'Pressure Groups', year: 2021 },
  { questionText: 'What are the methods used by the Farmers organizations to influence the policymakers in India and how effective are these methods?', section: 'Pressure Groups', year: 2019 },
  { questionText: 'How do pressure groups influence Indian political process? Do you agree with this view that informal pressure groups have emerged as powerful than formal pressure groups in recent years?', section: 'Pressure Groups', year: 2017 },
  { questionText: 'Pressure group politics is sometimes seen as the informal face of politics. With regards to the above, assess the structure and functioning of pressure groups in India.', section: 'Pressure Groups', year: 2013 },

  { questionText: 'Comment on the need for administrative tribunals as compared to the court system. Assess the impact of the recent tribal reforms through rationalisation of tribunals made in 2021.', section: 'Tribunals', year: 2025 },

  { questionText: 'The size of the cabinet should be as big as governmental work justifies and as big as the Prime Minister can manage as a team. How far the efficacy of a government then is inversely related to the size of the cabinet? Discuss.', section: 'Central Council of Ministers', year: 2014 },

  // 08. Representation of the People's Act
  { questionText: 'While the national political parties in India favour centralisation, the regional parties are in favour of State autonomy. Comment.', section: T9, year: 2022 },
  { questionText: 'The Indian party system is passing through a phase of transition which looks to be full of contradictions and paradoxes." Discuss.', section: T9, year: 2016 },

  { questionText: "Discuss the 'corrupt practices' for the purpose of the Representation of the People Act, 1951. Analyze whether the increase in the assets of the legislators and/or their associates, disproportionate to their known sources of income, would constitute 'undue influence' and consequently a corrupt practice.", section: 'Election Commission', year: 2025 },
  { questionText: 'Discuss the procedures to decide the disputes arising out of the election of a Member of the Parliament or State Legislature under The Representation of the People Act, 1951. What are the grounds on which the election of any returned candidate may be declared void? What remedy is available to the aggrieved party against the decision? Refer to the case laws.', section: 'Election Commission', year: 2022 },
  { questionText: '"There is a need for simplification of procedure for disqualification of persons found guilty of corrupt practices under the Representation of Peoples Act". Comment.', section: 'Election Commission', year: 2020 },
  { questionText: "On what grounds a people's representative can be disqualified under the Representation of People Act, 1951? Also mention the remedies available to such person against his disqualification.", section: 'Election Commission', year: 2019 },

  { questionText: 'Examine the need for electoral reforms as suggested by various committees with particular reference to "one nation-one election" principle.', section: 'Electoral Reforms', year: 2024 },
  { questionText: 'In the light of recent controversy regarding the use of Electronic Voting Machines (EVM), what are the challenges before the Election Commission of India to ensure the trustworthiness of elections in India?', section: 'Electoral Reforms', year: 2018 },
  { questionText: "'Simultaneous election to the Lok Sabha and the State Assemblies will limit the amount of time and money spent in electioneering but it will reduce the government's accountability to the people' Discuss.", section: 'Electoral Reforms', year: 2017 },
  { questionText: 'To enhance the quality of democracy in India the Election Commission of India has proposed electoral reforms in 2016. What are the suggested reforms and how far are they significant to make democracy successful?', section: 'Electoral Reforms', year: 2017 },

  { questionText: 'Discuss the role of the Election Commission of India in the light of the evolution of the Model Code of Conduct', section: 'Model Code of Conduct', year: 2016 }
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

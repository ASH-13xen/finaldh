// One-time import of Progress checklist + PYQ data for the "MMF - GS-1" file inside the existing
// "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same course+fileIndex-scoped
// approach as import_mmf_ir_progress.mjs.
//
// This is a CONSOLIDATED file bundling three subjects (History, Geography, Society), each with
// its own brand-new chapter/sub-heading index (with page numbers) that is materially different
// from - and more current-affairs-focused than - the standalone MMF-Art and Culture /
// MMF-Modern History / MMF - World History / MMF-Society / MMF - Geography files built earlier.
// Per the user's explicit instruction, NO new PYQs were sourced for this file: every PYQ here is
// reused verbatim (questionText + year) from those five standalone files' existing ProgressPyq
// data, re-classified against this new GS-1 index. Because this index is far more condensed
// (~80 items total vs. hundreds in the standalone books), most PYQs land on a Chapter-level
// fallback (the topic name itself) rather than a specific sub-heading tag - only a minority of
// PYQs have a genuinely precise new-index match.
//
// "Post-Independence" (Chapter 5 under History) is included in the checklist (page numbers were
// given) but deliberately has ZERO PYQs - the user said this subject's PYQs will be supplied
// later, and none of the reused subjects' existing PYQs were force-fit into it.
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
const TARGET_FILE_NAME = 'MMF - GS-1';

// ---- History ----
const H1 = 'History – Chapter 1: Indian Art & Culture';
const H2 = 'History – Chapter 2: Ancient India';
const H3 = 'History – Chapter 3: Medieval India';
const H4 = 'History – Chapter 4: Modern India – Freedom Struggle';
const H5 = 'History – Chapter 5: Post-Independence';
const H6 = 'History – Chapter 6: World History';
// ---- Geography ----
const G1 = 'Geography – Chapter 1: Geomorphology & Tectonics';
const G2 = 'Geography – Chapter 2: Climatology & Oceanography';
const G3 = 'Geography – Chapter 3: Indian Physical Geography';
const G4 = 'Geography – Chapter 4: Resource Geography';
const G5 = 'Geography – Chapter 5: Geospatial Applications';
// ---- Society ----
const S1 = 'Society – Chapter 1: Diversity & Salient Features';
const S2 = 'Society – Chapter 2: Women & Gender';
const S3 = 'Society – Chapter 3: Caste & Communalism';
const S4 = 'Society – Chapter 4: Globalization & Urbanization';
const S5 = 'Society – Chapter 5: Population & Vulnerable Sections';

const CHECKLIST_ROWS = [
  { topicName: H1, questionText: '1.1 Indian Temple Architecture – Diversity and Unity', pageNumber: 1, tag: '' },
  { topicName: H1, questionText: '1.2 Chandella Art & Sculpture', pageNumber: 2, tag: 'Chandella' },
  { topicName: H1, questionText: '1.3 Kakatiyas of Warangal – Contributions to Art and Culture', pageNumber: 3, tag: '' },
  { topicName: H1, questionText: '1.4 Bhojpur Region – Dual Sun-Worship Tradition', pageNumber: 4, tag: '' },
  { topicName: H1, questionText: '1.5 Thirukkural: A Living Constitution for Humanity', pageNumber: 5, tag: '' },
  { topicName: H1, questionText: '1.6 Prehistoric Paintings as Reflections of Social Life', pageNumber: 5, tag: 'Prehistoric Art' },
  { topicName: H1, questionText: "1.7 Jammu-Kashmir & Ladakh's Contribution to Buddhism", pageNumber: 7, tag: '' },

  { topicName: H2, questionText: "2.1 Ashoka's Dhamma as Governance Tool", pageNumber: 8, tag: '' },
  { topicName: H2, questionText: '2.2 Scientific Literature in Ancient India', pageNumber: 9, tag: '' },

  { topicName: H3, questionText: "3.1 Akbar's Religious Syncretism", pageNumber: 10, tag: 'Akbar' },
  { topicName: H3, questionText: '3.2 Persian Literary Sources of Medieval India', pageNumber: 11, tag: 'Persian Literary Sources' },

  { topicName: H4, questionText: '4.1 British Economic Policy – Integration at a Cost', pageNumber: 12, tag: 'British Economic Policy' },
  { topicName: H4, questionText: "4.2 Gandhi's Non-Cooperation-Khilafat Alignment", pageNumber: 13, tag: 'NCM Khilafat' },
  { topicName: H4, questionText: '4.3 Indian National Movement as a Decolonisation Catalyst', pageNumber: 14, tag: 'Decolonisation Catalyst' },
  { topicName: H4, questionText: "4.4 Gandhi's Entry & the Freedom Struggle", pageNumber: 15, tag: '' },
  { topicName: H4, questionText: '4.5 Indian National Movement as a Multi-Class Movement', pageNumber: 16, tag: 'Multi-Class Movement' },
  { topicName: H4, questionText: '4.6 Mahatma Jotirao Phule – Writings and Social Reform', pageNumber: 17, tag: 'Phule' },
  { topicName: H4, questionText: '4.7 Sardar Patel – Contribution to Pre- and Post-Independent India', pageNumber: 18, tag: '' },
  { topicName: H4, questionText: '4.8 Dadabhai Naoroji: Multifaceted Contributions', pageNumber: 19, tag: '' },
  { topicName: H4, questionText: '4.9 Sardar Patel & the Political Integration of India', pageNumber: 20, tag: '' },

  { topicName: H5, questionText: '5.1 Balancing Unity and Regional Aspirations Post-1947', pageNumber: 21, tag: '' },
  { topicName: H5, questionText: '5.2 Indus Waters Treaty (1960)', pageNumber: 22, tag: '' },

  { topicName: H6, questionText: '6.1 French Revolution: Achievements vs Limitations', pageNumber: 23, tag: 'French Revolution' },
  { topicName: H6, questionText: '6.2 Napoleon – Child and Betrayer of the French Revolution', pageNumber: 24, tag: '' },
  { topicName: H6, questionText: "6.3 Capitalism's Divergent Evolution: Global North vs South", pageNumber: 25, tag: '' },

  { topicName: G1, questionText: '1.1 Tectonics, Earthquakes and Volcanism', pageNumber: 27, tag: 'Continental Drift & Plate Tectonics;Volcanoes' },
  { topicName: G1, questionText: '1.2 Plate Tectonics & Himalayan Formation', pageNumber: 28, tag: '' },
  { topicName: G1, questionText: '1.3 Tectonic Movements – Changing Shape of Continents and Ocean Basins', pageNumber: 30, tag: 'Continental Drift & Plate Tectonics' },
  { topicName: G1, questionText: '1.4 Formation & Significance of the Aravalli Hills', pageNumber: 31, tag: '' },

  { topicName: G2, questionText: '2.1 Genesis of the Loo and Its Cultural Imprint', pageNumber: 32, tag: '' },
  { topicName: G2, questionText: '2.2 Why Cherrapunji-Mawsynram Is Wettest Yet Water-Scarce', pageNumber: 33, tag: '' },
  { topicName: G2, questionText: '2.3 Wind Systems, Ocean Currents and Hemispheric Gyres', pageNumber: 34, tag: 'Ocean Currents' },
  { topicName: G2, questionText: '2.4 Tsunamis: Causes, Distribution & Consequences', pageNumber: 35, tag: 'Tsunami' },
  { topicName: G2, questionText: '2.5 Local Winds vs Planetary Winds', pageNumber: 36, tag: '' },
  { topicName: G2, questionText: '2.6 Western Disturbances – Influence on Climate and Inhabitants', pageNumber: 38, tag: '' },
  { topicName: G2, questionText: "2.7 Earth's Thermal Contrasts – Causes and Consequences", pageNumber: 39, tag: '' },
  { topicName: G2, questionText: '2.8 Climate Change and Sea Level Rise – Threat to Island Nations', pageNumber: 40, tag: 'Polar Ice Melting' },
  { topicName: G2, questionText: '2.9 Unpredictability of the South-West Monsoon', pageNumber: 41, tag: 'Monsoon Climate' },
  { topicName: G2, questionText: '2.10 AMOC Weakening: Global & Indian Implications', pageNumber: 42, tag: '' },

  { topicName: G3, questionText: '3.1 Deccan Plateau – Farming Limits, Mineral Wealth', pageNumber: 43, tag: 'Deccan Trap' },
  { topicName: G3, questionText: '3.2 Shrinking Inland Water Bodies', pageNumber: 44, tag: '' },
  { topicName: G3, questionText: '3.3 Soil Formation & Distribution in India', pageNumber: 45, tag: '' },
  { topicName: G3, questionText: "3.4 India's Revised Coastline Length – Reasons and Significance", pageNumber: 47, tag: 'Coastline' },
  { topicName: G3, questionText: '3.5 Rivers as Natural Archives', pageNumber: 48, tag: '' },

  { topicName: G4, questionText: '4.1 Copper as a Critical Mineral', pageNumber: 48, tag: '' },
  { topicName: G4, questionText: '4.2 Non-Farm Primary Activities & Physiography', pageNumber: 50, tag: 'Non-Farm Primary Activities' },
  { topicName: G4, questionText: '4.3 Off-Shore vs On-Shore Oil Reserves', pageNumber: 51, tag: 'Oil Reserves' },
  { topicName: G4, questionText: "4.4 Oil's Transformation of the Persian Gulf & the Strait of Hormuz", pageNumber: 52, tag: '' },
  { topicName: G4, questionText: '4.5 Causes of Regional Disparities in Economic Development', pageNumber: 53, tag: '' },

  { topicName: G5, questionText: '5.1 AI, Drones, GIS & RS in Spatial Planning', pageNumber: 54, tag: 'AI Spatial Planning' },

  { topicName: S1, questionText: '1.1 Mosaic, Melting Pot, or Hierarchical Continuum', pageNumber: 57, tag: 'Salient Features of Indian Society' },
  { topicName: S1, questionText: '1.2 The Cult of Hero-Worship in Indian Society', pageNumber: 58, tag: '' },

  { topicName: S2, questionText: '2.1 The Construction of Masculinity – Costs for Both Sexes', pageNumber: 59, tag: '' },
  { topicName: S2, questionText: '2.2 Gendered Nature of Public Spaces', pageNumber: 60, tag: '' },
  { topicName: S2, questionText: '2.3 Feminization of Agriculture', pageNumber: 61, tag: 'Feminization of Agriculture' },
  { topicName: S2, questionText: '2.4 Gender Conflicts within Indian Families – Causes and the Role of Law', pageNumber: 62, tag: '' },
  { topicName: S2, questionText: "2.5 Soft Patriarchy in Women's Professional Experiences", pageNumber: 63, tag: 'Patriarchy' },

  { topicName: S3, questionText: '3.1 Communalism – Law and Social Transformation', pageNumber: 64, tag: 'Communalism' },
  { topicName: S3, questionText: '3.2 Honour Killings & Dalit Empowerment Paradox', pageNumber: 65, tag: 'Dalit' },
  { topicName: S3, questionText: '3.3 Nationwide Caste Census', pageNumber: 66, tag: '' },
  { topicName: S3, questionText: '3.4 Caste System – Resilience and Changing Dynamics', pageNumber: 67, tag: 'Caste System' },
  { topicName: S3, questionText: '3.5 Tolerance, Assimilation & Pluralism in Indian Secularism', pageNumber: 68, tag: 'Secularism' },

  { topicName: S4, questionText: '4.1 Climate Change as a Question of Urban Inequality', pageNumber: 69, tag: '' },
  { topicName: S4, questionText: '4.2 Globalisation-Driven Migration and Metro Culture', pageNumber: 70, tag: 'Migration' },
  { topicName: S4, questionText: '4.3 Premiumisation of Consumption in India', pageNumber: 71, tag: 'Consumer Culture' },
  { topicName: S4, questionText: '4.4 Globalization & the Rural-Urban Divide', pageNumber: 72, tag: '' },
  { topicName: S4, questionText: '4.5 Regional Rapid Transit System (RRTS) – Significance', pageNumber: 73, tag: '' },
  { topicName: S4, questionText: '4.6 Globalization and the Democratization of Desires', pageNumber: 75, tag: '' },
  { topicName: S4, questionText: '4.7 Smart Cities Mission – Addressing Urban Poverty and Distributive Justice', pageNumber: 76, tag: 'Urban Poverty' },
  { topicName: S4, questionText: '4.8 Sustainable Growth, Environmental Protection and the Poor', pageNumber: 77, tag: 'Sustainable Growth' },
  { topicName: S4, questionText: '4.9 Regional Rapid Transit Systems & Urban Problems', pageNumber: 79, tag: 'Urban Planning' },
  { topicName: S4, questionText: '4.10 Impact of 10-Minute Delivery Services', pageNumber: 80, tag: '' },
  { topicName: S4, questionText: '4.11 Mobility vs Migration: Rural-Urban Migration in India', pageNumber: 81, tag: 'Urbanisation' },
  { topicName: S4, questionText: '4.12 Globalisation: Cultural Homogenisation vs Local Assertion', pageNumber: 82, tag: 'Globalisation & Culture' },

  { topicName: S5, questionText: "5.1 India's Ageing: Challenge or Opportunity", pageNumber: 83, tag: 'Ageing' },
  { topicName: S5, questionText: "5.2 Transgenders: A 'Visibly Invisible' Community", pageNumber: 84, tag: '' },
  { topicName: S5, questionText: '5.3 Civil Service Ethos – Professionalism and Nationalistic Consciousness', pageNumber: 85, tag: 'Civil Service Ethos' },
  { topicName: S5, questionText: '5.4 Digital Gaming vs Outdoor Play – Impact on Socialization of Children', pageNumber: 86, tag: 'Family' },
  { topicName: S5, questionText: "5.5 GenAI's Contribution to Academic Stress", pageNumber: 87, tag: '' },
  { topicName: S5, questionText: "5.6 India's Ageing: Challenge vs Intergenerational Opportunity", pageNumber: 88, tag: '' }
];

// ================= PYQs, reused verbatim from the 5 standalone subject files =================
const PYQ_ROWS = [
  // ---- from MMF-Art and Culture ----
  { questionText: 'Evaluate the nature of the Bhakti literature and its contribution to Indian culture.', section: H3, year: 2021 },
  { questionText: 'The Bhakti movement received a remarkable re-orientation with the advent of Sri Chaitanya Mahaprabhu. Discuss.', section: H3, year: 2018 },
  { questionText: 'Sufis and medieval mystic saints failed to modify either the religious ideas and practices or the outward structure of Hindu/Muslim societies to any appreciable extent. Comment.', section: H3, year: 2014 },
  { questionText: 'Pala period is the most significant phase in the history of Buddhism in India. Enumerate.', section: H2, year: 2020 },
  { questionText: 'Highlight the Central Asian and Greco-Bactrian elements in Gandhara art.', section: H2, year: 2019 },
  { questionText: 'Early Buddhist Stupa-art, while depicting folk motifs and narratives successfully expounds Buddhist ideals. Elucidate.', section: H2, year: 2016 },
  { questionText: 'Gandhara sculpture owed as much to the Romans as to the Greeks. Explain.', section: H2, year: 2014 },
  { questionText: 'Explain the role of geographical factors towards the development of Ancient India.', section: H2, year: 2023 },
  { questionText: 'Taxila university was one of the oldest universities of the world with which were associated a number of renowned learned personalities of different disciplines. Its strategic location caused its fame to flourish, but unlike Nalanda, it is not considered as a university in the modern sense. Discuss.', section: H2, year: 2014 },
  { questionText: "Examine the main aspects of Akbar's religious syncretism.", section: 'Akbar', year: 2025 },
  { questionText: 'The rock-cut architecture represents one of the most important sources of our knowledge of early Indian art and history. Discuss.', section: H1, year: 2020 },
  { questionText: 'Indian philosophy and tradition played a significant role in conceiving and shaping the monuments and their art in India. Discuss.', section: H1, year: 2020 },
  { questionText: 'Mesolithic rock cut architecture of India not only reflects the cultural life of the times but also a tine aesthetic sense comparable to modern painting. Critically evaluate this comment.', section: 'Prehistoric Art', year: 2015 },
  { questionText: 'Discuss the Tandava dance as recorded in the early Indian inscriptions.', section: H1, year: 2013 },
  { questionText: 'Safeguarding the Indian art heritage is the need of the moment. Discuss.', section: H1, year: 2018 },
  { questionText: 'Assess the importance of the accounts of the Chinese and Arab travellers in the reconstruction of the history of India.', section: H2, year: 2018 },
  { questionText: 'Though not very useful from the point of view of a connected political history of South India, the Sangam literature portrays the social and economic conditions of its time with remarkable vividness. Comment.', section: H2, year: 2013 },
  { questionText: 'Discuss the salient features of the Harappan architecture.', section: H2, year: 2025 },
  { questionText: 'The ancient civilization in Indian sub-continent differed from those of Egypt, Mesopotamia and Greece in that its culture and traditions have been preserved without a breakdown to the present day. Comment.', section: H2, year: 2015 },
  { questionText: 'To what extent has the urban planning and culture of the Indus Valley Civilization provided inputs to the present day urbanization? Discuss.', section: H2, year: 2014 },
  { questionText: 'What were the major technological changes introduced during the Sultanate period? How did those technological changes influence the Indian society?', section: H3, year: 2023 },
  { questionText: 'Estimate the contribution of Pallavas of Kanchi for the development of art and literature of South India.', section: H2, year: 2024 },
  { questionText: 'Discuss the main contributions of Gupta period and Chola period to Indian heritage and culture.', section: H2, year: 2022 },
  { questionText: 'How do you justify the view that the level of excellence of Gupta numismatic art is not at all noticeable in later times?', section: H2, year: 2017 },
  { questionText: '"Though the great Cholas are no more yet their name is still remembered with great pride because of their highest achievements in the domain of art and architecture." Comment.', section: H2, year: 2024 },
  { questionText: 'Chola architecture represents a high watermark in the evolution of temple architecture. Discuss.', section: H2, year: 2013 },
  { questionText: 'Krishnadeva Raya, the King of Vijayanagar, was not only an accomplished scholar himself but was also a great patron of learning and literature. Discuss.', section: H3, year: 2016 },
  { questionText: "'The sculptors filled the Chandella artform with resilient vigor and breadth of life.' Elucidate.", section: 'Chandella', year: 2025 },
  { questionText: 'How will you explain that medieval Indian temple sculptures represent the social life of those days?', section: H1, year: 2022 },
  { questionText: 'Discuss the significance of the lion and bull figures in Indian mythology, art and architecture.', section: H1, year: 2022 },
  { questionText: 'Persian literary sources of medieval India reflect the spirit of the age. Comment.', section: 'Persian Literary Sources', year: 2020 },
  { questionText: 'Underline the changes in the field of society and economy from the Rig Vedic to the later Vedic period.', section: H2, year: 2024 },
  { questionText: 'What are the main features of Vedic society and religion? Do you think some of the features are still prevailing in Indian society?', section: H2, year: 2023 },

  // ---- from MMF-Modern History ----
  { questionText: 'The 1857 Uprising was the culmination the recurrent big and small local rebellions that had occurred in the preceding hundred years of British rule. Elucidate.', section: H4, year: 2019 },
  { questionText: 'Explain how the Uprising of 1857 constitutes an important watershed in the evolution of British policies towards colonial India.', section: H4, year: 2016 },
  { questionText: 'Examine how the decline of traditional artisanal industry in colonial India crippled the rural economy.', section: 'British Economic Policy', year: 2017 },
  { questionText: 'In many ways, Lord Dalhousie was the founder of modern India. Elaborate.', section: H4, year: 2013 },
  { questionText: 'Why was there a sudden spurt in famines in colonial India since the mid-eighteenth century? Give reasons.', section: 'British Economic Policy', year: 2022 },
  { questionText: 'In what ways did the naval mutiny prove to be the last nail in the coffin of British colonial aspirations in India?', section: H4, year: 2014 },
  { questionText: 'To what extent did the role of the Moderates prepare a base for the wider freedom movement? Comment.', section: H4, year: 2021 },
  { questionText: "Why did the 'Moderates' fail to carry conviction with the nation about their proclaimed ideology and political goals by the end of the nineteenth century?", section: H4, year: 2017 },
  { questionText: 'It would have been difficult for the Constituent Assembly to complete its historic task of drafting the Constitution for Independent India in just three years but for the experience gained with the Government of India Act, 1935. Discuss.', section: H4, year: 2015 },
  { questionText: 'Many voices had strengthened and enriched the nationalist movement during the Gandhian phase. Elaborate.', section: 'Multi-Class Movement', year: 2019 },
  { questionText: 'Assess the role of British imperial power in complicating the process of transfer of power during the 1940s.', section: H4, year: 2019 },
  { questionText: 'Clarify how mid-eighteenth century India was beset with the spectre of a fragmented polity.', section: H3, year: 2017 },
  { questionText: 'The third battle of Panipat was fought in 1761. Why were so many empire-shaking battles fought at Panipat?', section: H3, year: 2014 },
  { questionText: 'Why did the armies of the British East India Company - mostly comprising of Indian soldiers-win consistently against the more numerous and better equipped armies of the then Indian rulers? Give reasons.', section: H4, year: 2022 },
  { questionText: 'Examine critically the various facets of economic policies of the British in India from mid-eighteenth century till independence.', section: 'British Economic Policy', year: 2014 },
  { questionText: 'Bring out the constructive programmes of Mahatma Gandhi during Non-Cooperation Movement and Civil Disobedience Movement.', section: 'NCM Khilafat', year: 2021 },
  { questionText: 'Since the decade of the 1920s, the national movement acquired various ideological strands and thereby expanded its social base. Discuss.', section: 'Multi-Class Movement', year: 2020 },
  { questionText: 'Highlight the importance of the new objectives that got added to the vision of Indian independence since twenties of the last century.', section: 'Multi-Class Movement', year: 2017 },
  { questionText: 'What was the difference between Mahatma Gandhi and Rabindranath Tagore in their approach towards education and nationalism?', section: H4, year: 2023 },
  { questionText: 'Throw light on the significance of the thoughts of Mahatma Gandhi in the present times.', section: H4, year: 2018 },
  { questionText: 'Highlight the differences in the approach of Subhash Chandra Bose and Mahatma Gandhi in the struggle for freedom.', section: H4, year: 2016 },
  { questionText: 'How different would have been the achievement of Indian independence without Mahatma Gandhi? Discuss.', section: H4, year: 2015 },
  { questionText: 'Mahatma Gandhi and Dr. B.R. Ambedkar, despite having divergent approaches and strategies, had a common goal of amelioration of the downtrodden. Elucidate.', section: H4, year: 2015 },
  { questionText: 'Evaluate the policies of Lord Curzon and their long term implications on the national movement.', section: H4, year: 2020 },
  { questionText: "Examine the linkages between 19th centuries 'Indian Renaissance' and the emergence of national identity.", section: H4, year: 2019 },
  { questionText: 'What were the events that led to the Quit India Movement? Point out its results.', section: 'Decolonisation Catalyst', year: 2024 },
  { questionText: 'Several foreigners made India their homeland and participated in various movements. Analyze their role in the Indian struggle for freedom.', section: H4, year: 2013 },
  { questionText: "Mahatma Jotirao Phule's writings and efforts of social reforms touched issues of almost all subaltern classes. Discuss.", section: 'Phule', year: 2025 },
  { questionText: 'Trace the rise and growth of socio-religious reform movements with special reference to Young Bengal and Brahmo Samaj.', section: H4, year: 2021 },
  { questionText: "The women's questions arose in modern India as a part of the 19th century social reform movement. What were the major issues and debates concerning women in that period?", section: H4, year: 2017 },
  { questionText: 'How did the colonial rule affect the tribals in India and what was the tribal response to the colonial oppression?', section: H4, year: 2023 },
  { questionText: 'Discuss the role of women in the freedom struggle especially during the Gandhian phase.', section: H4, year: 2016 },
  { questionText: 'Defying the barriers of age, gender and religion, the Indian women became the torch bearer during the struggle for freedom in India. Discuss.', section: H4, year: 2013 },

  // ---- from MMF - World History ----
  { questionText: 'American Revolution was an economic revolt against mercantilism. Substantiate.', section: H6, year: 2013 },
  { questionText: 'Explain how the foundations of the modern world were laid by the American and French revolution.', section: 'French Revolution', year: 2019 },
  { questionText: 'To what extent can Germany be held responsible for causing the two World Wars? Discuss critically', section: H6, year: 2015 },
  { questionText: 'Why indentured labour was taken by the British from India to other colonies? Have they been able to preserve their cultural identity over there?', section: H6, year: 2018 },
  { questionText: 'What problems were germane to the decolonization process of Malay Peninsula.', section: H6, year: 2017 },
  { questionText: 'The anti-colonial struggles in West Africa were led by the new elite of Western-educated Africans. Examine.', section: H6, year: 2016 },
  { questionText: 'What were the major political, economic and social developments in the world which motivated the anti-colonial struggle in India?', section: 'Decolonisation Catalyst', year: 2014 },
  { questionText: 'Africa was chopped into states artificially created by accident of European competition. Analyse.', section: H6, year: 2013 },
  { questionText: '"There arose a serious challenge to the Democratic State System between the two World Wars." Evaluate the statement.', section: H6, year: 2021 },
  { questionText: 'The French Revolution has enduring relevance to the contemporary world. Explain.', section: 'French Revolution', year: 2025 },
  { questionText: 'How far was the Industrial Revolution in England responsible for the decline of handicrafts and cottage industries in India?', section: 'British Economic Policy', year: 2024 },
  { questionText: 'Why did the industrial revolution first occur in England? Discuss the quality of life of the people there during the industrialization. How does it compare with that in India at present?', section: H6, year: 2015 },
  { questionText: 'Latecomer Industrial revolution in Japan involved certain factors that were markedly different from what west had experience.', section: H6, year: 2013 },
  { questionText: 'What policy instruments were deployed to contain the great economic depression?', section: H6, year: 2013 },
  { questionText: 'Bring out the socio-economic effects of the introduction of railways in different countries of the world.', section: H6, year: 2023 },
  { questionText: "What were the events that led to the Suez Crisis in 1956? How did it deal a final blow to Britain's self-image as a world power?", section: H6, year: 2014 },
  { questionText: 'How far is it correct to say that the First World War was fought essentially for the preservation of balance of power?', section: H6, year: 2024 },

  // ---- from MMF-Society ----
  { questionText: 'Despite comprehensive policies for equity and social justice, underprivileged sections are not yet getting the full benefits of affirmative action envisaged by the Constitution. Comment.', section: 'Caste System', year: 2024 },
  { questionText: 'Why is caste identity in India both fluid and static?', section: 'Caste System', year: 2023 },
  { questionText: 'Has caste lost its relevance in understanding the multi-cultural Indian Society? Elaborate your answer with illustrations.', section: 'Caste System', year: 2020 },
  { questionText: 'Caste system is assuming new identities and associational forms. Hence, caste system cannot be eradicated in India. Comment.', section: 'Caste System', year: 2018 },
  { questionText: 'What are the two major legal initiatives by the State since Independence, addressing discrimination against Scheduled Tribes (STs)?', section: 'Caste System', year: 2017 },
  { questionText: 'Why are the tribals in India referred to as the Scheduled Tribes? Indicate the major provisions enshrined in the Constitution of India for their upliftment.', section: 'Caste System', year: 2016 },
  { questionText: 'Debate the issue of whether and how contemporary movements for assertion of Dalit identity work towards annihilation of caste.', section: 'Dalit', year: 2015 },
  { questionText: 'Discuss the impact of post-liberal economy on ethnic identity and communalism.', section: 'Communalism', year: 2023 },
  { questionText: 'Communalism arises either due to power struggle or relative deprivation. Argue by giving suitable illustrations.', section: 'Communalism', year: 2018 },
  { questionText: 'Distinguish between religiousness/religiosity and communalism giving one example of how the former has got transformed into the latter in independent India.', section: 'Communalism', year: 2017 },
  { questionText: "Critically analyse the proposition that there is a high correlation between India's cultural diversities and socio-economic marginalities.", section: 'Salient Features of Indian Society', year: 2024 },
  { questionText: 'Do we have cultural pockets of small India all over the nation? Elaborate with examples.', section: 'Salient Features of Indian Society', year: 2019 },
  { questionText: 'Describe any four cultural elements of diversity in India and rate their relative significance in building a national identity.', section: 'Salient Features of Indian Society', year: 2015 },
  { questionText: 'Child cuddling is now being replaced by mobile phones. Discuss its impact on the socialization of children.', section: 'Family', year: 2023 },
  { questionText: "Explore and evaluate the impact of 'Work From Home' on family relationships.", section: S2, year: 2022 },
  { questionText: 'The life cycle of a joint family depends on economic factors rather than social values. Discuss.', section: S2, year: 2014 },
  { questionText: 'How do you account for the growing fast food industries given that there are increased health concerns in modern society? Illustrate your answer with the Indian experience.', section: 'Consumer Culture', year: 2025 },
  { questionText: 'Do you think that globalization results in only an aggressive consumer culture?', section: 'Consumer Culture', year: 2025 },
  { questionText: 'Is diversity and pluralism in India under threat due to globalisation? Justify your answer.', section: 'Globalisation & Culture', year: 2020 },
  { questionText: 'Are we losing our local identity for the global identity? Discuss.', section: 'Globalisation & Culture', year: 2019 },
  { questionText: 'Globalization is generally said to promote cultural homogenization but due to this cultural specificities appear to be strengthened in the Indian Society. Elucidate.', section: 'Globalisation & Culture', year: 2018 },
  { questionText: 'To what extent globalization has influenced the core of cultural diversity in India? Explain.', section: 'Globalisation & Culture', year: 2016 },
  { questionText: 'Elucidate the relationship between globalization and new technology in a world of scarce resources, with special reference to India.', section: S4, year: 2022 },
  { questionText: 'Intercaste marriages between castes which have socio-economic parity have increased, to some extent, but this is less true of interreligious marriages. Discuss.', section: S2, year: 2024 },
  { questionText: 'Do you think marriage as a sacrament in losing its value in Modern India?', section: S2, year: 2023 },
  { questionText: 'Why do large cities tend to attract more migrants than smaller towns? Discuss in the light of conditions in developing countries.', section: 'Migration', year: 2024 },
  { questionText: 'Discuss the changes in the trends of labour migration within and outside India in the last four decades.', section: 'Migration', year: 2015 },
  { questionText: "What is the concept of a 'demographic winter'? Is the world moving towards such a situation? Elaborate.", section: S5, year: 2024 },
  { questionText: 'Discuss the main objectives of Population Education and point out the measures to achieve them in India in detail.', section: S5, year: 2021 },
  { questionText: 'COVID-19 pandemic accelerated class inequalities and poverty in India. Comment.', section: S5, year: 2020 },
  { questionText: "Despite implementation of various programmes for eradication of poverty by the government in India, poverty is still existing.' Explain by giving reasons.", section: S5, year: 2018 },
  { questionText: 'An essential condition to eradicate poverty is to liberate the poor from deprivation. Substantiate this statement with suitable examples', section: S5, year: 2016 },
  { questionText: 'Critically examine whether growing population is the cause of poverty OR poverty is the main cause of population increase in India.', section: S5, year: 2015 },
  { questionText: 'What is regional disparity? How does it differ from diversity? How serious is the issue of regional disparity in India?', section: 'Salient Features of Indian Society', year: 2024 },
  { questionText: 'Do you agree that regionalism in India appears to be a consequence of rising cultural assertiveness? Argue.', section: 'Salient Features of Indian Society', year: 2020 },
  { questionText: 'In the context of diversity of India, can it be said that the regions form cultural units rather than the States? Give reasons with examples for your viewpoint.', section: 'Salient Features of Indian Society', year: 2017 },
  { questionText: 'What is the basis of regionalism? Is it that unequal distribution of benefits of development on regional basis eventually promotes regionalism? Substantiate your answer.', section: 'Salient Features of Indian Society', year: 2016 },
  { questionText: 'Growing feeling of regionalism is an important factor in the generation of demand for a separate state. Discuss.', section: 'Salient Features of Indian Society', year: 2013 },
  { questionText: 'Are tolerance, assimilation and pluralism the key elements in the making of an Indian form of secularism? Justify your answer.', section: 'Secularism', year: 2022 },
  { questionText: 'What are the challenges to our cultural practices in the name of secularism.', section: 'Secularism', year: 2019 },
  { questionText: 'How the Indian concept of secularism is different from the western model of secularism? Discuss.', section: 'Secularism', year: 2018 },
  { questionText: 'How do the Indian debates on secularism differ from the debates in the West?', section: 'Secularism', year: 2014 },
  { questionText: "'Achieving sustainable growth with emphasis on environmental protection could come into conflict with poor people's needs in a country like India' – Comment.", section: 'Sustainable Growth', year: 2025 },
  { questionText: "In dealing with socio-economic issues of development, what kind of collaboration between government, NGO's and private sector would be most productive?", section: S4, year: 2024 },
  { questionText: 'Why did human development fail to keep pace with economic development in India?', section: S5, year: 2023 },
  { questionText: 'What is Cryptocurrency? How does it affect global society? Has it been affecting Indian society also?', section: S4, year: 2021 },
  { questionText: 'How have digital initiatives in India contributed to the functioning of the educational system in the country? Elaborate your answer.', section: S4, year: 2020 },
  { questionText: 'The ethos of civil service in India stand for the combination of professionalism with nationalistic consciousness – Elucidate.', section: 'Civil Service Ethos', year: 2025 },
  { questionText: "Analyse the salience of 'sect' in Indian society vis-a-vis caste, region and religion.", section: 'Salient Features of Indian Society', year: 2022 },
  { questionText: 'How does Indian society maintain continuity in traditional social values? Enumerate the changes taking place in it.', section: 'Salient Features of Indian Society', year: 2021 },
  { questionText: 'Customs and traditions suppress reason leading to obscurantism. Do you agree?', section: 'Salient Features of Indian Society', year: 2020 },
  { questionText: 'What makes Indian society unique in sustaining its culture? Discuss.', section: 'Salient Features of Indian Society', year: 2019 },
  { questionText: 'The spirit tolerance and love is not only an interesting feature of Indian society from very early times, but it is also playing an important part at the present. Elaborate.', section: 'Salient Features of Indian Society', year: 2017 },
  { questionText: 'Does tribal development in India centre around two axes, those of displacement and of rehabilitation? Give your opinion.', section: S1, year: 2025 },
  { questionText: 'Given the diversities among tribal communities in India, in which specific contexts should they be considered as a single category?', section: S1, year: 2022 },
  { questionText: 'Examine the uniqueness of tribal knowledge system when compared with mainstream knowledge and cultural systems.', section: S1, year: 2021 },
  { questionText: 'How do you explain the statistics that show that the sex ratio in Tribes in India is more favourable to women than the sex ratio among Scheduled Castes?', section: S1, year: 2015 },
  { questionText: 'Critically examine the effects of globalization on the aged population in India.', section: 'Ageing', year: 2013 },
  { questionText: 'What are the environmental implications of the reclamation of water bodies into urban land use? Explain with examples.', section: 'Urban Planning', year: 2021 },
  { questionText: 'Account for the huge flooding of million cities in India including the smart ones like Hyderabad and Pune. Suggest lasting remedial measures.', section: 'Urban Planning', year: 2020 },
  { questionText: 'How is efficient and affordable urban mass transport key to the rapid economic development of India?', section: 'Urban Planning', year: 2019 },
  { questionText: 'Mention core strategies for the transformation of aspirational districts in India and explain the nature of convergence, collaboration and competition for its success.', section: 'Urban Planning', year: 2018 },
  { questionText: "With a brief background of quality of urban life in India, introduce the objectives and strategy of the 'Smart City Programme'.", section: 'Urban Planning', year: 2016 },
  { questionText: 'Major cities of India are becoming more vulnerable to flood conditions. Discuss.', section: 'Urban Planning', year: 2016 },
  { questionText: 'Smart cities in India cannot sustain without smart villages. Discuss this statement in the backdrop of rural urban integration.', section: 'Urban Planning', year: 2015 },
  { questionText: 'How does smart city in India, address the issues of urban poverty and distributive justice?', section: 'Urban Poverty', year: 2025 },
  { questionText: 'Does urbanization lead to more segregation and/or marginalization of the poor in Indian metropolises?', section: 'Urban Poverty', year: 2023 },
  { questionText: 'How is the growth of Tier 2 cities related to the rise of a new middle class with an emphasis on the culture of consumption?', section: 'Urbanisation', year: 2022 },
  { questionText: 'What are the main socio-economic implications arising out of the development of IT industries in major cities of India?', section: 'Urbanisation', year: 2021 },
  { questionText: 'The growth of cities as I.T. hubs has opened up new avenues employment but has also created new problems. Substantiate this statement with examples.', section: 'Urbanisation', year: 2017 },
  { questionText: 'Discussion the various social problems which originated out of the speedy process of urbanization in India.', section: 'Urbanisation', year: 2013 },
  { questionText: 'Globalization has increased urban migration by skilled, young, unmarried women from various classes. How has this trend impacted upon their personal freedom and relationship with family?', section: S2, year: 2024 },
  { questionText: "Examine the role of 'Gig Economy' in the process of empowerment of women in India.", section: S2, year: 2021 },
  { questionText: 'Discuss the positive and negative effects of globalization on women in India.', section: S2, year: 2015 },
  { questionText: 'Discuss the various economic and socio-cultural forces that are driving increasing feminization of agriculture in India.', section: 'Feminization of Agriculture', year: 2014 },
  { questionText: "Distinguish between gender equality, gender equity and women's empowerment. Why is it important to take gender concerns into account in programme design and implementation?", section: S2, year: 2024 },
  { questionText: 'Explain why suicide among young women is increasing in Indian Society.', section: S2, year: 2023 },
  { questionText: '"Empowering women is the key to control population growth". Discuss', section: S2, year: 2019 },
  { questionText: 'What are the continued challenges for women in India against time and space?', section: S2, year: 2019 },
  { questionText: "Women's movement in India has not addressed the issues of women of lower social strata. Substantiate your view.", section: S2, year: 2018 },
  { questionText: 'Why do some of the most prosperous regions of India have an adverse sex ratio for women? Give your arguments.', section: S2, year: 2014 },
  { questionText: 'How does patriarchy impact the position of a middle class working woman in India?', section: 'Patriarchy', year: 2014 },
  { questionText: "Male membership needs to be encouraged in order to make women's organization free from gender bias. Comment.", section: S2, year: 2013 },

  // ---- from MMF - Geography ----
  { questionText: 'Discuss the geophysical characteristics of Circum-Pacific Zone.', section: 'Continental Drift & Plate Tectonics', year: 2020 },
  { questionText: 'In spite of adverse environmental impact, coal mining is still inevitable for development." Discuss.', section: G4, year: 2017 },
  { questionText: 'Discuss how the changes in shape and sizes of continents and ocean basins of the planet take place due to tectonic movements of the crustal masses.', section: 'Continental Drift & Plate Tectonics', year: 2025 },
  { questionText: 'Briefly mention the alignment of major mountain ranges of the world and explain their impact on local weather conditions, with examples.', section: 'Continental Drift & Plate Tectonics', year: 2021 },
  { questionText: "Why are the world's fold mountain systems located along the margins of continents? Bring out the association between the global distribution of Fold Mountains and the earthquakes and volcanoes.", section: 'Continental Drift & Plate Tectonics', year: 2014 },
  { questionText: 'Explain the formation of thousands of islands in Indonesian and Philippines archipelagos.', section: 'Continental Drift & Plate Tectonics', year: 2014 },
  { questionText: 'What do you understand by the theory of continental drift? Discuss the prominent evidences in its support.', section: 'Continental Drift & Plate Tectonics', year: 2013 },
  { questionText: 'Mention the advantages of the cultivation of pulse because of which the year 2016 was declared as the International Year of Pulses by the United Nations.', section: G4, year: 2017 },
  { questionText: "Discuss the natural resource potentials of 'Deccan Trap'.", section: 'Deccan Trap', year: 2022 },
  { questionText: 'The process of desertification does not have climatic boundaries. Justify with examples.', section: G2, year: 2020 },
  { questionText: 'Major hot deserts in northern hemisphere are located between 20-30 degree north and on the western side of the continents. Why?', section: G2, year: 2013 },
  { questionText: 'How does the Juno Mission of NASA help to understand the origin and evolution of the Earth?', section: G1, year: 2017 },
  { questionText: 'Discuss the factors for localization of agro-based food processing industries of North-West India.', section: G4, year: 2019 },
  { questionText: 'From being net food importer in 1960s, India has emerged as a net food exporter to the world. Provide reasons.', section: G4, year: 2023 },
  { questionText: 'Discuss the consequences of climate change on the food security in tropical countries.', section: G4, year: 2023 },
  { questionText: 'How are the fjords formed? Why do they constitute some of the most picturesque areas of the world?', section: G1, year: 2023 },
  { questionText: 'How will the melting of Himalayan glaciers have a far-reaching impact on the water resources of India?', section: G2, year: 2020 },
  { questionText: 'Bring out the relationship between the shrinking Himalayan glaciers and the symptoms of climate change in the Indian sub-continent.', section: G2, year: 2014 },
  { questionText: 'The groundwater potential of the gangetic valley is on a serious decline. How may it affect the food security of India?', section: G3, year: 2024 },
  { questionText: 'The ideal solution of depleting ground water resources in India is water harvesting system. How can it be made effective in urban areas?', section: G3, year: 2018 },
  { questionText: 'In what way can flood be converted into a sustainable source of irrigation and all-weather inland navigation in India?', section: G3, year: 2017 },
  { questionText: 'Differentiate the causes of landslides in the Himalayan region and Western Ghats.', section: G1, year: 2021 },
  { questionText: 'The Himalayas are highly prone to landslides. Discuss the causes and suggest suitable measures of mitigation.', section: G1, year: 2016 },
  { questionText: 'Bring out the causes for more frequent landslides in the Himalayas than in Western Ghats', section: G1, year: 2013 },
  { questionText: 'Discuss the causes of depletion of mangroves and explain their importance in maintaining coastal ecology.', section: G4, year: 2019 },
  { questionText: 'Define mantle plume and explain its role in plate tectonics.', section: 'Continental Drift & Plate Tectonics', year: 2018 },
  { questionText: 'In what way micro-watershed Development projects help in water conservation in drought prone and semi-arid regions of India.', section: G3, year: 2016 },
  { questionText: "Why is the South-West monsoon called 'Purvaiya' (easterly) in Bhojpur Region? How has this directional seasonal wind system influenced the cultural ethos of the region?", section: 'Monsoon Climate', year: 2023 },
  { questionText: 'What characteristics can be assigned to monsoon climate that succeeds in feeding more than 50 percent of the world population residing in Monsoon Asia?', section: 'Monsoon Climate', year: 2017 },
  { questionText: 'How far do you agree that the behavior of the Indian monsoon has been changing due to humanizing landscapes? Discuss.', section: 'Monsoon Climate', year: 2015 },
  { questionText: 'What are the forces that influence ocean currents? Describe their role in fishing industry of the world.', section: 'Ocean Currents', year: 2022 },
  { questionText: 'How do ocean currents and water masses differ in their impacts on marine life and the coastal environment? Give suitable examples?', section: 'Ocean Currents', year: 2019 },
  { questionText: 'Explain the factors responsible for the origin of ocean currents. How do they influence regional climates, fishing and navigation?', section: 'Ocean Currents', year: 2015 },
  { questionText: 'Account for variations in oceanic salinity and discuss its multi-dimensional effects.', section: G2, year: 2017 },
  { questionText: 'Describing the distribution of rubber producing countries, indicate the major environmental issues faced by them.', section: G4, year: 2022 },
  { questionText: 'How are climate change and the sea level rise affecting the very existence of many island nations? Discuss with examples.', section: 'Polar Ice Melting', year: 2025 },
  { questionText: 'How does the melting of the Arctic ice and glaciers of the Antarctic differently affect the weather patterns and human activities on the Earth? Explain.', section: 'Polar Ice Melting', year: 2021 },
  { questionText: 'Discuss the distribution and density of population in the Ganga River Basin with special reference to land, soil and water resources.', section: G4, year: 2025 },
  { questionText: 'Explain briefly the ecological and economic benefits of solar energy generation in India with suitable examples.', section: G4, year: 2025 },
  { questionText: 'Examine the potential of wind energy in India and explain the reasons for their limited spatial spread.', section: G4, year: 2022 },
  { questionText: 'India has immense potential of solar energy though there are regional variations in its development. Elaborate.', section: G4, year: 2020 },
  { questionText: 'Mention the significance of straits and isthmus in international trade.', section: G4, year: 2022 },
  { questionText: 'What do you understand by the phenomenon of temperature inversion in meteorology? How does it affect the weather and the habitants of the place?', section: G2, year: 2013 },
  { questionText: 'What is sea surface temperature rise? How does it affect the formation of tropical cyclones?', section: G2, year: 2024 },
  { questionText: 'Discuss the meaning of colour-coded weather warnings for cyclone prone areas given by India Meteorological Department.', section: G2, year: 2022 },
  { questionText: 'Tropical cyclones are largely confined to South China Sea, Bay of Bengal and Gulf of Mexico. Why?', section: G2, year: 2014 },
  { questionText: 'The recent cyclone on the east coast of India was called "Phailin". How are the tropical cyclones named across the world?', section: G2, year: 2013 },
  { questionText: 'What are Tsunamis? How and where are they formed? What are their consequences? Explain with examples.', section: 'Tsunami', year: 2025 },
  { questionText: 'Define blue revolution, explain the problems and strategies for pisciculture development in India.', section: G4, year: 2018 },
  { questionText: 'Why did the Green Revolution in India virtually by-pass the eastern region despite fertile soil and good availability of water?', section: G4, year: 2014 },
  { questionText: 'Describe the characteristics and types of primary rocks.', section: G1, year: 2022 },
  { questionText: 'There is no formation of deltas by rivers of the Western Ghat. Why?', section: G1, year: 2013 },
  { questionText: "What is the phenomenon of 'cloudbursts'? Explain.", section: G2, year: 2024 },
  { questionText: 'What are aurora australis and aurora borealis? How are these triggered?', section: G2, year: 2024 },
  { questionText: 'What is a twister? Why are the majority of twisters observed in areas around the Gulf of Mexico?', section: G2, year: 2024 },
  { questionText: 'Troposphere is a very significant atmospheric layer that determines weather processes. How?', section: G2, year: 2022 },
  { questionText: 'How does the cryosphere affect global climate?', section: G2, year: 2017 },
  { questionText: 'Discuss the concept of air mass and explain its role in macro-climatic changes.', section: G2, year: 2016 },
  { questionText: 'Most of the unusual climatic happenings are explained as an outcome of the El-Nino effect. Do you agree?', section: G2, year: 2014 },
  { questionText: 'Assess the impact of global warming on coral life system with examples.', section: G2, year: 2019 },
  { questionText: "What are the consequences of spreading of 'Dead Zones' on marine ecosystem?", section: G2, year: 2018 },
  { questionText: 'South China Sea has assumed great geopolitical significance in the present context. Comment.', section: G2, year: 2016 },
  { questionText: 'Critically evaluate the various resources of the oceans which can be harnessed to meet the resource crisis in the world.', section: G2, year: 2014 },
  { questionText: 'Identify and discuss the factors responsible for diversity of natural vegetation in India. Assess the significance of wildlife sanctuaries in rain forests regions of India.', section: G3, year: 2023 },
  { questionText: 'Examine the status of forest resources of India and its resultant impact on climate change.', section: G3, year: 2020 },
  { questionText: 'How can Artificial Intelligence (AI) and drones be effectively used along with GIS and RS techniques in locational and areal planning?', section: 'AI Spatial Planning', year: 2025 },
  { questionText: 'Give a geographical explanation of the distribution of off-shore oil reserves of the world. How are they different from the on-shore occurrences of oil reserves?', section: 'Oil Reserves', year: 2025 },
  { questionText: 'Comment on the resource potentials of the long coastline of India and highlight the status of natural hazard preparedness in these areas.', section: 'Coastline', year: 2023 },
  { questionText: 'Why is the world today confronted with a crisis of availability of and access to freshwater resources?', section: G3, year: 2023 },
  { questionText: 'Discuss the multi-dimensional implications of uneven distribution of mineral oil in the world.', section: G4, year: 2021 },
  { questionText: 'Account for the present location of iron and steel industries away from the source of raw material, by giving examples.', section: G4, year: 2020 },
  { questionText: 'How can the mountain ecosystem be restored from the negative impact of development initiatives and tourism?', section: G3, year: 2019 },
  { questionText: 'Why is India taking keen interest in resources of Arctic Region?', section: G4, year: 2018 },
  { questionText: 'Why is Indian Regional Navigational Satellite System (IRNSS) needed? How does it help in navigation?', section: G4, year: 2018 },
  { questionText: 'Petroleum refineries are not necessarily located nearer to crude oil producing areas, particularly in many of the developing countries. Explain its implications.', section: G4, year: 2017 },
  { questionText: 'What are the economic significances of discovery of oil in Arctic Sea and its possible environmental consequences?', section: 'Oil Reserves', year: 2015 },
  { questionText: 'How does India see its place in the economic space of rising natural resource rich Africa?', section: G4, year: 2014 },
  { questionText: 'Account for the change in the spatial pattern of the Iron and Steel industry in the world.', section: G4, year: 2014 },
  { questionText: "It is said the India has substantial reserves of shale oil and gas, which can feed the needs of country for quarter century. However, tapping of the resources doesn't appear to be high on the agenda. Discuss critically the availability and issues involved.", section: 'Oil Reserves', year: 2013 },
  { questionText: 'With growing scarcity of fossil fuels, the atomic energy is gaining more and more significance in India. Discuss the availability of raw material required for the generation of atomic energy in India and in the world.', section: G4, year: 2013 },
  { questionText: 'What are non-farm primary activities? How are these activities related to physiographic features in India? Discuss with suitable examples.', section: 'Non-Farm Primary Activities', year: 2025 },
  { questionText: 'Despite India being one of the countries of the Gondwanaland, its mining industry contributes much less to Gross Domestic Product (GDP) in percentage. Discuss.', section: G3, year: 2021 },
  { questionText: 'Why is India considered as a subcontinent? Elaborate your answer.', section: G3, year: 2021 },
  { questionText: 'Can the strategy of regional-resource based manufacturing help in promoting employment in India?', section: G4, year: 2019 },
  { questionText: 'What is the significance of Industrial Corridors in India? Identify industrial corridors, explain their main characteristics.', section: G4, year: 2018 },
  { questionText: 'The states of Jammu and Kashmir, Himachal Pradesh and Uttarakhand reaching the limits of their ecological carrying capacity due to tourism. Critically evaluate.', section: G3, year: 2015 },
  { questionText: 'Whereas the British planters had developed tea gardens all along the Shivaliks and Lesser Himalayas from Assam to Himachal Pradesh, in effect they did not succeed beyond the Darjeeling area. Explain.', section: G4, year: 2014 },
  { questionText: 'Do you agree that there is a growing trend of opening new sugar mills in the Southern states of India? Discuss with justification', section: G4, year: 2013 },
  { questionText: 'Analyze the factors for highly decentralized cotton textile industry in India', section: G4, year: 2013 },
  { questionText: 'The interlinking of rivers can provide viable solutions to the multi-dimensional inter-related problems of droughts, floods and interrupted navigation. Critically examine.', section: G3, year: 2020 },
  { questionText: 'What is water stress? How and why does it differ regionally in India?', section: G3, year: 2019 },
  { questionText: 'The effective management of land and water resources will drastically reduce the human miseries. Explain', section: G3, year: 2016 },
  { questionText: 'Present an account of the Indus Water Treaty and examine its ecological, economic and political implications in the context of changing bilateral relations.', section: G3, year: 2016 },
  { questionText: 'Enumerate the problems and prospects of inland water transport in India.', section: G3, year: 2016 },
  { questionText: 'India is well endowed with fresh water resources. Critically examine why it still suffers from water scarcity.', section: G3, year: 2015 },
  { questionText: 'Mumbai, Delhi and Kolkata are the three mega cities of the country but the air pollution is much more serious problem in Delhi as compared to the other two. Why is this so?', section: G4, year: 2015 },
  { questionText: 'Bring out the causes for the formation of heat islands in the urban habitat of the world.', section: G4, year: 2013 },
  { questionText: 'Mention the global occurrence of volcanic eruptions in 2021 and their impact on regional environment.', section: 'Continental Drift & Plate Tectonics', year: 2021 }
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

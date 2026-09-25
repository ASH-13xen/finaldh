// One-time import of Progress checklist + PYQ data for the "MMF - Environment and DM" file
// inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Chapter (1-9) -> numbered sub-heading (X.Y) with page numbers, same shape as
// the IR/Society/Social Justice imports. `tag` on each sub-heading is a short clean keyword for
// precise PYQ matching. Two GS-3 syllabus PYQ sections (18: Conservation/Pollution/EIA and 19:
// Disaster Management) both map onto this one book; several microthemes (Mining Hazards, River
// Linking, Solid Wastes, most Water Pollution items, Cloudbursts, Dam Failures, Tsunami) have no
// dedicated sub-heading in this index, so they fall back to the closest relevant chapter.
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
const TARGET_FILE_NAME = 'MMF - Environment and DM';

const C1 = 'Chapter 1: Disaster Management: Concepts, Cycle & Institutional Framework';
const C2 = 'Chapter 2: Disaster Risk Reduction: Tools & Community Engagement';
const C3 = 'Chapter 3: Hydro-Meteorological Disasters';
const C4 = 'Chapter 4: Climate Change & International Frameworks';
const C5 = 'Chapter 5: Pollution & Environmental Management';
const C6 = 'Chapter 6: Environmental Governance';
const C7 = 'Chapter 7: Land Resources: Degradation & Desertification';
const C8 = 'Chapter 8: Biodiversity & Ecosystem Conservation';
const C9 = 'Chapter 9: Sustainable Development & Renewable Energy';

const CHECKLIST_ROWS = [
  { topicName: C1, questionText: "1.1 India's Vulnerability to Natural Disasters", pageNumber: 3, tag: 'Vulnerability to Disasters' },
  { topicName: C1, questionText: '1.2 Disaster Management Cycle', pageNumber: 3, tag: 'Disaster Management Cycle' },
  { topicName: C1, questionText: '1.3 Institutional Framework for Disaster Management in India', pageNumber: 4, tag: '' },
  { topicName: C1, questionText: '1.4 Disaster Management (Amendment) Act, 2025', pageNumber: 5, tag: '' },
  { topicName: C1, questionText: '1.5 Natural vs Man-made Disasters', pageNumber: 5, tag: '' },
  { topicName: C1, questionText: '1.6 Disaster Resilience & the Sendai Framework', pageNumber: 6, tag: 'Disaster Resilience;Sendai Framework' },

  { topicName: C2, questionText: '2.1 Integrating DRR into School Curriculum', pageNumber: 8, tag: '' },
  { topicName: C2, questionText: '2.2 Inclusive & Multi-Hazard Early Warning Systems (EWS)', pageNumber: 8, tag: '' },
  { topicName: C2, questionText: '2.3 Community Participation in Disaster Management', pageNumber: 9, tag: '' },

  { topicName: C3, questionText: '3.1 Heat Waves: Criteria & Causes', pageNumber: 10, tag: 'Heat Waves' },
  { topicName: C3, questionText: '3.2 Multi-Dimensional Impacts of Heat Waves', pageNumber: 10, tag: 'Heat Waves' },
  { topicName: C3, questionText: '3.3 Urban Floods: Causes & Management', pageNumber: 11, tag: 'Urban Floods' },
  { topicName: C3, questionText: '3.4 Droughts: Types & Drought-Prone Regions', pageNumber: 12, tag: 'Drought' },
  { topicName: C3, questionText: '3.5 Landslide Vulnerability Zones & Mitigation', pageNumber: 13, tag: 'Landslides' },
  { topicName: C3, questionText: '3.6 Marine Heat Waves (MHWs)', pageNumber: 13, tag: '' },

  { topicName: C4, questionText: '4.1 COP29 (Baku, 2024): Major Outcomes', pageNumber: 15, tag: 'COP;UNFCCC' },

  { topicName: C5, questionText: '5.1 Groundwater Pollution: Causes & Government Measures', pageNumber: 16, tag: 'Groundwater Pollution' },
  { topicName: C5, questionText: '5.2 Air Pollution: Role of CAQM & Stubble Burning', pageNumber: 16, tag: 'Air Pollution' },
  { topicName: C5, questionText: '5.3 Single-Use Plastic (SUP) Pollution', pageNumber: 17, tag: '' },
  { topicName: C5, questionText: '5.4 Oil Pollution and its Impact on Marine Ecosystems', pageNumber: 18, tag: 'Oil Pollution' },

  { topicName: C6, questionText: '6.1 Environmental Impact Assessment (EIA): Stages & Significance', pageNumber: 20, tag: 'EIA' },
  { topicName: C6, questionText: '6.2 Role of Environmental NGOs & Activists in EIA', pageNumber: 20, tag: 'EIA' },
  { topicName: C6, questionText: '6.3 Decentralisation of EIA to District Level', pageNumber: 21, tag: 'EIA' },
  { topicName: C6, questionText: '6.4 Case for a Centralised Environmental Health Regulatory Agency (EHRA)', pageNumber: 22, tag: '' },

  { topicName: C7, questionText: '7.1 Land Degradation: Status & Government Steps', pageNumber: 23, tag: '' },
  { topicName: C7, questionText: '7.2 Desertification: Causes, Consequences & Measures', pageNumber: 23, tag: '' },

  { topicName: C8, questionText: '8.1 Invasive Alien Species (IAS): Effects & Control Measures', pageNumber: 25, tag: '' },
  { topicName: C8, questionText: '8.2 Biodiversity Conservation: Importance & Approaches', pageNumber: 25, tag: 'Biodiversity' },
  { topicName: C8, questionText: '8.3 Wetlands: Importance & Conservation', pageNumber: 26, tag: 'Wetlands' },
  { topicName: C8, questionText: '8.4 Forest Fires: Causes, Impacts & Management', pageNumber: 27, tag: '' },

  { topicName: C9, questionText: "9.1 Biofuels in India's Energy Mix", pageNumber: 29, tag: '' },
  { topicName: C9, questionText: '9.2 Agrivoltaics: Benefits & Challenges', pageNumber: 29, tag: '' },
  { topicName: C9, questionText: '9.3 Carrying Capacity-Based Planning for Sustainable Tourism', pageNumber: 30, tag: 'Carrying Capacity' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  // 18. Conservation, Environmental Pollution and Degradation, EIA
  { questionText: 'What is Carbon Capture, Utilization and Storage (CCUS)? What is the potential role of CCUS in tackling climate change?', section: 'Air Pollution', year: 2025 },
  { questionText: 'Discuss in detail the photochemical smog emphasizing its formation, effects and mitigation. Explain the 1999 Gothenburg Protocol.', section: 'Air Pollution', year: 2022 },
  { questionText: "Describe the key points of the revised Global Air Quality Guidelines (AQGs) recently released by the World Health Organisation (WHO). How are these different from its last update in 2005? What changes in India's National Clean Air Programme are required to achieve these revised standards?", section: 'Air Pollution', year: 2021 },
  { questionText: 'What are the key features of the National Clean Air Programme (NCAP) initiated by the Government of India?', section: 'Air Pollution', year: 2020 },

  { questionText: 'How does biodiversity vary in India? How is the Biological Diversity Act, 2002 helpful in conservation of flora and fauna?', section: 'Biodiversity', year: 2018 },

  { questionText: "'Climate Change' is a global problem. How India will be affected by climate change? How Himalayan and coastal states of India will be affected by climate change?", section: C4, year: 2017 },

  { questionText: 'What role do environmental NGOs and activists play in influencing Environmental Impact Assessment (EIA) outcomes for major projects in India? Cite four examples with all important details.', section: 'EIA', year: 2024 },
  { questionText: 'How does the draft Environment Impact Assessment (EIA) Notification, 2020 differ from the existing EIA Notification, 2006?', section: 'EIA', year: 2020 },
  { questionText: 'Rehabilitation of human settlements is one of the important environmental impacts which always attracts controversy while planning major projects. Discuss the measures suggested for mitigation of this impact while proposing major developmental projects.', section: 'EIA', year: 2016 },
  { questionText: 'Environmental Impact Assessment studies are increasingly undertaken before project is cleared by the government. Discuss the environmental impacts of coal-fired thermal plants located at Pitheads.', section: 'EIA', year: 2014 },

  { questionText: 'The adoption of electric vehicles is rapidly growing worldwide. How do electric vehicles contribute to reducing carbon emissions and what are the key benefits they offer compared to traditional combustion engine vehicles?', section: C9, year: 2023 },

  { questionText: 'Define the concept of carrying capacity of an ecosystem as relevant to an environment. Explain how understanding this concept is vital while planning for sustainable development of a region.', section: 'Carrying Capacity', year: 2019 },

  { questionText: 'Mineral resources are fundamental to the country economy and these are exploited by mining. Why is mining considered an environmental hazard? Explain the remedial measures required to reduce the environmental hazard due to mining.', section: C7, year: 2025 },
  { questionText: 'Explain the causes and effects of coastal erosion in India. What are the available coastal management techniques for combating the hazard?', section: C5, year: 2022 },
  { questionText: 'Coastal sand mining, whether legal or illegal, poses one of the biggest threats to our environment. Analyse the impact of sand mining along the Indian coasts, citing specific examples.', section: C5, year: 2019 },
  { questionText: 'What are the consequences of illegal mining? Discuss the ministry of environment and forests\' concept of "GO AND NO GO" zones for coal mining.', section: C7, year: 2013 },

  { questionText: "Write a review on India's climate commitments under the Paris Agreement and mention how these have been further strengthened in COP26. In this direction, how has the first Nationally Determined Contribution (NDC) intended by India been updated in 2022?", section: 'COP;UNFCCC', year: 2025 },
  { questionText: 'The Intergovernmental Panel on Climate Change (IPCC) has predicted a global sea level rise of about one metre by AD 2100. What would be its impact in India and the other countries in the Indian Ocean region?', section: 'COP;UNFCCC', year: 2023 },
  { questionText: 'Discuss global warming and mention its effects on the global climate. Explain the control measures to bring down the level of greenhouse gases which cause global warming, in the light of the Kyoto Protocol, 1997.', section: 'COP;UNFCCC', year: 2022 },
  { questionText: 'Explain the purpose of the Green Grid Initiative launched at the World Leaders Summit of the COP26 UN Climate Change Conference in Glasgow in November 2021. When was this idea first floated in the International Solar Alliance (ISA)?', section: 'COP;UNFCCC', year: 2021 },
  { questionText: 'Describe the major outcomes of the 26th session of the Conference of the Parties (COP) to the United Nations Framework Convention on Climate Change (UNFCCC). What are the commitments made by India in this conference?', section: 'COP;UNFCCC', year: 2021 },
  { questionText: "Should the pursuit of carbon credit and clean development mechanism set up under UNFCCC be maintained even through there has been a massive slide in the value of carbon credit? Discuss with respect to India's energy needs for economic growth.", section: 'COP;UNFCCC', year: 2014 },

  { questionText: 'Not many years ago, river linking was a concept but it is becoming reality in the country. Discuss the advantages of river linking and its possible impact on the environment.', section: C5, year: 2017 },

  { questionText: 'What are the impediments in disposing the huge quantities of discarded solid wastes which are continuously being generated? How do we remove safely the toxic wastes that have been accumulating in our habitable environment?', section: C5, year: 2018 },

  { questionText: 'Seawater intrusion in the coastal aquifers is a major concern in India. What are the causes of seawater intrusion and the remedial measures to combat this hazard?', section: 'Groundwater Pollution', year: 2025 },
  { questionText: 'Examine the factors responsible for depleting groundwater in India. What are the steps taken by the government to mitigate such depletion of groundwater?', section: 'Groundwater Pollution', year: 2025 },
  { questionText: "Industrial pollution of river water is a significant environmental issue in India. Discuss the various mitigation measures to deal with this problem and also the government's initiatives in this regard.", section: C5, year: 2024 },
  { questionText: 'What is oil pollution? What are its impacts on the marine ecosystem? In what way is oil pollution particularly harmful for a country like India?', section: 'Oil Pollution', year: 2023 },
  { questionText: 'Discuss the Namami Gange and National mission for clean Ganga (NMCG) programmes and causes of mixed results from the previous schemes. What quantum leaps can help preserve the river Ganga better than incremental inputs?', section: C5, year: 2015 },
  { questionText: 'Enumerate the National Water Policy of India. Taking river Ganges as an example, discuss the strategies which may be adopted for river water pollution control and management. What are the legal provisions for management and handling of hazardous wastes in India?', section: C5, year: 2013 },

  { questionText: "Comment on the National Wetland Conservation Programme initiated by the Government of India and name a few India's wetlands of international importance included in the Ramsar Sites.", section: 'Wetlands', year: 2023 },
  { questionText: "What is wetland? Explain the Ramsar concept of 'wise use' in the context of wetland conservation. Cite two examples of Ramsar sites from India.", section: 'Wetlands', year: 2018 },

  // 19. Disaster and Disaster Management
  { questionText: 'Explain the mechanism and occurrence of cloudburst in the context of the Indian subcontinent. Discuss two recent examples.', section: C3, year: 2022 },
  { questionText: 'With reference to National Disaster Management Authority (NDMA) guidelines, discuss the measures to be adopted to mitigate the impact of the recent incidents of cloudbursts in many places of Uttarakhand.', section: C3, year: 2016 },

  { questionText: 'Dam failures are always catastrophic, especially on the downstream side, resulting in a colossal loss of life and property. Analyze the various causes of dam failures. Give two examples of large dam failures.', section: C1, year: 2023 },

  { questionText: 'What is disaster resilience? How is it determined? Describe various elements of a resilience framework. Also mention the global targets of the Sendai Framework for Disaster Risk Reduction (2015-2030).', section: 'Disaster Resilience;Sendai Framework', year: 2024 },
  { questionText: 'Discuss the recent measures initiated in disaster management by the Government of India departing from the earlier reactive approach.', section: 'Disaster Management Cycle', year: 2020 },
  { questionText: 'Disaster preparedness is the first step in any disaster management process. Explain how hazard zonation mapping will help in disaster mitigation in the case of landslides.', section: 'Landslides', year: 2019 },
  { questionText: "Describe various measures taken in India for Disaster Risk Reduction (DRR) before and after signing 'Sendai Framework for DRR (2015-2030)'. How is this framework different from 'Hyogo Framework for Action, 2005?", section: 'Disaster Resilience;Sendai Framework', year: 2018 },

  { questionText: 'Drought has been recognised as a disaster in view of its party expense, temporal duration, slow onset and lasting effect on various vulnerable sections. With a focus on the September 2010 guidelines from the National disaster management authority, discuss the mechanism for preparedness to deal with the El Nino and La Nina fallouts in India.', section: 'Drought', year: 2014 },

  { questionText: 'Discuss about the vulnerability of India to earthquake-related hazards. Give examples including the salient features of major disasters caused by earthquakes in different parts of India during the last three decades', section: 'Vulnerability to Disasters', year: 2021 },
  { questionText: "The frequency of earthquakes appears to have increased in the Indian subcontinent. However, India's preparedness for mitigating their impact has significant gaps. Discuss various aspects.", section: 'Vulnerability to Disasters', year: 2015 },

  { questionText: 'Describe the various causes and the effects of landslides. Mention the important components of the National Landslide Risk Management Strategy.', section: 'Landslides', year: 2021 },

  { questionText: 'On December 2004, tsumani brought havoc on 14 countries including India. Discuss the factors responsible for occurrence of Tsunami and its effects on life and economy. In the light of guidelines of NDMA describe the mechanisms for preparedness to reduce the risk during such events', section: C3, year: 2017 },

  { questionText: 'Flooding in urban areas is an emerging climate-induced disaster. Discuss the causes of this disaster. Mention the features of two such major floods in the last two decades in India. Describe the policies and frameworks in India that aim at tackling such floods.', section: 'Urban Floods', year: 2024 },
  { questionText: 'The frequency of urban floods due to high intensity rainfall is increasing over the years. Discussing the reasons for urban floods. highlight the mechanisms for preparedness to reduce the risk during such events.', section: 'Urban Floods', year: 2016 },

  { questionText: 'Vulnerability is an essential element for defining disaster impacts and its threat to people. How and in what ways can vulnerability to disasters be characterized? Discuss different types of vulnerability with reference to disasters.', section: 'Vulnerability to Disasters', year: 2019 },
  { questionText: 'How important are vulnerability and risk assessment for pre-disaster management. As an administrator, what are key areas that you would focus in a disaster management', section: 'Vulnerability to Disasters', year: 2013 }
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

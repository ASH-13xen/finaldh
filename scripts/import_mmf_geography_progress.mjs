// One-time import of Progress checklist + PYQ data for the "Mains Master File - Geography"
// file inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS').
// Same course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Unlike the IR import, the source index here has no page numbers and the user asked to use
// only the Unit-level headings (not the ~99 numbered content points under each Unit) as the
// checklist items - ProgressQuestion.pageNumber is optional (see models/ProgressQuestion.js +
// upsertTopicsAndQuestions in progressController.js) so these rows are inserted with no page
// number and the checklist UI simply omits the "pg. X" badge for them.
//
// Topics = the 3 broad divisions the source document groups Units under (Physical Geography,
// Indian Geography, Agriculture). Questions = each Unit within a division. Each Unit question
// carries a short `tag` keyword (its subject name) used only for PYQ matching (tagMatcher.js) -
// the numbered content points (1-99) in the source were used only to figure out which Unit a
// given PYQ's theme belongs to, they are not imported as separate rows.
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
const TARGET_FILE_NAME = 'Mains Master File - Geography';

const T_PHYSICAL = 'Physical Geography';
const T_INDIAN = 'Indian Geography';
const T_AGRI = 'Agriculture';

// ================= Checklist: divisions (Topic) + Units (ProgressQuestion, no page number) =================
const CHECKLIST_ROWS = [
  { topicName: T_PHYSICAL, questionText: 'Unit 1: Geomorphology', pageNumber: null, tag: 'Geomorphology' },
  { topicName: T_PHYSICAL, questionText: 'Unit 2: Climatology', pageNumber: null, tag: 'Climatology' },
  { topicName: T_PHYSICAL, questionText: 'Unit 3: Oceanography', pageNumber: null, tag: 'Oceanography' },
  { topicName: T_PHYSICAL, questionText: 'Unit 4: Biogeography', pageNumber: null, tag: 'Biogeography' },
  { topicName: T_PHYSICAL, questionText: 'Unit 5: Human and Economic Geography', pageNumber: null, tag: 'Human and Economic Geography' },

  { topicName: T_INDIAN, questionText: 'Unit 6: Indian Physiography', pageNumber: null, tag: 'Indian Physiography' },
  { topicName: T_INDIAN, questionText: 'Unit 7: Indian Climate', pageNumber: null, tag: 'Indian Climate' },
  { topicName: T_INDIAN, questionText: 'Unit 8: Indian Drainage System', pageNumber: null, tag: 'Indian Drainage System' },
  { topicName: T_INDIAN, questionText: 'Unit 9: Indian Soils', pageNumber: null, tag: 'Indian Soils' },

  { topicName: T_AGRI, questionText: 'Agriculture', pageNumber: null, tag: 'Agriculture' }
];

// ================= PYQs, classified against the Units above =================
// `section` is a keyword matching one Unit's `tag`. Sourced from the GS-1 Mains syllabus items
// 11-15 PYQ compilation; classified by topical fit against the Unit index (using the ~99
// numbered content points purely as a guide to which Unit a theme belongs under), not strictly
// by which syllabus-numbered bucket a PYQ was filed under originally.
const PYQ_ROWS = [
  // Syllabus 11: Salient Features of World Physical Geography
  { questionText: 'Troposphere is a very significant atmospheric layer that determines weather processes. How?', section: 'Climatology', year: 2022 },
  { questionText: 'Discuss the concept of air mass and explain its role in macro-climatic changes.', section: 'Climatology', year: 2016 },
  { questionText: "Why is the South-West monsoon called 'Purvaiya' (easterly) in Bhojpur Region? How has this directional seasonal wind system influenced the cultural ethos of the region?", section: 'Climatology', year: 2023 },
  { questionText: 'What characteristics can be assigned to monsoon climate that succeeds in feeding more than 50 percent of the world population residing in Monsoon Asia?', section: 'Climatology', year: 2017 },
  { questionText: 'How far do you agree that the behavior of the Indian monsoon has been changing due to humanizing landscapes? Discuss.', section: 'Climatology', year: 2015 },
  { questionText: 'Most of the unusual climatic happenings are explained as an outcome of the El-Nino effect. Do you agree?', section: 'Climatology', year: 2014 },
  { questionText: 'What do you understand by the phenomenon of temperature inversion in meteorology? How does it affect the weather and the habitants of the place?', section: 'Climatology', year: 2013 },
  { questionText: 'Major hot deserts in northern hemisphere are located between 20-30 degree north and on the western side of the continents. Why?', section: 'Climatology', year: 2013 },

  { questionText: 'Discuss how the changes in shape and sizes of continents and ocean basins of the planet take place due to tectonic movements of the crustal masses.', section: 'Geomorphology', year: 2025 },
  { questionText: 'How are the fjords formed? Why do they constitute some of the most picturesque areas of the world?', section: 'Geomorphology', year: 2023 },
  { questionText: 'Describe the characteristics and types of primary rocks.', section: 'Geomorphology', year: 2022 },
  { questionText: 'Briefly mention the alignment of major mountain ranges of the world and explain their impact on local weather conditions, with examples.', section: 'Geomorphology', year: 2021 },
  { questionText: 'Why is India considered as a subcontinent? Elaborate your answer.', section: 'Indian Physiography', year: 2021 },
  { questionText: 'Discuss the geophysical characteristics of Circum-Pacific Zone.', section: 'Oceanography', year: 2020 },
  { questionText: 'Define mantle plume and explain its role in plate tectonics.', section: 'Geomorphology', year: 2018 },
  { questionText: 'Explain the formation of thousands of islands in Indonesian and Philippines archipelagos.', section: 'Geomorphology', year: 2014 },
  { questionText: "Why are the world's fold mountain systems located along the margins of continents? Bring out the association between the global distribution of Fold Mountains and the earthquakes and volcanoes.", section: 'Geomorphology', year: 2014 },
  { questionText: 'What do you understand by the theory of continental drift? Discuss the prominent evidences in its support.', section: 'Geomorphology', year: 2013 },
  { questionText: 'There is no formation of deltas by rivers of the Western Ghat. Why?', section: 'Geomorphology', year: 2013 },

  { questionText: 'What are the forces that influence ocean currents? Describe their role in fishing industry of the world.', section: 'Oceanography', year: 2022 },
  { questionText: 'How do ocean currents and water masses differ in their impacts on marine life and the coastal environment? Give suitable examples?', section: 'Oceanography', year: 2019 },
  { questionText: "What are the consequences of spreading of 'Dead Zones' on marine ecosystem?", section: 'Oceanography', year: 2018 },
  { questionText: 'Account for variations in oceanic salinity and discuss its multi-dimensional effects.', section: 'Oceanography', year: 2017 },
  { questionText: 'Explain the factors responsible for the origin of ocean currents. How do they influence regional climates, fishing and navigation?', section: 'Oceanography', year: 2015 },
  { questionText: 'Critically evaluate the various resources of the oceans which can be harnessed to meet the resource crisis in the world.', section: 'Oceanography', year: 2014 },

  // Syllabus 12: Distribution of key Natural Resources (world, South Asia, Indian subcontinent)
  { questionText: 'Discuss the distribution and density of population in the Ganga River Basin with special reference to land, soil and water resources.', section: 'Human and Economic Geography', year: 2025 },
  { questionText: 'Explain briefly the ecological and economic benefits of solar energy generation in India with suitable examples.', section: 'Human and Economic Geography', year: 2025 },
  { questionText: 'Give a geographical explanation of the distribution of off-shore oil reserves of the world. How are they different from the on-shore occurrences of oil reserves?', section: 'Human and Economic Geography', year: 2025 },
  { questionText: 'Comment on the resource potentials of the long coastline of India and highlight the status of natural hazard preparedness in these areas.', section: 'Human and Economic Geography', year: 2023 },
  { questionText: "Discuss the natural resource potentials of 'Deccan Trap'.", section: 'Indian Physiography', year: 2022 },
  { questionText: 'Examine the potential of wind energy in India and explain the reasons for their limited spatial spread.', section: 'Human and Economic Geography', year: 2022 },
  { questionText: 'India has immense potential of solar energy though there are regional variations in its development. Elaborate.', section: 'Human and Economic Geography', year: 2020 },
  { questionText: 'Why is India taking keen interest in resources of Arctic Region?', section: 'Human and Economic Geography', year: 2018 },
  { questionText: 'How does India see its place in the economic space of rising natural resource rich Africa?', section: 'Human and Economic Geography', year: 2014 },
  { questionText: "It is said the India has substantial reserves of shale oil and gas, which can feed the needs of country for quarter century. However, tapping of the resources doesn't appear to be high on the agenda. Discuss critically the availability and issues involved.", section: 'Human and Economic Geography', year: 2013 },
  { questionText: 'With growing scarcity of fossil fuels, the atomic energy is gaining more and more significance in India. Discuss the availability of raw material required for the generation of atomic energy in India and in the world.', section: 'Human and Economic Geography', year: 2013 },

  { questionText: 'Discuss the multi-dimensional implications of uneven distribution of mineral oil in the world.', section: 'Human and Economic Geography', year: 2021 },
  { questionText: 'What are the economic significances of discovery of oil in Arctic Sea and its possible environmental consequences?', section: 'Human and Economic Geography', year: 2015 },

  // Syllabus 13: Factors responsible for location of primary/secondary/tertiary industries
  { questionText: 'From being net food importer in 1960s, India has emerged as a net food exporter to the world. Provide reasons.', section: 'Agriculture', year: 2023 },
  { questionText: 'Discuss the factors for localization of agro-based food processing industries of North-West India.', section: 'Agriculture', year: 2019 },
  { questionText: 'How can Artificial Intelligence (AI) and drones be effectively used along with GIS and RS techniques in locational and areal planning?', section: 'Human and Economic Geography', year: 2025 },
  { questionText: 'Mention the advantages of the cultivation of pulse because of which the year 2016 was declared as the International Year of Pulses by the United Nations.', section: 'Agriculture', year: 2017 },

  { questionText: 'What are non-farm primary activities? How are these activities related to physiographic features in India? Discuss with suitable examples.', section: 'Indian Physiography', year: 2025 },
  { questionText: 'Describing the distribution of rubber producing countries, indicate the major environmental issues faced by them.', section: 'Human and Economic Geography', year: 2022 },
  { questionText: 'Despite India being one of the countries of the Gondwanaland, its mining industry contributes much less to Gross Domestic Product (GDP) in percentage. Discuss.', section: 'Indian Physiography', year: 2021 },
  { questionText: 'Define blue revolution, explain the problems and strategies for pisciculture development in India.', section: 'Agriculture', year: 2018 },
  { questionText: 'In spite of adverse environmental impact, coal mining is still inevitable for development." Discuss.', section: 'Indian Physiography', year: 2017 },
  { questionText: 'Whereas the British planters had developed tea gardens all along the Shivaliks and Lesser Himalayas from Assam to Himachal Pradesh, in effect they did not succeed beyond the Darjeeling area. Explain.', section: 'Indian Physiography', year: 2014 },

  { questionText: 'Why did the Green Revolution in India virtually by-pass the eastern region despite fertile soil and good availability of water?', section: 'Agriculture', year: 2014 },

  { questionText: 'Account for the present location of iron and steel industries away from the source of raw material, by giving examples.', section: 'Human and Economic Geography', year: 2020 },
  { questionText: 'Can the strategy of regional-resource based manufacturing help in promoting employment in India?', section: 'Indian Physiography', year: 2019 },
  { questionText: 'What is the significance of Industrial Corridors in India? Identify industrial corridors, explain their main characteristics.', section: 'Indian Physiography', year: 2018 },
  { questionText: 'Petroleum refineries are not necessarily located nearer to crude oil producing areas, particularly in many of the developing countries. Explain its implications.', section: 'Human and Economic Geography', year: 2017 },
  { questionText: 'Account for the change in the spatial pattern of the Iron and Steel industry in the world.', section: 'Human and Economic Geography', year: 2014 },
  { questionText: 'Do you agree that there is a growing trend of opening new sugar mills in the Southern states of India? Discuss with justification', section: 'Indian Physiography', year: 2013 },
  { questionText: 'Analyze the factors for highly decentralized cotton textile industry in India', section: 'Indian Physiography', year: 2013 },

  { questionText: 'Why is Indian Regional Navigational Satellite System (IRNSS) needed? How does it help in navigation?', section: 'Human and Economic Geography', year: 2018 },

  { questionText: 'Mention the significance of straits and isthmus in international trade.', section: 'Human and Economic Geography', year: 2022 },
  { questionText: 'How can the mountain ecosystem be restored from the negative impact of development initiatives and tourism?', section: 'Human and Economic Geography', year: 2019 },
  { questionText: 'Enumerate the problems and prospects of inland water transport in India.', section: 'Indian Drainage System', year: 2016 },
  { questionText: 'The states of Jammu and Kashmir, Himachal Pradesh and Uttarakhand reaching the limits of their ecological carrying capacity due to tourism. Critically evaluate.', section: 'Indian Physiography', year: 2015 },

  // Syllabus 14: Geophysical phenomena - earthquakes, tsunami, volcanic activity, cyclone
  { questionText: 'What are aurora australis and aurora borealis? How are these triggered?', section: 'Climatology', year: 2024 },
  { questionText: "What is the phenomenon of 'cloudbursts'? Explain.", section: 'Climatology', year: 2024 },
  { questionText: 'What is sea surface temperature rise? How does it affect the formation of tropical cyclones?', section: 'Climatology', year: 2024 },
  { questionText: 'Discuss the meaning of colour-coded weather warnings for cyclone prone areas given by India Meteorological Department.', section: 'Climatology', year: 2022 },
  { questionText: 'Tropical cyclones are largely confined to South China Sea, Bay of Bengal and Gulf of Mexico. Why?', section: 'Climatology', year: 2014 },
  { questionText: 'The recent cyclone on the east coast of India was called "Phailin". How are the tropical cyclones named across the world?', section: 'Climatology', year: 2013 },
  { questionText: 'Differentiate the causes of landslides in the Himalayan region and Western Ghats.', section: 'Indian Physiography', year: 2021 },
  { questionText: 'The Himalayas are highly prone to landslides. Discuss the causes and suggest suitable measures of mitigation.', section: 'Indian Physiography', year: 2016 },
  { questionText: 'Bring out the causes for more frequent landslides in the Himalayas than in Western Ghats', section: 'Indian Physiography', year: 2013 },
  { questionText: 'What are Tsunamis? How and where are they formed? What are their consequences? Explain with examples.', section: 'Oceanography', year: 2025 },
  { questionText: 'What is a twister? Why are the majority of twisters observed in areas around the Gulf of Mexico?', section: 'Climatology', year: 2024 },
  { questionText: 'Mention the global occurrence of volcanic eruptions in 2021 and their impact on regional environment.', section: 'Geomorphology', year: 2021 },

  // Syllabus 15: Changes in critical geographical features (water-bodies, ice-caps, flora, fauna)
  { questionText: 'How are climate change and the sea level rise affecting the very existence of many island nations? Discuss with examples.', section: 'Oceanography', year: 2025 },
  { questionText: 'Discuss the consequences of climate change on the food security in tropical countries.', section: 'Agriculture', year: 2023 },
  { questionText: 'The process of desertification does not have climatic boundaries. Justify with examples.', section: 'Biogeography', year: 2020 },

  { questionText: 'How does the melting of the Arctic ice and glaciers of the Antarctic differently affect the weather patterns and human activities on the Earth? Explain.', section: 'Oceanography', year: 2021 },
  { questionText: 'How will the melting of Himalayan glaciers have a far-reaching impact on the water resources of India?', section: 'Indian Climate', year: 2020 },
  { questionText: 'How does the cryosphere affect global climate?', section: 'Climatology', year: 2017 },
  { questionText: 'Bring out the relationship between the shrinking Himalayan glaciers and the symptoms of climate change in the Indian sub-continent.', section: 'Indian Climate', year: 2014 },

  { questionText: 'Identify and discuss the factors responsible for diversity of natural vegetation in India. Assess the significance of wildlife sanctuaries in rain forests regions of India.', section: 'Biogeography', year: 2023 },
  { questionText: 'Examine the status of forest resources of India and its resultant impact on climate change.', section: 'Biogeography', year: 2020 },
  { questionText: 'Assess the impact of global warming on coral life system with examples.', section: 'Oceanography', year: 2019 },
  { questionText: 'Discuss the causes of depletion of mangroves and explain their importance in maintaining coastal ecology.', section: 'Human and Economic Geography', year: 2019 },

  { questionText: 'South China Sea has assumed great geopolitical significance in the present context. Comment.', section: 'Oceanography', year: 2016 },

  { questionText: 'How does the Juno Mission of NASA help to understand the origin and evolution of the Earth?', section: 'Geomorphology', year: 2017 },

  { questionText: 'Mumbai, Delhi and Kolkata are the three mega cities of the country but the air pollution is much more serious problem in Delhi as compared to the other two. Why is this so?', section: 'Human and Economic Geography', year: 2015 },
  { questionText: 'Bring out the causes for the formation of heat islands in the urban habitat of the world.', section: 'Human and Economic Geography', year: 2013 },

  { questionText: 'The groundwater potential of the gangetic valley is on a serious decline. How may it affect the food security of India?', section: 'Indian Drainage System', year: 2024 },
  { questionText: 'Why is the world today confronted with a crisis of availability of and access to freshwater resources?', section: 'Human and Economic Geography', year: 2023 },
  { questionText: 'The interlinking of rivers can provide viable solutions to the multi-dimensional inter-related problems of droughts, floods and interrupted navigation. Critically examine.', section: 'Indian Drainage System', year: 2020 },
  { questionText: 'What is water stress? How and why does it differ regionally in India?', section: 'Indian Drainage System', year: 2019 },
  { questionText: 'The ideal solution of depleting ground water resources in India is water harvesting system. How can it be made effective in urban areas?', section: 'Indian Drainage System', year: 2018 },
  { questionText: 'In what way can flood be converted into a sustainable source of irrigation and all-weather inland navigation in India?', section: 'Indian Drainage System', year: 2017 },
  { questionText: 'In what way micro-watershed Development projects help in water conservation in drought prone and semi-arid regions of India.', section: 'Indian Drainage System', year: 2016 },
  { questionText: 'Present an account of the Indus Water Treaty and examine its ecological, economic and political implications in the context of changing bilateral relations.', section: 'Indian Drainage System', year: 2016 },
  { questionText: 'The effective management of land and water resources will drastically reduce the human miseries. Explain', section: 'Indian Drainage System', year: 2016 },
  { questionText: 'India is well endowed with fresh water resources. Critically examine why it still suffers from water scarcity.', section: 'Indian Drainage System', year: 2015 }
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

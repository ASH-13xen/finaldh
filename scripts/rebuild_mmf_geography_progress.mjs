// Full rebuild of the Progress checklist + PYQ data for "Mains Master File - Geography"
// (course 'MMF', fileIndex resolved by name below), replacing the flat "one row per Unit"
// design from import_mmf_geography_progress.mjs with the full numbered content index: each of
// the 10 Units is now its own Topic (was a shared "Physical Geography / Indian Geography /
// Agriculture" grouping), and every one of the 99 numbered points from the source index becomes
// its own checkable ProgressQuestion (was just the bare Unit name) - Agriculture is treated as
// a 10th unit per the user's explicit instruction. No page numbers were given (pageNumber stays
// null throughout, same as the original geography import).
//
// `tag` values are short clean labels for the small number of items with an unambiguous,
// specific PYQ match (e.g. "Temperature Inversion", "Tropical Cyclones", "Landslides") - most
// items are left untagged, so their PYQs fall back to matching the Unit (Topic name) itself,
// same broad-match mechanics as the original import.
//
// DESTRUCTIVE for this one course+file only: deletes existing Topics/ProgressQuestions (and
// their QuestionProgress completion records) and ProgressPyqs (and their PyqProgress completion
// records) scoped to (course: MMF, fileIndex: Geography) before rebuilding. Does not touch any
// other course or fileIndex.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Course from '../models/Course.js';
import Topic from '../models/Topic.js';
import ProgressQuestion from '../models/ProgressQuestion.js';
import QuestionProgress from '../models/QuestionProgress.js';
import ProgressPyq from '../models/ProgressPyq.js';
import PyqProgress from '../models/PyqProgress.js';
import { upsertTopicsAndQuestions } from '../controllers/progressController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const TARGET_FILE_NAME = 'Mains Master File - Geography';

const U1 = 'Unit 1: Geomorphology';
const U2 = 'Unit 2: Climatology';
const U3 = 'Unit 3: Oceanography';
const U4 = 'Unit 4: Biogeography';
const U5 = 'Unit 5: Human and Economic Geography';
const U6 = 'Unit 6: Indian Physiography';
const U7 = 'Unit 7: Indian Climate';
const U8 = 'Unit 8: Indian Drainage System';
const U9 = 'Unit 9: Indian Soils';
const U10 = 'Unit 10: Agriculture';

const CHECKLIST_ROWS = [
  { topicName: U1, questionText: '1. The theory of continental drift.', pageNumber: null, tag: 'Continental Drift & Plate Tectonics' },
  { topicName: U1, questionText: '2. Mantle plume and its role in plate tectonics.', pageNumber: null, tag: 'Mantle Plume;Continental Drift & Plate Tectonics' },
  { topicName: U1, questionText: '3. The different types of weathering and its geomorphic significance.', pageNumber: null, tag: '' },
  { topicName: U1, questionText: "4. The structure of the Earth's interior and the different sources of information used to study it.", pageNumber: null, tag: '' },
  { topicName: U1, questionText: '5. The convection current theory and its role in explaining continental drift and plate movements.', pageNumber: null, tag: 'Continental Drift & Plate Tectonics' },
  { topicName: U1, questionText: "6. The role of endogenic and exogenic forces in shaping the Earth's surface.", pageNumber: null, tag: '' },
  { topicName: U1, questionText: '7. Various landforms formed due to glacial action of erosion and deposition.', pageNumber: null, tag: 'Glacial Landforms' },
  { topicName: U1, questionText: '8. Continental Drift Theory and Evidence', pageNumber: null, tag: 'Continental Drift & Plate Tectonics' },
  { topicName: U1, questionText: '9. The interior structure of the Earth and the role of seismic wave analysis in revealing the characteristics of these zones.', pageNumber: null, tag: '' },
  { topicName: U1, questionText: '10. Plate tectonics theory was a culmination of different related theories and observations.', pageNumber: null, tag: 'Continental Drift & Plate Tectonics' },
  { topicName: U1, questionText: '11. Types of Volcanoes and Reactivation of Dormant Volcanoes', pageNumber: null, tag: 'Volcanoes' },
  { topicName: U1, questionText: '12. River Canyons: Formation, Differences from Gorges, and Aesthetic Value', pageNumber: null, tag: '' },
  { topicName: U1, questionText: '13. Evolution of the Earth and Emergence of Life-Supporting Conditions', pageNumber: null, tag: 'Evolution of the Earth' },
  { topicName: U1, questionText: '14. Earthquakes: Formation, Distribution, and Consequences', pageNumber: null, tag: '' },
  { topicName: U1, questionText: '15. Drying of Rivers: Causes and Implications', pageNumber: null, tag: '' },

  { topicName: U2, questionText: '16. The characteristics of the monsoon climate play in sustaining agriculture in Monsoon Asia.', pageNumber: null, tag: 'Monsoon Climate' },
  { topicName: U2, questionText: '17. Heat budget of the Earth.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '18. Temperature inversion - the suitable conditions for its occurrence and bring its impact on weather and the local population.', pageNumber: null, tag: 'Temperature Inversion' },
  { topicName: U2, questionText: '19. The mechanism of orographic rainfall and its significance in shaping the climate of a region.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '20. The factors that determine the pattern of planetary winds and the tricellular model of atmospheric circulation.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '21. The process of extratropical cyclone formation and how they differ from tropical cyclones.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: "22. Role of running water in shaping the Earth's surface in different climates.", pageNumber: null, tag: '' },
  { topicName: U2, questionText: '23. The factors that affect the speed and direction of wind and Formation of a Tropical Cyclone.', pageNumber: null, tag: 'Tropical Cyclones' },
  { topicName: U2, questionText: '24. Temperature inversion and its impact on the environment and human activities.', pageNumber: null, tag: 'Temperature Inversion' },
  { topicName: U2, questionText: '25. Various causes and impacts of heatwaves.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '26. Monsoon Climate and Agriculture in Monsoon Asia', pageNumber: null, tag: 'Monsoon Climate' },
  { topicName: U2, questionText: '27. The insolation and the factors affecting its distribution.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '28. The Inter-Tropical Convergence Zone (ITCZ) and the climatic impact of its seasonal shift.', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '29. Latitudinal Heat Imbalance as Driver of Climate Systems', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '30. Role of Temperature in Climate and Its Distribution', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '31. Ocean Relief vs Land Surface', pageNumber: null, tag: '' },
  { topicName: U2, questionText: '32. Atmospheric Stability and Cloud Formation', pageNumber: null, tag: '' },

  { topicName: U3, questionText: '33. The factors that influence temperature distribution of the oceans.', pageNumber: null, tag: '' },
  { topicName: U3, questionText: '34. The factors affecting the salinity of oceans and multi-dimensional effects of variations in oceanic salinity.', pageNumber: null, tag: 'Oceanic Salinity' },
  { topicName: U3, questionText: '35. The complex and varied features of ocean floor – major and minor relief features of the ocean floor.', pageNumber: null, tag: '' },
  { topicName: U3, questionText: '36. The sectoral ocean currents on the climate of coastal regions.', pageNumber: null, tag: '' },
  { topicName: U3, questionText: '37. The effect of melting of polar ice caps on global sea levels and coastal ecosystems.', pageNumber: null, tag: 'Polar Ice Melting' },
  { topicName: U3, questionText: '38. The tsunamigenic zones in the Indian Ocean, and the factors responsible for creation of tsunamis.', pageNumber: null, tag: 'Tsunami' },
  { topicName: U3, questionText: '39. The types of ocean currents and the various factors that influence ocean currents and their multi-dimensional impact.', pageNumber: null, tag: 'Ocean Currents' },
  { topicName: U3, questionText: '40. Factors Affecting Ocean Temperature Distribution', pageNumber: null, tag: '' },
  { topicName: U3, questionText: '41. The geophysical characteristics of Circum-Pacific Zone.', pageNumber: null, tag: 'Circum-Pacific Zone' },
  { topicName: U3, questionText: '42. Sea Level Rise: Challenges and Mitigation for India', pageNumber: null, tag: '' },
  { topicName: U3, questionText: '43. Formation of Lakes and Their Significance', pageNumber: null, tag: '' },

  { topicName: U4, questionText: '44. Process of soil formation and the various factors that influence the formation of soil.', pageNumber: null, tag: '' },
  { topicName: U4, questionText: '45. Origin of Deserts and Types', pageNumber: null, tag: 'Deserts' },

  { topicName: U5, questionText: '46. The impact of geographic, economic and socio-cultural factors on the distribution and density of population around the world.', pageNumber: null, tag: 'Population Distribution' },
  { topicName: U5, questionText: '47. Location of hi-tech industries around major metropolitan centers.', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '48. Monsoon contribution in global economic structure.', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '49. The distribution of palm oil producing countries and the major environmental issues faced by them.', pageNumber: null, tag: 'Plantation Crop Distribution' },
  { topicName: U5, questionText: '50. The multi-dimensional implications of uneven distribution of rare earth elements (REEs) in the world.', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '51. The factors responsible for regional variations in the fertility rate across the country.', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '52. The significance of mangroves for the coastal economy and ecology, the reasons for their depletion in the country and the initiatives taken by the government.', pageNumber: null, tag: 'Mangroves' },
  { topicName: U5, questionText: '53. The significance of straits and isthmus in international trade.', pageNumber: null, tag: 'Straits and Isthmus' },
  { topicName: U5, questionText: '54. Implications of Uneven Distribution of Rare Earth Elements (REEs)', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '55. Concentration of Semiconductor Manufacturing in Few Regions', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '56. Copper Distribution in India and Impact of Copper Imports', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '57. Role of Urban Forests in Climate Resilience', pageNumber: null, tag: 'Urban Geography' },
  { topicName: U5, questionText: '58. Spatial Pattern of Internal Migration in India', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '59. Potential and Challenges of Offshore Wind Energy in India', pageNumber: null, tag: 'Renewable Energy' },
  { topicName: U5, questionText: '60. Factors Influencing Location of Energy Storage Industries', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '61. Climate Change Challenges to Industries and Adaptation Strategies', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '62. Distribution and Industrial Demand for Silver', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '63. Locational Factors and Issues of Fertiliser Industry in India', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '64. Locational Factors and Government Measures for Pharmaceutical Industry', pageNumber: null, tag: '' },
  { topicName: U5, questionText: '65. Human development VS Economic development in India.', pageNumber: null, tag: '' },

  { topicName: U6, questionText: '66. The factors influencing industrial location and the major industrial regions in India.', pageNumber: null, tag: '' },
  { topicName: U6, questionText: '67. Various types of coal found in India and their distribution throughout the country.', pageNumber: null, tag: 'Coal Mining' },
  { topicName: U6, questionText: '68. Factors contribute to the concentration of the jute industry in and around West Bengal.', pageNumber: null, tag: '' },
  { topicName: U6, questionText: "69. Volcanic Hotspots and India's Geological Landscape", pageNumber: null, tag: 'Deccan Trap' },
  { topicName: U6, questionText: '70. Significance of Geological Heritage Sites in India', pageNumber: null, tag: '' },
  { topicName: U6, questionText: '71. Impact of Glacier Melting in Hindu Kush Himalayas', pageNumber: null, tag: '' },
  { topicName: U6, questionText: '72. Disaster Vulnerability of the Indian Himalayan Region (IHR)', pageNumber: null, tag: '' },
  { topicName: U6, questionText: '73. Landslides in Himalayas and Role of Hazard Zonation', pageNumber: null, tag: 'Landslides' },

  { topicName: U7, questionText: '74. The types of jet streams and how they affect the Indian Monsoon', pageNumber: null, tag: '' },
  { topicName: U7, questionText: '75. Impact of Glacier Melting in Hindu Kush Himalayas', pageNumber: null, tag: 'Glacier Melting' },
  { topicName: U7, questionText: '76. Climate Risk Assessment and Future-Proof Development in India', pageNumber: null, tag: '' },

  { topicName: U8, questionText: '77. Challenges in Indian Irrigation System and Government Measures', pageNumber: null, tag: 'Irrigation' },
  { topicName: U8, questionText: '78. The reasons for declining groundwater levels in India and its impact agricultural productivity.', pageNumber: null, tag: 'Groundwater Depletion' },
  { topicName: U8, questionText: '79. Vulnerability of Ganga–Brahmaputra Basin to Monsoon Floods', pageNumber: null, tag: '' },
  { topicName: U8, questionText: '80. Urban Flooding in India: Causes and Mitigation', pageNumber: null, tag: '' },

  { topicName: U9, questionText: '81. Reasons for Persistent Land Degradation in India', pageNumber: null, tag: '' },

  { topicName: U10, questionText: '82. Agroecology: Meaning and Principles', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '83. Digital Agriculture Mission: Overview and Benefits', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '84. Importance of Sustainable Water Management in Indian Agriculture', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '85. Role of PACS in Rural Upliftment and Inclusive Growth', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '86. Nuclear Technology for Food Security and Agricultural Sustainability', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '87. Food Processing Industry: Challenges and Corrective Measures', pageNumber: null, tag: 'Food Processing' },
  { topicName: U10, questionText: '88. Need for Reforms in Agricultural Subsidy Regime', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '89. Objectives and Measures of Land Reforms in India', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '90. Importance and Challenges of Buffer Stocks in India', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '91. Challenges in Indian Irrigation System and Government Measures', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '92. Cropping Pattern in India', pageNumber: null, tag: 'Cropping Pattern' },
  { topicName: U10, questionText: '93. Union Budget 2025-26 and Agriculture', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '94. Food Security in India', pageNumber: null, tag: 'Food Security' },
  { topicName: U10, questionText: '95. Role of Land Reforms in Agricultural Development', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '96. Agricultural Marketing in India', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '97. Micro-Irrigation System', pageNumber: null, tag: 'Micro-Irrigation' },
  { topicName: U10, questionText: '98. Public Distribution System (PDS)', pageNumber: null, tag: '' },
  { topicName: U10, questionText: '99. Consequences of Groundwater Depletion and Sustainable Management', pageNumber: null, tag: '' }
];

// ================= PYQs, re-classified against the granular items above =================
// section is either a specific tag (exact/near-exact content match) or the Unit's own Topic
// name (broad fallback when no numbered item covers the PYQ's theme).
const PYQ_ROWS = [
  { questionText: 'Troposphere is a very significant atmospheric layer that determines weather processes. How?', section: U2, year: 2022 },
  { questionText: 'Discuss the concept of air mass and explain its role in macro-climatic changes.', section: U2, year: 2016 },
  { questionText: "Why is the South-West monsoon called 'Purvaiya' (easterly) in Bhojpur Region? How has this directional seasonal wind system influenced the cultural ethos of the region?", section: 'Monsoon Climate', year: 2023 },
  { questionText: 'What characteristics can be assigned to monsoon climate that succeeds in feeding more than 50 percent of the world population residing in Monsoon Asia?', section: 'Monsoon Climate', year: 2017 },
  { questionText: 'How far do you agree that the behavior of the Indian monsoon has been changing due to humanizing landscapes? Discuss.', section: 'Monsoon Climate', year: 2015 },
  { questionText: 'Most of the unusual climatic happenings are explained as an outcome of the El-Nino effect. Do you agree?', section: U2, year: 2014 },
  { questionText: 'What do you understand by the phenomenon of temperature inversion in meteorology? How does it affect the weather and the habitants of the place?', section: 'Temperature Inversion', year: 2013 },
  { questionText: 'Major hot deserts in northern hemisphere are located between 20-30 degree north and on the western side of the continents. Why?', section: 'Deserts', year: 2013 },

  { questionText: 'Discuss how the changes in shape and sizes of continents and ocean basins of the planet take place due to tectonic movements of the crustal masses.', section: 'Continental Drift & Plate Tectonics', year: 2025 },
  { questionText: 'How are the fjords formed? Why do they constitute some of the most picturesque areas of the world?', section: 'Glacial Landforms', year: 2023 },
  { questionText: 'Describe the characteristics and types of primary rocks.', section: U1, year: 2022 },
  { questionText: 'Briefly mention the alignment of major mountain ranges of the world and explain their impact on local weather conditions, with examples.', section: 'Continental Drift & Plate Tectonics', year: 2021 },
  { questionText: 'Why is India considered as a subcontinent? Elaborate your answer.', section: U6, year: 2021 },
  { questionText: 'Discuss the geophysical characteristics of Circum-Pacific Zone.', section: 'Circum-Pacific Zone', year: 2020 },
  { questionText: 'Define mantle plume and explain its role in plate tectonics.', section: 'Mantle Plume', year: 2018 },
  { questionText: 'Explain the formation of thousands of islands in Indonesian and Philippines archipelagos.', section: 'Continental Drift & Plate Tectonics', year: 2014 },
  { questionText: "Why are the world's fold mountain systems located along the margins of continents? Bring out the association between the global distribution of Fold Mountains and the earthquakes and volcanoes.", section: 'Continental Drift & Plate Tectonics', year: 2014 },
  { questionText: 'What do you understand by the theory of continental drift? Discuss the prominent evidences in its support.', section: 'Continental Drift & Plate Tectonics', year: 2013 },
  { questionText: 'There is no formation of deltas by rivers of the Western Ghat. Why?', section: U1, year: 2013 },

  { questionText: 'What are the forces that influence ocean currents? Describe their role in fishing industry of the world.', section: 'Ocean Currents', year: 2022 },
  { questionText: 'How do ocean currents and water masses differ in their impacts on marine life and the coastal environment? Give suitable examples?', section: 'Ocean Currents', year: 2019 },
  { questionText: "What are the consequences of spreading of 'Dead Zones' on marine ecosystem?", section: U3, year: 2018 },
  { questionText: 'Account for variations in oceanic salinity and discuss its multi-dimensional effects.', section: 'Oceanic Salinity', year: 2017 },
  { questionText: 'Explain the factors responsible for the origin of ocean currents. How do they influence regional climates, fishing and navigation?', section: 'Ocean Currents', year: 2015 },
  { questionText: 'Critically evaluate the various resources of the oceans which can be harnessed to meet the resource crisis in the world.', section: U3, year: 2014 },

  { questionText: 'Discuss the distribution and density of population in the Ganga River Basin with special reference to land, soil and water resources.', section: 'Population Distribution', year: 2025 },
  { questionText: 'Explain briefly the ecological and economic benefits of solar energy generation in India with suitable examples.', section: 'Renewable Energy', year: 2025 },
  { questionText: 'Give a geographical explanation of the distribution of off-shore oil reserves of the world. How are they different from the on-shore occurrences of oil reserves?', section: U5, year: 2025 },
  { questionText: 'Comment on the resource potentials of the long coastline of India and highlight the status of natural hazard preparedness in these areas.', section: U5, year: 2023 },
  { questionText: "Discuss the natural resource potentials of 'Deccan Trap'.", section: 'Deccan Trap', year: 2022 },
  { questionText: 'Examine the potential of wind energy in India and explain the reasons for their limited spatial spread.', section: 'Renewable Energy', year: 2022 },
  { questionText: 'India has immense potential of solar energy though there are regional variations in its development. Elaborate.', section: 'Renewable Energy', year: 2020 },
  { questionText: 'Why is India taking keen interest in resources of Arctic Region?', section: U5, year: 2018 },
  { questionText: 'How does India see its place in the economic space of rising natural resource rich Africa?', section: U5, year: 2014 },
  { questionText: "It is said the India has substantial reserves of shale oil and gas, which can feed the needs of country for quarter century. However, tapping of the resources doesn't appear to be high on the agenda. Discuss critically the availability and issues involved.", section: U5, year: 2013 },
  { questionText: 'With growing scarcity of fossil fuels, the atomic energy is gaining more and more significance in India. Discuss the availability of raw material required for the generation of atomic energy in India and in the world.', section: U5, year: 2013 },

  { questionText: 'Discuss the multi-dimensional implications of uneven distribution of mineral oil in the world.', section: U5, year: 2021 },
  { questionText: 'What are the economic significances of discovery of oil in Arctic Sea and its possible environmental consequences?', section: U5, year: 2015 },

  { questionText: 'From being net food importer in 1960s, India has emerged as a net food exporter to the world. Provide reasons.', section: 'Food Security', year: 2023 },
  { questionText: 'Discuss the factors for localization of agro-based food processing industries of North-West India.', section: 'Food Processing', year: 2019 },
  { questionText: 'How can Artificial Intelligence (AI) and drones be effectively used along with GIS and RS techniques in locational and areal planning?', section: U5, year: 2025 },
  { questionText: 'Mention the advantages of the cultivation of pulse because of which the year 2016 was declared as the International Year of Pulses by the United Nations.', section: 'Cropping Pattern', year: 2017 },

  { questionText: 'What are non-farm primary activities? How are these activities related to physiographic features in India? Discuss with suitable examples.', section: U6, year: 2025 },
  { questionText: 'Describing the distribution of rubber producing countries, indicate the major environmental issues faced by them.', section: 'Plantation Crop Distribution', year: 2022 },
  { questionText: 'Despite India being one of the countries of the Gondwanaland, its mining industry contributes much less to Gross Domestic Product (GDP) in percentage. Discuss.', section: U6, year: 2021 },
  { questionText: 'Define blue revolution, explain the problems and strategies for pisciculture development in India.', section: U10, year: 2018 },
  { questionText: 'In spite of adverse environmental impact, coal mining is still inevitable for development." Discuss.', section: 'Coal Mining', year: 2017 },
  { questionText: 'Whereas the British planters had developed tea gardens all along the Shivaliks and Lesser Himalayas from Assam to Himachal Pradesh, in effect they did not succeed beyond the Darjeeling area. Explain.', section: U6, year: 2014 },

  { questionText: 'Why did the Green Revolution in India virtually by-pass the eastern region despite fertile soil and good availability of water?', section: U10, year: 2014 },

  { questionText: 'Account for the present location of iron and steel industries away from the source of raw material, by giving examples.', section: U5, year: 2020 },
  { questionText: 'Can the strategy of regional-resource based manufacturing help in promoting employment in India?', section: U6, year: 2019 },
  { questionText: 'What is the significance of Industrial Corridors in India? Identify industrial corridors, explain their main characteristics.', section: U6, year: 2018 },
  { questionText: 'Petroleum refineries are not necessarily located nearer to crude oil producing areas, particularly in many of the developing countries. Explain its implications.', section: U5, year: 2017 },
  { questionText: 'Account for the change in the spatial pattern of the Iron and Steel industry in the world.', section: U5, year: 2014 },
  { questionText: 'Do you agree that there is a growing trend of opening new sugar mills in the Southern states of India? Discuss with justification', section: U6, year: 2013 },
  { questionText: 'Analyze the factors for highly decentralized cotton textile industry in India', section: U6, year: 2013 },

  { questionText: 'Why is Indian Regional Navigational Satellite System (IRNSS) needed? How does it help in navigation?', section: U5, year: 2018 },

  { questionText: 'Mention the significance of straits and isthmus in international trade.', section: 'Straits and Isthmus', year: 2022 },
  { questionText: 'How can the mountain ecosystem be restored from the negative impact of development initiatives and tourism?', section: U5, year: 2019 },
  { questionText: 'Enumerate the problems and prospects of inland water transport in India.', section: U8, year: 2016 },
  { questionText: 'The states of Jammu and Kashmir, Himachal Pradesh and Uttarakhand reaching the limits of their ecological carrying capacity due to tourism. Critically evaluate.', section: U6, year: 2015 },

  { questionText: 'What are aurora australis and aurora borealis? How are these triggered?', section: U2, year: 2024 },
  { questionText: "What is the phenomenon of 'cloudbursts'? Explain.", section: U2, year: 2024 },
  { questionText: 'What is sea surface temperature rise? How does it affect the formation of tropical cyclones?', section: 'Tropical Cyclones', year: 2024 },
  { questionText: 'Discuss the meaning of colour-coded weather warnings for cyclone prone areas given by India Meteorological Department.', section: 'Tropical Cyclones', year: 2022 },
  { questionText: 'Tropical cyclones are largely confined to South China Sea, Bay of Bengal and Gulf of Mexico. Why?', section: 'Tropical Cyclones', year: 2014 },
  { questionText: 'The recent cyclone on the east coast of India was called "Phailin". How are the tropical cyclones named across the world?', section: 'Tropical Cyclones', year: 2013 },
  { questionText: 'Differentiate the causes of landslides in the Himalayan region and Western Ghats.', section: 'Landslides', year: 2021 },
  { questionText: 'The Himalayas are highly prone to landslides. Discuss the causes and suggest suitable measures of mitigation.', section: 'Landslides', year: 2016 },
  { questionText: 'Bring out the causes for more frequent landslides in the Himalayas than in Western Ghats', section: 'Landslides', year: 2013 },
  { questionText: 'What are Tsunamis? How and where are they formed? What are their consequences? Explain with examples.', section: 'Tsunami', year: 2025 },
  { questionText: 'What is a twister? Why are the majority of twisters observed in areas around the Gulf of Mexico?', section: U2, year: 2024 },
  { questionText: 'Mention the global occurrence of volcanic eruptions in 2021 and their impact on regional environment.', section: 'Volcanoes', year: 2021 },

  { questionText: 'How are climate change and the sea level rise affecting the very existence of many island nations? Discuss with examples.', section: 'Polar Ice Melting', year: 2025 },
  { questionText: 'Discuss the consequences of climate change on the food security in tropical countries.', section: 'Food Security', year: 2023 },
  { questionText: 'The process of desertification does not have climatic boundaries. Justify with examples.', section: 'Deserts', year: 2020 },

  { questionText: 'How does the melting of the Arctic ice and glaciers of the Antarctic differently affect the weather patterns and human activities on the Earth? Explain.', section: 'Polar Ice Melting', year: 2021 },
  { questionText: 'How will the melting of Himalayan glaciers have a far-reaching impact on the water resources of India?', section: 'Glacier Melting', year: 2020 },
  { questionText: 'How does the cryosphere affect global climate?', section: U2, year: 2017 },
  { questionText: 'Bring out the relationship between the shrinking Himalayan glaciers and the symptoms of climate change in the Indian sub-continent.', section: 'Glacier Melting', year: 2014 },

  { questionText: 'Identify and discuss the factors responsible for diversity of natural vegetation in India. Assess the significance of wildlife sanctuaries in rain forests regions of India.', section: U4, year: 2023 },
  { questionText: 'Examine the status of forest resources of India and its resultant impact on climate change.', section: U4, year: 2020 },
  { questionText: 'Assess the impact of global warming on coral life system with examples.', section: U3, year: 2019 },
  { questionText: 'Discuss the causes of depletion of mangroves and explain their importance in maintaining coastal ecology.', section: 'Mangroves', year: 2019 },

  { questionText: 'South China Sea has assumed great geopolitical significance in the present context. Comment.', section: U3, year: 2016 },

  { questionText: 'How does the Juno Mission of NASA help to understand the origin and evolution of the Earth?', section: 'Evolution of the Earth', year: 2017 },

  { questionText: 'Mumbai, Delhi and Kolkata are the three mega cities of the country but the air pollution is much more serious problem in Delhi as compared to the other two. Why is this so?', section: 'Urban Geography', year: 2015 },
  { questionText: 'Bring out the causes for the formation of heat islands in the urban habitat of the world.', section: 'Urban Geography', year: 2013 },

  { questionText: 'The groundwater potential of the gangetic valley is on a serious decline. How may it affect the food security of India?', section: 'Groundwater Depletion', year: 2024 },
  { questionText: 'Why is the world today confronted with a crisis of availability of and access to freshwater resources?', section: U5, year: 2023 },
  { questionText: 'The interlinking of rivers can provide viable solutions to the multi-dimensional inter-related problems of droughts, floods and interrupted navigation. Critically examine.', section: U8, year: 2020 },
  { questionText: 'What is water stress? How and why does it differ regionally in India?', section: U8, year: 2019 },
  { questionText: 'The ideal solution of depleting ground water resources in India is water harvesting system. How can it be made effective in urban areas?', section: 'Groundwater Depletion', year: 2018 },
  { questionText: 'In what way can flood be converted into a sustainable source of irrigation and all-weather inland navigation in India?', section: 'Irrigation', year: 2017 },
  { questionText: 'In what way micro-watershed Development projects help in water conservation in drought prone and semi-arid regions of India.', section: 'Micro-Irrigation', year: 2016 },
  { questionText: 'Present an account of the Indus Water Treaty and examine its ecological, economic and political implications in the context of changing bilateral relations.', section: U8, year: 2016 },
  { questionText: 'The effective management of land and water resources will drastically reduce the human miseries. Explain', section: U8, year: 2016 },
  { questionText: 'India is well endowed with fresh water resources. Critically examine why it still suffers from water scarcity.', section: U8, year: 2015 }
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

  // ---- Tear down old checklist (Topics + Questions + student completion records) ----
  const oldTopics = await Topic.find({ course: course._id, fileIndex });
  const oldQuestions = await ProgressQuestion.find({ course: course._id, fileIndex });
  const oldQuestionIds = oldQuestions.map((q) => q._id);
  const qpResult = await QuestionProgress.deleteMany({ course: course._id, fileIndex });
  await ProgressQuestion.deleteMany({ course: course._id, fileIndex });
  await Topic.deleteMany({ course: course._id, fileIndex });
  console.log(`Cleared ${oldTopics.length} old topic(s), ${oldQuestions.length} old question(s), ${qpResult.deletedCount} question-progress record(s).`);

  // ---- Tear down old PYQs (+ student completion records) ----
  const oldPyqs = await ProgressPyq.find({ course: course._id, fileIndex });
  const oldPyqIds = oldPyqs.map((p) => p._id);
  const ppResult = await PyqProgress.deleteMany({ pyq: { $in: oldPyqIds } });
  await ProgressPyq.deleteMany({ course: course._id, fileIndex });
  console.log(`Cleared ${oldPyqs.length} old PYQ(s), ${ppResult.deletedCount} PYQ-progress record(s).`);

  // ---- Rebuild checklist ----
  const result = await upsertTopicsAndQuestions(course, fileIndex, CHECKLIST_ROWS);
  console.log(`Checklist: inserted ${result.insertedCount} question(s) across ${result.touchedTopicCount} topic(s) (${result.newTopicsCount} new).`);
  if (result.skippedRows.length > 0) {
    console.log(`  skipped ${result.skippedRows.length} row(s):`);
    for (const s of result.skippedRows) console.log(`    - row ${s.row}: ${s.reason}`);
  }

  // ---- Rebuild PYQs ----
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

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Rebuild failed:', err);
  process.exit(1);
});

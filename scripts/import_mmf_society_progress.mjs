// One-time import of Progress checklist + PYQ data for the "Mains Master File-Society" file
// inside the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs.
//
// Source index is Topic (1-10) -> numbered sub-heading (X.Y) with page numbers, same two-level
// shape as the International Relations import. `tag` on each sub-heading is a short clean
// keyword used for precise PYQ matching; a few PYQ microthemes (Tribal Issues, "Uniqueness of
// Indian society", "Development and related issues", "Social empowerment") have no dedicated
// sub-heading in this particular index, so they fall back to the closest broad Topic instead.
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
const TARGET_FILE_NAME = 'Mains Master File-Society';

const T1 = 'Topic 1: Salient Features of Indian Society';
const T2 = 'Topic 2: Diversity of India';
const T3 = 'Topic 3: Communalism, Secularism & Religion';
const T4 = 'Topic 4: Caste System';
const T5 = 'Topic 5: Family & Marriage';
const T6 = 'Topic 6: Women & Gender';
const T7 = 'Topic 7: Migration';
const T8 = 'Topic 8: Urbanisation';
const T9 = 'Topic 9: Globalization';
const T10 = 'Topic 10: Population & Poverty';

const CHECKLIST_ROWS = [
  { topicName: T1, questionText: '1.1 Cultural Elements of Diversity in India', pageNumber: 1, tag: 'Cultural Diversity' },
  { topicName: T1, questionText: '1.2 Unity in Diversity: Supporting Factors and Challenges', pageNumber: 1, tag: 'Unity in Diversity' },

  { topicName: T2, questionText: '2.1 Linguistic Diversity & National Identity', pageNumber: 3, tag: 'Linguistic Diversity' },
  { topicName: T2, questionText: '2.2 Linguistic Regionalism – Challenge & Democratic Accommodation', pageNumber: 4, tag: 'Regionalism' },
  { topicName: T2, questionText: '2.3 Basis and Manifestations of Regionalism in India', pageNumber: 5, tag: 'Regionalism' },

  { topicName: T3, questionText: '3.1 Communalism and the Indian Model of Secularism', pageNumber: 7, tag: 'Communalism;Secularism' },
  { topicName: T3, questionText: '3.2 Secularism – Constitution to Society', pageNumber: 8, tag: 'Secularism' },
  { topicName: T3, questionText: '3.3 Challenges to Secularism in India', pageNumber: 8, tag: 'Secularism' },
  { topicName: T3, questionText: '3.4 Indian Secularism & Intra-Religious Inequalities', pageNumber: 9, tag: 'Secularism' },

  { topicName: T4, questionText: '4.1 Banning Caste Display', pageNumber: 11, tag: 'Caste System' },
  { topicName: T4, questionText: '4.2 Caste – Empowerment & Social Fragmentation', pageNumber: 12, tag: 'Caste System' },

  { topicName: T5, questionText: '5.1 Transformation of the Joint Family System in India', pageNumber: 13, tag: 'Family' },
  { topicName: T5, questionText: '5.2 Joint Family & Economic Factors', pageNumber: 13, tag: 'Family' },
  { topicName: T5, questionText: '5.3 Transformation of Marriage in India', pageNumber: 14, tag: 'Marriage' },

  { topicName: T6, questionText: "6.1 Gender Equality, Gender Equity and Women's Empowerment", pageNumber: 16, tag: "Women's Empowerment" },
  { topicName: T6, questionText: '6.2 Women & Property Rights', pageNumber: 17, tag: '' },
  { topicName: T6, questionText: '6.3 Challenges and Government Measures for Women Entrepreneurs', pageNumber: 17, tag: '' },
  { topicName: T6, questionText: "6.4 Globalization & Women's Employment – Equitable or Secure?", pageNumber: 18, tag: "Women's Employment" },
  { topicName: T6, questionText: "6.5 Reproductive Health – Status, Challenges & Women's Empowerment", pageNumber: 19, tag: '' },

  { topicName: T7, questionText: '7.1 Migration in India: Causes and Impact', pageNumber: 21, tag: 'Migration' },

  { topicName: T8, questionText: '8.1 Urbanisation in India: Opportunities and Challenges', pageNumber: 22, tag: 'Urbanisation' },
  { topicName: T8, questionText: '8.2 Urbanisation of Poverty', pageNumber: 23, tag: 'Urban Poverty' },
  { topicName: T8, questionText: '8.3 Gated Communities & Urban Slums – Division & Social Impact', pageNumber: 24, tag: '' },
  { topicName: T8, questionText: '8.4 Urban Planning Strategies vs. Environmental & Infrastructural Stress', pageNumber: 25, tag: 'Urban Planning' },

  { topicName: T9, questionText: '9.1 Globalization & Consumer Culture', pageNumber: 27, tag: 'Globalisation & Consumer Culture' },
  { topicName: T9, questionText: '9.2 Impact of Globalization on the Environment', pageNumber: 28, tag: 'Globalisation & Environment' },
  { topicName: T9, questionText: "9.3 Globalization's Impact on Indian Languages & Indigenous Knowledge Systems", pageNumber: 28, tag: 'Globalisation & Culture' },

  { topicName: T10, questionText: '10.1 Population Growth – Cause or Consequence of Poverty?', pageNumber: 30, tag: 'Population & Poverty' }
];

// ================= PYQs, classified against the checklist tags above =================
const PYQ_ROWS = [
  // 06. Salient features of Indian Society; Diversity of India
  { questionText: 'What is regional disparity? How does it differ from diversity? How serious is the issue of regional disparity in India?', section: 'Regionalism', year: 2024 },
  { questionText: "Critically analyse the proposition that there is a high correlation between India's cultural diversities and socio-economic marginalities.", section: 'Cultural Diversity', year: 2024 },
  { questionText: "Analyse the salience of 'sect' in Indian society vis-a-vis caste, region and religion.", section: T1, year: 2022 },
  { questionText: 'Do we have cultural pockets of small India all over the nation? Elaborate with examples.', section: 'Cultural Diversity', year: 2019 },
  { questionText: 'In the context of diversity of India, can it be said that the regions form cultural units rather than the States? Give reasons with examples for your viewpoint.', section: 'Regionalism', year: 2017 },
  { questionText: 'Describe any four cultural elements of diversity in India and rate their relative significance in building a national identity.', section: 'Cultural Diversity', year: 2015 },

  { questionText: 'Intercaste marriages between castes which have socio-economic parity have increased, to some extent, but this is less true of interreligious marriages. Discuss.', section: 'Marriage', year: 2024 },
  { questionText: 'Do you think marriage as a sacrament in losing its value in Modern India?', section: 'Marriage', year: 2023 },
  { questionText: 'Child cuddling is now being replaced by mobile phones. Discuss its impact on the socialization of children.', section: 'Family', year: 2023 },
  { questionText: "Explore and evaluate the impact of 'Work From Home' on family relationships.", section: 'Family', year: 2022 },
  { questionText: 'The life cycle of a joint family depends on economic factors rather than social values. Discuss.', section: 'Family', year: 2014 },

  { questionText: 'Does tribal development in India centre around two axes, those of displacement and of rehabilitation? Give your opinion.', section: T2, year: 2025 },
  { questionText: 'Given the diversities among tribal communities in India, in which specific contexts should they be considered as a single category?', section: T2, year: 2022 },
  { questionText: 'Examine the uniqueness of tribal knowledge system when compared with mainstream knowledge and cultural systems.', section: T2, year: 2021 },
  { questionText: 'How do you explain the statistics that show that the sex ratio in Tribes in India is more favourable to women than the sex ratio among Scheduled Castes?', section: T2, year: 2015 },

  { questionText: 'How does Indian society maintain continuity in traditional social values? Enumerate the changes taking place in it.', section: T1, year: 2021 },
  { questionText: 'What makes Indian society unique in sustaining its culture? Discuss.', section: T1, year: 2019 },
  { questionText: 'The spirit tolerance and love is not only an interesting feature of Indian society from very early times, but it is also playing an important part at the present. Elaborate.', section: T1, year: 2017 },

  // 07. Women, population, poverty and developmental issues
  { questionText: "'Achieving sustainable growth with emphasis on environmental protection could come into conflict with poor people's needs in a country like India' – Comment.", section: T10, year: 2025 },
  { questionText: "In dealing with socio-economic issues of development, what kind of collaboration between government, NGO's and private sector would be most productive?", section: T10, year: 2024 },
  { questionText: 'What is Cryptocurrency? How does it affect global society? Has it been affecting Indian society also?', section: T10, year: 2021 },
  { questionText: 'How have digital initiatives in India contributed to the functioning of the educational system in the country? Elaborate your answer.', section: T10, year: 2020 },

  { questionText: "What is the concept of a 'demographic winter'? Is the world moving towards such a situation? Elaborate.", section: 'Population & Poverty', year: 2024 },
  { questionText: 'Why did human development fail to keep pace with economic development in India?', section: T10, year: 2023 },
  { questionText: 'Discuss the main objectives of Population Education and point out the measures to achieve them in India in detail.', section: 'Population & Poverty', year: 2021 },
  { questionText: 'Critically examine whether growing population is the cause of poverty OR poverty is the main cause of population increase in India.', section: 'Population & Poverty', year: 2015 },
  { questionText: 'Discuss the changes in the trends of labour migration within and outside India in the last four decades.', section: 'Migration', year: 2015 },

  { questionText: 'COVID-19 pandemic accelerated class inequalities and poverty in India. Comment.', section: 'Population & Poverty', year: 2020 },
  { questionText: "Despite implementation of various programmes for eradication of poverty by the government in India, poverty is still existing.' Explain by giving reasons.", section: 'Population & Poverty', year: 2018 },
  { questionText: 'An essential condition to eradicate poverty is to liberate the poor from deprivation. Substantiate this statement with suitable examples', section: 'Population & Poverty', year: 2016 },

  { questionText: "Distinguish between gender equality, gender equity and women's empowerment. Why is it important to take gender concerns into account in programme design and implementation?", section: "Women's Empowerment", year: 2024 },
  { questionText: 'Explain why suicide among young women is increasing in Indian Society.', section: "Women's Empowerment", year: 2023 },
  { questionText: "Examine the role of 'Gig Economy' in the process of empowerment of women in India.", section: "Women's Employment", year: 2021 },
  { questionText: 'What are the continued challenges for women in India against time and space?', section: "Women's Empowerment", year: 2019 },
  { questionText: '"Empowering women is the key to control population growth". Discuss', section: "Women's Empowerment", year: 2019 },
  { questionText: "Women's movement in India has not addressed the issues of women of lower social strata. Substantiate your view.", section: "Women's Empowerment", year: 2018 },
  { questionText: 'Discuss the various economic and socio-cultural forces that are driving increasing feminization of agriculture in India.', section: "Women's Employment", year: 2014 },
  { questionText: 'How does patriarchy impact the position of a middle class working woman in India?', section: "Women's Empowerment", year: 2014 },
  { questionText: 'Why do some of the most prosperous regions of India have an adverse sex ratio for women? Give your arguments.', section: "Women's Empowerment", year: 2014 },
  { questionText: "Male membership needs to be encouraged in order to make women's organization free from gender bias. Comment.", section: "Women's Empowerment", year: 2013 },

  // 08. Urbanisation: problems and remedies
  { questionText: 'How is the growth of Tier 2 cities related to the rise of a new middle class with an emphasis on the culture of consumption?', section: 'Urbanisation', year: 2022 },
  { questionText: 'What are the main socio-economic implications arising out of the development of IT industries in major cities of India?', section: 'Urbanisation', year: 2021 },
  { questionText: 'The growth of cities as I.T. hubs has opened up new avenues employment but has also created new problems. Substantiate this statement with examples.', section: 'Urbanisation', year: 2017 },
  { questionText: 'Discussion the various social problems which originated out of the speedy process of urbanization in India.', section: 'Urbanisation', year: 2013 },

  { questionText: 'How does smart city in India, address the issues of urban poverty and distributive justice?', section: 'Urban Poverty', year: 2025 },
  { questionText: 'Why do large cities tend to attract more migrants than smaller towns? Discuss in the light of conditions in developing countries.', section: 'Migration', year: 2024 },
  { questionText: 'Does urbanization lead to more segregation and/or marginalization of the poor in Indian metropolises?', section: 'Urban Poverty', year: 2023 },

  { questionText: 'How is efficient and affordable urban mass transport key to the rapid economic development of India?', section: 'Urban Planning', year: 2019 },
  { questionText: 'Mention core strategies for the transformation of aspirational districts in India and explain the nature of convergence, collaboration and competition for its success.', section: 'Urban Planning', year: 2018 },
  { questionText: "With a brief background of quality of urban life in India, introduce the objectives and strategy of the 'Smart City Programme'.", section: 'Urban Planning', year: 2016 },
  { questionText: 'Smart cities in India cannot sustain without smart villages. Discuss this statement in the backdrop of rural urban integration.', section: 'Urban Planning', year: 2015 },

  { questionText: 'What are the environmental implications of the reclamation of water bodies into urban land use? Explain with examples.', section: 'Urban Planning', year: 2021 },
  { questionText: 'Account for the huge flooding of million cities in India including the smart ones like Hyderabad and Pune. Suggest lasting remedial measures.', section: 'Urban Planning', year: 2020 },
  { questionText: 'Major cities of India are becoming more vulnerable to flood conditions. Discuss.', section: 'Urban Planning', year: 2016 },

  // 09. Globalisation and its effects on Indian society
  { questionText: 'How do you account for the growing fast food industries given that there are increased health concerns in modern society? Illustrate your answer with the Indian experience.', section: 'Globalisation & Consumer Culture', year: 2025 },
  { questionText: 'Do you think that globalization results in only an aggressive consumer culture?', section: 'Globalisation & Consumer Culture', year: 2025 },
  { questionText: 'Globalization has increased urban migration by skilled, young, unmarried women from various classes. How has this trend impacted upon their personal freedom and relationship with family?', section: "Women's Employment", year: 2024 },
  { questionText: 'Elucidate the relationship between globalization and new technology in a world of scarce resources, with special reference to India.', section: 'Globalisation & Environment', year: 2022 },
  { questionText: 'Is diversity and pluralism in India under threat due to globalisation? Justify your answer.', section: 'Globalisation & Culture', year: 2020 },
  { questionText: 'Are we losing our local identity for the global identity? Discuss.', section: 'Globalisation & Culture', year: 2019 },
  { questionText: 'Globalization is generally said to promote cultural homogenization but due to this cultural specificities appear to be strengthened in the Indian Society. Elucidate.', section: 'Globalisation & Culture', year: 2018 },
  { questionText: 'To what extent globalization has influenced the core of cultural diversity in India? Explain.', section: 'Globalisation & Culture', year: 2016 },
  { questionText: 'Discuss the positive and negative effects of globalization on women in India.', section: "Women's Employment", year: 2015 },
  { questionText: 'Critically examine the effects of globalization on the aged population in India.', section: T9, year: 2013 },

  // 10. Social empowerment, communalism, regionalism & secularism
  { questionText: 'Why is caste identity in India both fluid and static?', section: 'Caste System', year: 2023 },
  { questionText: 'Has caste lost its relevance in understanding the multi-cultural Indian Society? Elaborate your answer with illustrations.', section: 'Caste System', year: 2020 },
  { questionText: 'Caste system is assuming new identities and associational forms. Hence, caste system cannot be eradicated in India. Comment.', section: 'Caste System', year: 2018 },
  { questionText: 'Debate the issue of whether and how contemporary movements for assertion of Dalit identity work towards annihilation of caste.', section: 'Caste System', year: 2015 },

  { questionText: 'Discuss the impact of post-liberal economy on ethnic identity and communalism.', section: 'Communalism', year: 2023 },
  { questionText: 'Communalism arises either due to power struggle or relative deprivation. Argue by giving suitable illustrations.', section: 'Communalism', year: 2018 },
  { questionText: 'Distinguish between religiousness/religiosity and communalism giving one example of how the former has got transformed into the latter in independent India.', section: 'Communalism', year: 2017 },

  { questionText: 'The ethos of civil service in India stand for the combination of professionalism with nationalistic consciousness – Elucidate.', section: T1, year: 2025 },
  { questionText: 'Customs and traditions suppress reason leading to obscurantism. Do you agree?', section: T1, year: 2020 },

  { questionText: 'Do you agree that regionalism in India appears to be a consequence of rising cultural assertiveness? Argue.', section: 'Regionalism', year: 2020 },
  { questionText: 'What is the basis of regionalism? Is it that unequal distribution of benefits of development on regional basis eventually promotes regionalism? Substantiate your answer.', section: 'Regionalism', year: 2016 },
  { questionText: 'Growing feeling of regionalism is an important factor in the generation of demand for a separate state. Discuss.', section: 'Regionalism', year: 2013 },

  { questionText: 'Are tolerance, assimilation and pluralism the key elements in the making of an Indian form of secularism? Justify your answer.', section: 'Secularism', year: 2022 },
  { questionText: 'What are the challenges to our cultural practices in the name of secularism.', section: 'Secularism', year: 2019 },
  { questionText: 'How the Indian concept of secularism is different from the western model of secularism? Discuss.', section: 'Secularism', year: 2018 },
  { questionText: 'How do the Indian debates on secularism differ from the debates in the West?', section: 'Secularism', year: 2014 },

  { questionText: 'Despite comprehensive policies for equity and social justice, underprivileged sections are not yet getting the full benefits of affirmative action envisaged by the Constitution. Comment.', section: 'Caste System', year: 2024 },
  { questionText: 'What are the two major legal initiatives by the State since Independence, addressing discrimination against Scheduled Tribes (STs)?', section: 'Caste System', year: 2017 },
  { questionText: 'Why are the tribals in India referred to as the Scheduled Tribes? Indicate the major provisions enshrined in the Constitution of India for their upliftment.', section: 'Caste System', year: 2016 }
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

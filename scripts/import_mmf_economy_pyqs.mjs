// Follow-up import of PYQs for the "Mains Master File - Economy" file inside the existing
// "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Checklist already exists
// (import_mmf_economy_progress.mjs); this only adds ProgressPyq rows, matched against that
// checklist's existing `tag` values (see that script for the full CHECKLIST_ROWS with tags) -
// no new tags needed, every PYQ here matches an existing tag or falls back to its Chapter.
//
// Not blindly rerunnable: delete+reinsert for PYQs. Guarded with an existing-PYQ check that
// skips unless --force.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Course from '../models/Course.js';
import ProgressPyq from '../models/ProgressPyq.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const FORCE = process.argv.includes('--force');
const TARGET_FILE_NAME = 'Mains Master File - Economy';

const C1 = 'Chapter 1: National Income & GDP';
const C4 = 'Chapter 4: Fiscal Policy & Public Expenditure';
const C5 = 'Chapter 5: Balance of Payments & Exchange Rate';
const C6 = 'Chapter 6: Trade, Reforms & Indian Economy';
const C7 = 'Chapter 7: Employment & Labour';
const C8 = 'Chapter 8: Human Capital, Poverty & Inclusive Growth';
const C9 = 'Chapter 9: Industry & Manufacturing';
const C10 = 'Chapter 10: Infrastructure, Transport & Capital Markets';
const C11 = 'Chapter 11: Agriculture & Land';

const PYQ_ROWS = [
  // 01. Indian Economy - planning, mobilization of resources, growth, development, employment
  { questionText: "Distinguish between 'care economy' and 'monetized economy'. How can care economy be brought into monetized economy through women empowerment?", section: 'Informal Sector;National Income', year: 2023 },
  { questionText: '"While we flaunt India\'s demographic dividend, we ignore the dropping rates of employability."What are we missing while doing so? Where will the jobs that India desperately needs come from? Explain', section: 'FLFPR;Demographic Dividend', year: 2014 },
  { questionText: 'What is the status of digitalization in the Indian economy? Examine the problems faced in this regard and suggest improvements.', section: 'DPI', year: 2023 },
  { questionText: '"Economic growth in the recent past has been led by increase in labour productivity."Explain this statement. Suggest the growth pattern that will lead to creation of more jobs without compromising labour productivity.', section: 'Automation;Unemployment', year: 2022 },
  { questionText: 'Do you agree that the Indian economy has recently experienced V-shapes recovery? Give reasons in support of your answer.', section: C1, year: 2021 },
  { questionText: "Among several factors for India's potential growth, savings rate is the most effective one. Do you agree? What are the other factors available for growth potential?", section: C1, year: 2017 },
  { questionText: 'Explain the rationale behind the Goods and Services Tax (Compensation to States) Act of 2017. How has COVID-19 impacted the GST compensation fund and created new federal tensions?', section: C4, year: 2020 },
  { questionText: 'Enumerate the indirect taxes which have been subsumed in the goods and services tax (GST) in India. Also, comment on the revenue implications of the GST introduced in India since July 2017.', section: C4, year: 2019 },
  { questionText: 'Discuss the rationale for introducing the Goods and Services Tax (GST) in India. Bring out critically the reasons for the delay in roll out for its regime.', section: C4, year: 2013 },
  { questionText: 'The increase in life expectancy in the country has led to newer health challenges in the community. What are those challenges and what steps need to be taken to meet them?', section: 'Human Capital', year: 2022 },
  { questionText: 'Discuss the rationale of the Production Linked Incentive (PLI) scheme. What are its achievements? In what way can the functioning and outcomes of the scheme be improved?', section: 'PLI Scheme', year: 2025 },
  { questionText: 'India aims to become a semiconductor manufacturing hub. What are the challenges faced by the semiconductor industry in India? Mention the salient features of the India Semiconductor Mission.', section: 'Semiconductor', year: 2025 },
  { questionText: 'Faster economic growth requires increased share of the manufacturing sector in GDP, particularly of MSMEs. Comment on the present policies of the Government in this regard.', section: 'MSME', year: 2023 },
  { questionText: '"Success of make in India program depends on the success of Skill India programme and radical labour reforms." Discuss with logical arguments.', section: C9, year: 2015 },
  { questionText: "Explain the difference between computing methodology of India's Gross Domestic Product(GDP) before the year 2015 and after the year 2015.", section: 'GDP', year: 2021 },
  { questionText: 'Define potential GDP and explain its determinants. What are the factors that have been inhibiting India from realizing its potential GDP?', section: 'Potential GDP', year: 2020 },
  { questionText: 'Do you agree with the view that steady GDP growth and low inflation have left the Indian economy in good shape? Give reasons in support of your arguments.', section: 'GDP', year: 2019 },
  { questionText: 'How are the principles followed by the NITI Aayog different from those followed by the erstwhile Planning Commission in India?', section: C1, year: 2018 },
  { questionText: 'What are the causes of persistent high food inflation in India? Comment on the effectiveness of the monetary policy of the RBI to control this type of inflation.', section: 'Food Inflation;Inflation', year: 2024 },
  { questionText: 'Most of the unemployment in India is structural in nature. Examine the methodology adopted to compute unemployment in the country and suggest improvements.', section: 'PLFS;Unemployment', year: 2023 },
  { questionText: 'The nature of economic growth in India in recent times is often described as a jobless growth. Do you agree with this view? Give arguments in favour of your answer.', section: 'PLFS;Unemployment', year: 2015 },

  // 02. Inclusive growth and issues therein
  { questionText: 'With a consideration towards the strategy of inclusive growth, the new Companies Bill, 2013 has indirectly made CSR a mandatory obligation. Discuss the challenges expected in its implementation in right earnest. Also discuss other provisions in the Bill and their implications', section: C8, year: 2013 },
  { questionText: 'Is inclusive growth possible under market economy? State the significance of financial inclusion in achieving economic growth in India.', section: 'Financial Inclusion', year: 2022 },
  { questionText: 'Pradhan Mantri Jan-Dhan Yojana (PMJDY) is necessary for bringing unbanked to the institutional fiancé fold. Do you agree with this for financial inclusion of the poorer section of the Indian society? Give arguments to justify your opinion.', section: 'Financial Inclusion', year: 2016 },
  { questionText: 'Distinguish between the Human Development Index (HDI) and Inequality-adjusted Human Development Index (IHDI) with special reference to India. Why is the IHDI considered a better indicator of inclusive growth?', section: 'Human Development;Human Capital', year: 2025 },
  { questionText: "What are the salient features of 'inclusive growth'? Has India been experiencing such a growth process? Analyze and suggest measures for inclusive growth.", section: 'Inclusive Growth', year: 2017 },
  { questionText: 'Comment on the challenges for inclusive growth which include careless and useless manpower in the Indian context. Suggest measures to be taken for facing these challenges', section: 'Inclusive Growth', year: 2016 },
  { questionText: 'Capitalism has guided the world economy to unprecedented prosperity. However, it often encourages shortsightedness and contributes to wide disparities between the rich and the poor. In this light, would it be correct to believe and adopt capitalism driving inclusive growth in India? Discuss.', section: 'Inclusive Growth', year: 2014 },
  { questionText: '"Investment in infrastructure is essential for more rapid and inclusive economic growth."Discuss in the light of India\'s experience', section: 'Infrastructure', year: 2021 },
  { questionText: "What are 'Smart Cities'? examine their relevance for urban development in India. Will it increase rural-urban differences? Give arguments for 'Smart Villages' in the light of PURA and RURBAN Mission.", section: C10, year: 2016 },
  { questionText: 'Examine the pattern and trend of public expenditure on social services in the post-reforms period in India. To what extent this has been in consonance with achieving the objective of inclusive growth?', section: 'Public Expenditure', year: 2024 },
  { questionText: 'Explain intra-generational and inter-generational issues of equity from the perspective of inclusive growth and sustainable development.', section: 'Inclusive Growth', year: 2020 },
  { questionText: 'It is argued that the strategy of inclusive growth is intended to meet the objectives of inclusiveness and sustainability together. Comment on this statement.', section: 'Inclusive Growth', year: 2019 },

  // 03. Government Budgeting
  { questionText: 'Explain how the Fiscal Health Index (FHI) can be used as a tool for assessing the fiscal performance of states in India. In what way would it encourage the states to adopt prudent and sustainable fiscal policies?', section: C4, year: 2025 },
  { questionText: 'Distinguish between Capital Budget and Revenue Budget. Explain the components of both these Budgets.', section: 'Capital Budget;Revenue Budget', year: 2021 },
  { questionText: 'The public expenditure management is a challenge to the Government of India in context of budget making during the post liberalization period. Clarify it.', section: 'Public Expenditure', year: 2019 },
  { questionText: 'Comment on the important changes introduced in respect of the Long term Capital Gains Tax (LCGT) and Dividend Distribution Tax (DDT) in the Union Budget for 2018-2019.', section: C4, year: 2018 },
  { questionText: "One of the intended objectives of Union Budget 2017-18 is to 'transform, energize and clean India'.Analyse the measures proposed in the Budget 2017-18 to achieve the objective.", section: C4, year: 2017 },
  { questionText: "What is the meaning of the term 'tax expenditure'? Taking housing sector as an example, discuss how it influences the budgetary policies of the government.", section: C4, year: 2013 },
  { questionText: 'What were the reasons for the introduction of Fiscal Responsibility and Budget Management (FRBM) Act, 2003? Discuss critically its salient features and their effectiveness', section: 'Fiscal Deficit', year: 2013 },
  { questionText: 'Women empowerment in India needs gender budgeting. What are requirements and status of gender budgeting in the Indian context?', section: 'Gender Budgeting', year: 2016 },

  // 10. Food processing and related industries
  { questionText: 'India needs to strengthen measures to promote the pink revolution in food industry for ensuring better nutrition and health. Critically elucidate the statement.', section: C11, year: 2013 },
  { questionText: 'Examine the scope of the food processing industries in India. Elaborate the measures taken by the government in the food processing industries for generating employment opportunities.', section: 'Food Processing', year: 2025 },
  { questionText: 'Elaborate the scope and significance of the food processing industry in India', section: 'Food Processing', year: 2022 },
  { questionText: 'What are the challenges and opportunities of food processing sector in the country? How can income of the farmers be substantially increased by encouraging food processing?', section: 'Food Processing', year: 2020 },
  { questionText: 'Elaborate on the policy taken by the government of India to meet the challenges of the food processing sector.', section: 'Food Processing', year: 2019 },
  { questionText: 'What are the reasons for poor acceptance of cost-effective small processing unit? How the food processing unit will be helpful to uplift the socio-economic status of poor farmers?', section: 'Food Processing', year: 2017 },
  { questionText: 'What are the impediments in marketing and supply chain management in developing the food processing industry in India? Can e-commerce help in overcoming this bottleneck?', section: 'Food Processing', year: 2015 },

  // 12. Effects of liberalization, industrial policy changes
  { questionText: 'Craze for gold in Indians have led to a surge in import of gold in recent years and put pressure on balance of payments and external value of rupee. In view of this, examine the merits of Gold Monetization Scheme.', section: 'Balance of Payments', year: 2015 },
  { questionText: 'How would the recent phenomena of protectionism and currency manipulations in world trade affect macroeconomic stability of India?', section: 'Exchange Rate;Rupee', year: 2018 },
  { questionText: "Discuss the merits and demerits of the four 'Labour Codes' in the context of labour market reforms in India. What has been the progress so far in this regard?", section: 'Labour Codes', year: 2024 },
  { questionText: '"Industrial growth rate has lagged behind in the overall growth of Gross-Domestic-Product (GDP)in the post-reform period" Give reasons. How far the recent changes is Industrial Policy are capable of increasing the industrial growth rate?', section: C9, year: 2017 },
  { questionText: 'How globalization has led to the reduction of employment in the formal sector of the Indian economy? Is increased in formalization detrimental to the development of the country?', section: C7, year: 2016 },
  { questionText: 'Normally countries shift from agriculture to industry and then later to services, but India shifted directly from agriculture to services. What are the reasons for the huge growth-services vis-a-vis industry in the country? Can India become a developed country without a strong industrial base?', section: 'Services Sector;Industrial Sector', year: 2014 },
  { questionText: 'Examine the impact of liberalization on companies owned by Indians. Are they competing with the MNCs satisfactorily? Discuss.', section: 'Economic Reforms 1991;NEP', year: 2013 },
  { questionText: 'Account for the failure of manufacturing sector in achieving the goal of labour-intensive exports rather than capital-intensive exports. Suggest measures for more labour-intensive rather than capital-intensive exports.', section: C9, year: 2017 },
  { questionText: 'There is a clear acknowledgement that Special Economic Zones (SEZs) are a tool of industrial development, manufacturing and exports. Recognising this potential, the whole instrumentality of SEZs require augmentation. Discuss the issue plaguing the success of SEZs with respect to taxation, governing laws and administration.', section: C9, year: 2015 },
  { questionText: 'What are the challenges before the Indian economy when the world is moving away from free trade and multilateralism to protectionism and bilateralism? How can these challenges be met?', section: 'Trade Agreements', year: 2025 },

  // 13. Infrastructure: Energy, Ports, Roads, Airports, Railways
  { questionText: "What is the need for expanding the regional air connectivity in India? In this context, discuss the government's UDAN Scheme and its achievements.", section: 'UDAN', year: 2024 },
  { questionText: 'International civil aviation laws provide all countries complete and exclusive sovereignty over the airspace above the territory. What do you understand by airspace? What are the implications of these laws on the space above this airspace? Discuss the challenges which this poses and suggests ways to contain the threat.', section: 'FDTL;Aviation', year: 2014 },
  { questionText: "National Urban Transport Policy emphasises on 'moving people' instead of 'moving vehicles. Discuss critically the success of the various strategies of the Government in this regard.", section: C10, year: 2014 },
  { questionText: 'Why is Public Private Partnership (PPP) required in infrastructural projects? Examine the role of PPP model in the redevelopment of Railway Stations in India.', section: 'PPP', year: 2022 },
  { questionText: 'Examine the developments of Airports in India through Joint Ventures under Public-Private Partnership (PPP) model. What are the challenges faced by the authorities in this regard.', section: 'PPP', year: 2017 },
  { questionText: "Explain how Private Public Partnership arrangements, in long gestation infrastructure projects, can transfer unsustainable liabilities to the future. What arrangements need to be put in place to ensure that successive generations' capacities are not compromised?", section: 'PPP', year: 2014 },
  { questionText: 'Adoption of PPP model for infrastructure development of the country has not been free of criticism. Critically discuss the pros and cons of the model.', section: 'PPP', year: 2013 },
  { questionText: 'Do you think India will meet 50 percent of its energy needs from renewable energy by 2030? Justify your answer. How will the shift of subsidies from fossil fuels to renewables help achieve the above objective? Explain.', section: 'Renewable Energy', year: 2022 },
  { questionText: 'Describe the benefits of deriving electric energy from sunlight in contrast to the conventional energy generation. What are the initiatives offered by our Government for this purpose?', section: 'Renewable Energy', year: 2020 },
  { questionText: '"Access to affordable, reliable, sustainable and modern energy is the sine qua non to achieve Sustainable Development Goals (SDGs)". Comment on the progress made in India in this regard.', section: 'Household Energy Access', year: 2018 },
  { questionText: 'Give an account of the current status and the targets to be achieved pertaining to renewable energy sources in the country. Discuss in brief the importance of National Programme on Light Emitting diodes (LEDs).', section: 'Renewable Energy', year: 2016 },
  { questionText: 'To what factors can be the recent dramatic fall in equipment cost and tariff of solar energy be attributed? What implications does the trend have for thermal power producers and related industry?', section: 'Renewable Energy', year: 2015 },
  { questionText: "Write a note on India's green energy corridor to alleviate the problem of conventional energy.", section: 'Renewable Energy', year: 2013 },
  { questionText: 'What do you understand by run of the river hydroelectricity project? How is it different from any other hydroelectricity project?', section: 'Renewable Energy', year: 2013 },

  // 14. Investment models
  { questionText: 'Justify the need for FDI for the developments of the Indian economy. Why there is gap between MOUs signed and actual FDIs? Suggest remedial steps to be taken for increasing actual FDIs in India.', section: 'Balance of Payments', year: 2016 },
  { questionText: 'Foreign Direct Investment (FDI) in the defence sector is now set to be liberalized: What in fluence this is expected to have on Indian defence and economy in the short and long run?', section: 'Balance of Payments', year: 2014 },
  { questionText: 'Discuss the impact of FDI entry into multi-trade retail sector on supply chain management in commodity trade pattern of the economy.', section: 'Balance of Payments', year: 2013 },
  { questionText: 'Though India allowed Foreign Direct Investment (FDI) in what is called multi-brand retail through the joint venture route in September 2012, the FDI, even after a year, has not picked up. Discuss the reasons.', section: 'Balance of Payments', year: 2013 },
  { questionText: 'Explain the meaning of investment in an economy in terms of capital formation. Discuss the factors to be considered while designing a concession agreement between a public entity and a private entity.', section: 'PPP', year: 2020 }
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

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

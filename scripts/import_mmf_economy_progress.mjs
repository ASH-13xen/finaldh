// One-time import of the Progress checklist for the "Mains Master File - Economy" file inside
// the existing "Mains Master File" Course (courseId 'MMF', subject 'All GS'). Same
// course+fileIndex-scoped approach as import_mmf_ir_progress.mjs / import_mmf_geography_progress.mjs.
//
// No page numbers were given for this index (unlike IR) - pageNumber is left null throughout
// (see models/ProgressQuestion.js, now optional). No PYQs were supplied yet either - only the
// checklist (Topics = Chapters, Questions = numbered sub-headings) is imported here. Each
// sub-heading carries a `tag` keyword so a follow-up PYQ import can match precisely once PYQs
// are provided (same pattern as import_mmf_ir_progress.mjs).
//
// Not blindly rerunnable: additive/upsert via upsertTopicsAndQuestions. Guarded with an
// existing-Topic check that skips unless --force.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Course from '../models/Course.js';
import Topic from '../models/Topic.js';
import { upsertTopicsAndQuestions } from '../controllers/progressController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const FORCE = process.argv.includes('--force');
const TARGET_FILE_NAME = 'Mains Master File - Economy';

const C1 = 'Chapter 1: National Income & GDP';
const C2 = 'Chapter 2: Inflation';
const C3 = 'Chapter 3: Money, Banking & Monetary Policy';
const C4 = 'Chapter 4: Fiscal Policy & Public Expenditure';
const C5 = 'Chapter 5: Balance of Payments & Exchange Rate';
const C6 = 'Chapter 6: Trade, Reforms & Indian Economy';
const C7 = 'Chapter 7: Employment & Labour';
const C8 = 'Chapter 8: Human Capital, Poverty & Inclusive Growth';
const C9 = 'Chapter 9: Industry & Manufacturing';
const C10 = 'Chapter 10: Infrastructure, Transport & Capital Markets';
const C11 = 'Chapter 11: Agriculture & Land';

// pageNumber is null throughout - none were given for this index.
const CHECKLIST_ROWS = [
  { topicName: C1, questionText: '1.1 Nominal GDP vs Real GDP – Why Real GDP is Preferred', pageNumber: null, tag: 'GDP;Real GDP;Nominal GDP' },
  { topicName: C1, questionText: '1.2 Per Capita Income (PCI) – Meaning and Inadequacy as Development Measure', pageNumber: null, tag: 'Per Capita Income;PCI' },
  { topicName: C1, questionText: '1.3 GDP as a Measure of Development – Merits & Limitations', pageNumber: null, tag: 'GDP' },
  { topicName: C1, questionText: '1.4 Limitations of GDP as Welfare Indicator', pageNumber: null, tag: 'GDP' },
  { topicName: C1, questionText: '1.5 Potential GDP – Definition & Factors Preventing India from Realising It', pageNumber: null, tag: 'Potential GDP' },
  { topicName: C1, questionText: '1.6 Informal Sector & National Income Estimation Challenges', pageNumber: null, tag: 'Informal Sector;National Income' },

  { topicName: C2, questionText: '2.1 Cost-Push vs Demand-Pull Inflation & Impact on Economy', pageNumber: null, tag: 'Inflation' },
  { topicName: C2, questionText: '2.2 Inflation – Demand-Pull & Cost-Push Factors in India', pageNumber: null, tag: 'Inflation' },
  { topicName: C2, questionText: '2.3 Measures to Control Inflation & Their Limitations', pageNumber: null, tag: 'Inflation' },
  { topicName: C2, questionText: '2.4 Persistent High Food Inflation in India – Causes & Measures for Price Stability', pageNumber: null, tag: 'Food Inflation;Inflation' },
  { topicName: C2, questionText: '2.5 Consumer Price Index (CPI) vs Wholesale Price Index (WPI) – Why CPI is Preferred', pageNumber: null, tag: 'CPI;WPI' },

  { topicName: C3, questionText: '3.1 Functions of Money', pageNumber: null, tag: 'Money' },
  { topicName: C3, questionText: '3.2 Banking System – Role in Economic Growth & Credit Creation', pageNumber: null, tag: 'Banking' },
  { topicName: C3, questionText: '3.3 Functions of Banks in India & FDI in Banking Sector', pageNumber: null, tag: 'Banking;FDI' },
  { topicName: C3, questionText: '3.4 Non-Banking Financial Companies (NBFCs) – Definition & Differences from Banks', pageNumber: null, tag: 'NBFC' },
  { topicName: C3, questionText: '3.5 Cooperative Banks – Role in Rural Credit & Major Challenges', pageNumber: null, tag: 'Cooperative Banks' },
  { topicName: C3, questionText: '3.6 Monetary Policy – Objectives & Transmission Challenges', pageNumber: null, tag: 'Monetary Policy' },
  { topicName: C3, questionText: "3.7 RBI's Policy Instruments for Regulating Money Supply & Lender of Last Resort", pageNumber: null, tag: 'RBI;Monetary Policy' },
  { topicName: C3, questionText: "3.8 Sterilization – RBI's Use to Control Money Supply", pageNumber: null, tag: 'Sterilization;RBI' },

  { topicName: C4, questionText: '4.1 Fiscal Policy – Key Components and Main Objectives', pageNumber: null, tag: 'Fiscal Policy' },
  { topicName: C4, questionText: '4.2 Fiscal Policy – Key Objectives & Instruments', pageNumber: null, tag: 'Fiscal Policy' },
  { topicName: C4, questionText: '4.3 Fiscal Policy – Significance in a Developing Economy like India', pageNumber: null, tag: 'Fiscal Policy' },
  { topicName: C4, questionText: '4.4 Public Expenditure – Definition, Objectives & Classification', pageNumber: null, tag: 'Public Expenditure' },
  { topicName: C4, questionText: '4.5 Public Expenditure – Role in Inclusive Growth & Efficiency Measures', pageNumber: null, tag: 'Public Expenditure' },
  { topicName: C4, questionText: '4.6 Outcome Budgeting – Concept, Advantages, and Challenges', pageNumber: null, tag: 'Outcome Budgeting' },
  { topicName: C4, questionText: '4.7 Outcome-Based Budgeting (OBB)', pageNumber: null, tag: 'Outcome Budgeting' },
  { topicName: C4, questionText: '4.8 Off-Budget Financing – Why Governments Resort to It and Its Implications', pageNumber: null, tag: 'Off-Budget Financing' },
  { topicName: C4, questionText: '4.9 Deficit Financing & Instruments of Government Borrowing', pageNumber: null, tag: 'Deficit Financing' },
  { topicName: C4, questionText: '4.10 Fiscal Deficit – Definition & Need to Keep It Under Check', pageNumber: null, tag: 'Fiscal Deficit' },
  { topicName: C4, questionText: '4.11 Debt-to-GDP Ratio as Fiscal Consolidation Target – Rationale & Concerns', pageNumber: null, tag: 'Debt-to-GDP' },
  { topicName: C4, questionText: '4.12 Capital Budget vs Revenue Budget – Differences & Components', pageNumber: null, tag: 'Capital Budget;Revenue Budget' },
  { topicName: C4, questionText: '4.13 Rising Public Debt – Factors & Impact on Fiscal Capacity & Macroeconomic Stability', pageNumber: null, tag: 'Public Debt' },
  { topicName: C4, questionText: '4.14 Gender Budgeting – Challenges in India', pageNumber: null, tag: 'Gender Budgeting' },
  { topicName: C4, questionText: "4.15 Gender Budgeting – Transformative Outcome-Oriented Approach for Women's Empowerment", pageNumber: null, tag: 'Gender Budgeting' },
  { topicName: C4, questionText: '4.16 Gender Budgeting – Limited Impact & Corrective Measures', pageNumber: null, tag: 'Gender Budgeting' },
  { topicName: C4, questionText: '4.17 Union Budget 2025-26 – Measures to Promote and Strengthen MSMEs', pageNumber: null, tag: 'Union Budget;MSME' },

  { topicName: C5, questionText: '5.1 Balance of Payments (BoP) – Definition & Components', pageNumber: null, tag: 'Balance of Payments' },
  { topicName: C5, questionText: '5.2 Balance of Payments (BoP)', pageNumber: null, tag: 'Balance of Payments' },
  { topicName: C5, questionText: "5.3 India's Balance of Payments (BoP) Resilience – Contributing Factors", pageNumber: null, tag: 'Balance of Payments' },
  { topicName: C5, questionText: '5.4 Nominal Exchange Rate (NER) vs Real Exchange Rate (RER)', pageNumber: null, tag: 'Exchange Rate' },
  { topicName: C5, questionText: '5.5 Flexible Exchange Rate – Rupee Appreciation & Depreciation Factors', pageNumber: null, tag: 'Exchange Rate;Rupee' },
  { topicName: C5, questionText: '5.6 Depreciation of Indian Rupee – Implications and Policy Measures', pageNumber: null, tag: 'Rupee Depreciation;Exchange Rate' },

  { topicName: C6, questionText: '6.1 Types of Trade Agreements', pageNumber: null, tag: 'Trade Agreements' },
  { topicName: C6, questionText: '6.2 Economic Reforms of 1991 – Need and Key Objectives', pageNumber: null, tag: 'Economic Reforms 1991' },
  { topicName: C6, questionText: '6.3 Economic Reforms of 1991 & New Economic Policy (NEP)', pageNumber: null, tag: 'Economic Reforms 1991;NEP' },
  { topicName: C6, questionText: '6.4 India\'s Shift from Mixed Economy to Market-Oriented Economy – Last Three Decades', pageNumber: null, tag: 'Mixed Economy;Market Economy' },
  { topicName: C6, questionText: '6.5 Services Sector Growth vs Industrial Sector – Reasons & Importance of Industrial Base', pageNumber: null, tag: 'Services Sector;Industrial Sector' },

  { topicName: C7, questionText: '7.1 Unemployment Measurement in India (PLFS) & Improvements', pageNumber: null, tag: 'PLFS;Unemployment' },
  { topicName: C7, questionText: '7.2 Disguised Unemployment – Challenges & Measures to Improve Employment', pageNumber: null, tag: 'Disguised Unemployment' },
  { topicName: C7, questionText: '7.3 Disguised Unemployment', pageNumber: null, tag: 'Disguised Unemployment' },
  { topicName: C7, questionText: '7.4 Female Labour Force Participation Rate (FLFPR) – Rise & Opportunities', pageNumber: null, tag: 'FLFPR' },
  { topicName: C7, questionText: "7.5 Underutilization of Women's Labour Potential and India's Demographic Dividend", pageNumber: null, tag: 'FLFPR;Demographic Dividend' },
  { topicName: C7, questionText: "7.6 Gig Economy – Meaning and Implications on India's Employment Scenario", pageNumber: null, tag: 'Gig Economy' },
  { topicName: C7, questionText: '7.7 Rise of Gig Economy in India & Issues Faced by Gig Workers', pageNumber: null, tag: 'Gig Economy' },
  { topicName: C7, questionText: '7.8 Four Labour Codes – Merits and Demerits', pageNumber: null, tag: 'Labour Codes' },
  { topicName: C7, questionText: '7.9 Four New Labour Codes – Labour Rights vs Industrial Flexibility', pageNumber: null, tag: 'Labour Codes' },
  { topicName: C7, questionText: '7.10 Employment Linked Incentive (ELI) vs Production Linked Incentive (PLI) Schemes', pageNumber: null, tag: 'ELI;PLI' },
  { topicName: C7, questionText: "7.11 Technological Advancements and Unemployment – Balancing with Job Creation in India", pageNumber: null, tag: 'Automation;Unemployment' },
  { topicName: C7, questionText: '7.12 AI-Driven Productivity & Job Creation – Policy Architecture for Balance', pageNumber: null, tag: 'AI;Job Creation' },

  { topicName: C8, questionText: '8.1 Human Capital – Meaning and Key Sources', pageNumber: null, tag: 'Human Capital' },
  { topicName: C8, questionText: '8.2 Human Capital and Economic Growth – Linkage and Challenges in India', pageNumber: null, tag: 'Human Capital' },
  { topicName: C8, questionText: '8.3 Human Development vs Human Capital – Broader Perspective', pageNumber: null, tag: 'Human Development;Human Capital' },
  { topicName: C8, questionText: '8.4 Physical Capital vs Human Capital – Differences & Role in Economic Growth', pageNumber: null, tag: 'Human Capital;Physical Capital' },
  { topicName: C8, questionText: '8.5 Absolute Poverty vs Relative Poverty & Multidimensional Poverty Index (MPI)', pageNumber: null, tag: 'Poverty;MPI' },
  { topicName: C8, questionText: '8.6 Multidimensional Poverty Index (MPI) as a Comprehensive Measure of Poverty in India', pageNumber: null, tag: 'MPI' },
  { topicName: C8, questionText: '8.7 Economic Growth & Poverty Eradication – Essential but Not Sufficient', pageNumber: null, tag: 'Poverty;Economic Growth' },
  { topicName: C8, questionText: '8.8 Inclusive Growth – Importance and Key Challenges for India', pageNumber: null, tag: 'Inclusive Growth' },
  { topicName: C8, questionText: '8.9 Inclusive Growth – Concept & Government Measures', pageNumber: null, tag: 'Inclusive Growth' },
  { topicName: C8, questionText: '8.10 Inclusive Growth – Challenges Despite Economic Progress & Measures', pageNumber: null, tag: 'Inclusive Growth' },
  { topicName: C8, questionText: '8.11 Indicators and Policy Measures for Inclusive Growth in India', pageNumber: null, tag: 'Inclusive Growth' },
  { topicName: C8, questionText: '8.12 Financial Inclusion in India – Progress & Remaining Challenges', pageNumber: null, tag: 'Financial Inclusion' },

  { topicName: C9, questionText: "9.1 'Missing Middle' Phenomenon in India's Manufacturing Sector", pageNumber: null, tag: 'Missing Middle' },
  { topicName: C9, questionText: "9.2 Industrial Policy Resolution (IPR) 1956 – Influence on India's Industrial Growth", pageNumber: null, tag: 'Industrial Policy;IPR 1956' },
  { topicName: C9, questionText: '9.3 PLI Scheme – Active Industrial Policy & Industrial Competitiveness', pageNumber: null, tag: 'PLI Scheme' },
  { topicName: C9, questionText: "9.4 PLI Scheme – Impact on India's Manufacturing Sector and Export Competitiveness", pageNumber: null, tag: 'PLI Scheme' },
  { topicName: C9, questionText: '9.5 Global Capability Centers (GCCs) – Meaning and Significance for India', pageNumber: null, tag: 'GCC' },
  { topicName: C9, questionText: '9.6 Semiconductor Manufacturing Ecosystem – Challenges & Policy Solutions', pageNumber: null, tag: 'Semiconductor' },
  { topicName: C9, questionText: '9.7 Premature Deindustrialisation in India – Factors, Implications & Revival Measures', pageNumber: null, tag: 'Deindustrialisation' },
  { topicName: C9, questionText: '9.8 Industrial Clusters in India – Structural & Operational Bottlenecks', pageNumber: null, tag: 'Industrial Clusters' },
  { topicName: C9, questionText: '9.9 Industrial Imbalance – Regional Inequality & Balanced Industrialisation Policy', pageNumber: null, tag: 'Industrial Imbalance' },
  { topicName: C9, questionText: "9.10 Manufacturing-Led Development – India's Opportunities Amid Slowbalisation", pageNumber: null, tag: 'Manufacturing;Slowbalisation' },
  { topicName: C9, questionText: '9.11 MSMEs – Challenges & Measures for Strengthening', pageNumber: null, tag: 'MSME' },
  { topicName: C9, questionText: '9.12 Sluggish Private Investment & Impact on GFCF', pageNumber: null, tag: 'Private Investment;GFCF' },

  { topicName: C10, questionText: '10.1 Robust Infrastructure – Economic Transformation and Societal Well-Being', pageNumber: null, tag: 'Infrastructure' },
  { topicName: C10, questionText: '10.2 Infrastructure Development – Key for Economic Growth in India', pageNumber: null, tag: 'Infrastructure' },
  { topicName: C10, questionText: '10.3 Bottlenecks in Infrastructure Development & Key Government Initiatives', pageNumber: null, tag: 'Infrastructure' },
  { topicName: C10, questionText: '10.4 Issues in Infrastructure Financing in India', pageNumber: null, tag: 'Infrastructure Financing' },
  { topicName: C10, questionText: "10.5 PPP Model in India's Infrastructure – Advantages, Disadvantages & Reforms", pageNumber: null, tag: 'PPP' },
  { topicName: C10, questionText: '10.6 Challenges Hindering Effective Implementation of PPP Projects in India', pageNumber: null, tag: 'PPP' },
  { topicName: C10, questionText: '10.7 PPP Model in Development of Ports in India – Role, Drawbacks, and Reforms', pageNumber: null, tag: 'PPP;Ports' },
  { topicName: C10, questionText: '10.8 Viability Gap Funding (VGF) – Balancing Commercial & Social Objectives', pageNumber: null, tag: 'VGF' },
  { topicName: C10, questionText: '10.9 Hybrid Annuity Model (HAM) – Pragmatic Approach for Infrastructure Development', pageNumber: null, tag: 'HAM' },
  { topicName: C10, questionText: '10.10 InvITs & REITs – Reducing Banking Pressure & Deepening Capital Markets', pageNumber: null, tag: 'InvITs;REITs' },
  { topicName: C10, questionText: '10.11 Dedicated Freight Corridor (DFC) – Logistics, Infrastructure & Economic Growth', pageNumber: null, tag: 'DFC' },
  { topicName: C10, questionText: '10.12 Indian Railways – Challenges & Measures', pageNumber: null, tag: 'Railways' },
  { topicName: C10, questionText: '10.13 Rapid Rail Transit System (RRTS) – Regional Connectivity and Sustainable Urban Transport', pageNumber: null, tag: 'RRTS' },
  { topicName: C10, questionText: "10.14 Port-Led Development – Transforming India's Infrastructure Landscape", pageNumber: null, tag: 'Ports' },
  { topicName: C10, questionText: '10.15 UDAN Scheme – Need for Regional Air Connectivity & Achievements', pageNumber: null, tag: 'UDAN' },
  { topicName: C10, questionText: '10.16 Renewable Energy – Energy Security, Atmanirbhar India, and Steps to Boost the Sector', pageNumber: null, tag: 'Renewable Energy' },
  { topicName: C10, questionText: '10.17 Digital Public Infrastructure (DPI) – Climate Change Mitigation & Adaptation', pageNumber: null, tag: 'DPI' },
  { topicName: C10, questionText: '10.18 Flight Duty Time Limitations (FDTL) Rules – Features & Impact on Aviation', pageNumber: null, tag: 'FDTL;Aviation' },
  { topicName: C10, questionText: '10.19 National Mission for Urban Roads – Necessity (Pradhan Mantri Shahari Sadak Yojana)', pageNumber: null, tag: 'Urban Roads;PM Shahari Sadak Yojana' },
  { topicName: C10, questionText: "10.20 India's Logistics Performance – Infrastructure & Governance Challenge", pageNumber: null, tag: 'Logistics' },
  { topicName: C10, questionText: '10.21 Household Energy Access in India – Key Barriers & Government Measures', pageNumber: null, tag: 'Household Energy Access' },

  { topicName: C11, questionText: '11.1 Green Revolution – Limited Regional Impact & Effect on Small Farmers', pageNumber: null, tag: 'Green Revolution' },
  { topicName: C11, questionText: '11.2 Green Revolution – Impact, Achievements, and Limitations', pageNumber: null, tag: 'Green Revolution' },
  { topicName: C11, questionText: '11.3 Land Reforms After Independence – Achievements & Failures', pageNumber: null, tag: 'Land Reforms' },
  { topicName: C11, questionText: '11.4 Land Pooling – Concept, Benefits & Challenges', pageNumber: null, tag: 'Land Pooling' },
  { topicName: C11, questionText: '11.5 Digitization of Land Records – Positives & Challenges', pageNumber: null, tag: 'Land Records' },
  { topicName: C11, questionText: '11.6 Minimum Support Price (MSP) – Advantages and Limitations', pageNumber: null, tag: 'MSP' },
  { topicName: C11, questionText: '11.7 Major Causes of Agrarian Distress in India & Measures for Sustainable Agricultural Growth', pageNumber: null, tag: 'Agrarian Distress' },
  { topicName: C11, questionText: '11.8 Reasons for Low Agricultural Productivity in India & Measures to Enhance It', pageNumber: null, tag: 'Agricultural Productivity' },
  { topicName: C11, questionText: "11.9 Role of Food Processing Sector in Strengthening India's Agricultural Sector", pageNumber: null, tag: 'Food Processing' },
  { topicName: C11, questionText: '11.10 Key Regions for Food Processing & Making India a Global Export Hub', pageNumber: null, tag: 'Food Processing' },
  { topicName: C11, questionText: '11.11 Mission Aatmanirbharta in Pulses – Significance & Risks', pageNumber: null, tag: 'Pulses;Aatmanirbharta' },
  { topicName: C11, questionText: "11.12 India's Share in Global Processed Food Trade – Reasons for Low Performance", pageNumber: null, tag: 'Food Processing;Processed Food Trade' },
  { topicName: C11, questionText: '11.13 Challenges for Small & Marginal Farmers in Adopting E-Technology', pageNumber: null, tag: 'E-Technology;Small Farmers' },
  { topicName: C11, questionText: '11.14 WTO Agreement on Fisheries Subsidies (2022) – Implications for India', pageNumber: null, tag: 'Fisheries Subsidies;WTO' },
  { topicName: C11, questionText: '11.15 PMFME Scheme – Role in Strengthening Micro Food Processing Enterprises', pageNumber: null, tag: 'PMFME' },
  { topicName: C11, questionText: '11.16 Food Processing Sector – Strengthening Nutrition Outcomes & Food Security', pageNumber: null, tag: 'Food Processing;Food Security' },
  { topicName: C11, questionText: "11.17 AgriStack – Boosting Farm Productivity, Service Delivery & Farmers' Incomes", pageNumber: null, tag: 'AgriStack' },
  { topicName: C11, questionText: '11.18 Land Reforms in India – Failures & Land Reforms 2.0 Agenda', pageNumber: null, tag: 'Land Reforms' },
  { topicName: C11, questionText: '11.19 Agricultural Subsidies in India – Nature & Distortionary Impact', pageNumber: null, tag: 'Agricultural Subsidies' },
  { topicName: C11, questionText: "11.20 Transportation's Role Across India's Agricultural Value Chain", pageNumber: null, tag: 'Agricultural Value Chain' },
  { topicName: C11, questionText: "11.21 India's Food Grain Stocking Policy – Impact on Efficiency, Exports & Private Trade", pageNumber: null, tag: 'Food Grain Stocking;Buffer Stock' },
  { topicName: C11, questionText: '11.22 Land Reforms as Structural Intervention for Rural Transformation', pageNumber: null, tag: 'Land Reforms' },
  { topicName: C11, questionText: '11.23 Livestock Sector – Empowering Women & Marginal Farmers: Challenges & Measures', pageNumber: null, tag: 'Livestock' },
  { topicName: C11, questionText: '11.24 Direct Income Support vs MSP – More Effective for Farmer Welfare?', pageNumber: null, tag: 'MSP;Direct Income Support' },
  { topicName: C11, questionText: '11.25 Crop Diversification in India – Challenges & Government Steps', pageNumber: null, tag: 'Crop Diversification' },
  { topicName: C11, questionText: '11.26 National Mission on High Yielding Seeds – Objectives, Implications & Policy Measures', pageNumber: null, tag: 'High Yielding Seeds' },
  { topicName: C11, questionText: '11.27 Digital Initiatives & PDS – Transformation & Challenges', pageNumber: null, tag: 'PDS;Digital Initiatives' }
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

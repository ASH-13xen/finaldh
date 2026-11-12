// The student-facing chapters of the Economy Master File: the 15 chapters of the Economy syllabus
// (UPSC_Prelims_Economy_Chapters.docx). Keys are the same slugs utils/syllabusDocx.js makes from the
// chapter titles, so a topic's themeKey and a question's syllabusTag.chapter name the same chapter.
//
// The PDF's three parts (Forum, Part B, Vision) each have their own headings, so a topic is placed by
// its title first (TITLE_RULES) and otherwise by the heading it sat under (HEADING_RULES). The heading
// stays on the topic as `sourceTheme`. An admin can move a topic from Economy Data → Topics.

export const ECONOMY_THEMES = [
  { key: 'basic-concepts-of-economics', title: 'Basic Concepts of Economics', order: 1 },
  { key: 'national-income-accounting', title: 'National Income Accounting', order: 2 },
  { key: 'growth-development-and-welfare', title: 'Growth, Development and Welfare', order: 3 },
  { key: 'planning-in-india', title: 'Planning in India', order: 4 },
  { key: 'money-and-banking', title: 'Money and Banking', order: 5 },
  { key: 'inflation', title: 'Inflation', order: 6 },
  { key: 'financial-markets', title: 'Financial Markets', order: 7 },
  { key: 'public-finance-and-fiscal-policy', title: 'Public Finance and Fiscal Policy', order: 8 },
  { key: 'taxation', title: 'Taxation', order: 9 },
  { key: 'external-sector', title: 'External Sector', order: 10 },
  { key: 'international-economic-organisations', title: 'International Economic Organisations', order: 11 },
  { key: 'agriculture', title: 'Agriculture', order: 12 },
  { key: 'industry-and-infrastructure', title: 'Industry and Infrastructure', order: 13 },
  { key: 'poverty-unemployment-and-inclusive-growth', title: 'Poverty, Unemployment and Inclusive Growth', order: 14 },
  { key: 'economic-survey-budget-and-current-schemes', title: 'Economic Survey, Budget and Current Schemes', order: 15 },
];

const [BASICS, INCOME, GROWTH, PLANNING, BANKING, INFLATION, MARKETS, PUBLIC_FINANCE, TAXATION, EXTERNAL, ORGS, AGRI, INDUSTRY, POVERTY, CURRENT] =
  ECONOMY_THEMES.map((t) => t.key);

// First match wins. A title is placed by what the syllabus says about it, whichever part it came from.
const TITLE_RULES = [
  [/five.?year plan|planning commission|mahalanobis|rolling plan|independence planning|niti aayog initiatives/i, PLANNING],
  [/union budget 20\d\d/i, CURRENT],
  [/human development|\bhdi\b|multidimensional poverty|\bmpi\b|\bgini\b|lorenz|hunger index|happiness|sustainable development goals|development vs economic growth|green gdp/i, GROWTH],
  [/employees. state insurance/i, POVERTY],
  [/automatic stabili[sz]ers/i, PUBLIC_FINANCE],
  [/product taxes/i, INCOME],
  [/inflation.indexed/i, MARKETS],
  [/inflation targeting/i, BANKING],
  [/phillips curve|nairu/i, INFLATION],
  [/money market|capital market|\bbonds?\b|bond market|t-bills|commercial paper|certificate of deposit|futures|options?\b|derivative|\breits?\b|real estate investment|invits?|infrastructure investment trust|exchange traded|\betfs?\b|alternative investment|\baifs?\b|\bsebi\b|sensex|primary market|bear market|participatory notes|kerb trading|angel funds|margin trading|fccb|credit rating|insurance|bancassurance|pfrda|pension fund|pension scheme|atal pension/i, MARKETS],
  [/\bimf\b|ime instruments|world bank|\bwto\b|\btrips\b|\btrims\b|trade.related investment|special drawing|\bsdrs?\b|new development bank|\bndb\b|\baiib\b|asian infrastructure investment|\badb\b|\boecd\b|\bg-?20\b|international bank for reconstruction|international finance corporation|bretton woods|paris club|gold tranche|compulsory licensing|global economic reports|global reports|economic groupings/i, ORGS],
  [/basel|unified payments|\bupi\b/i, BANKING],
  [/financial inclusion/i, POVERTY],
  [/disinvestment|new economic policy|\bmsmes?\b|public.private partnership|\bppp & models|tex-ramps|ramp \(|bharatmala|national steel policy|data centre|viability gap|\bvgf\b|missing middle|csr applicability|jalvahak|startups?\b/i, INDUSTRY],
  [/special economic zone|\bsez\b|export/i, EXTERNAL],
  [/\btax(es|ation)?\b|\bgst\b|excise|custom duties|\bcess\b/i, TAXATION],
  [/frbm|fiscal responsibility|public debt/i, PUBLIC_FINANCE],
  [/circular flow/i, INCOME],
  [/food security|\bnfsa\b|\btpds\b|farm loan/i, AGRI],
  [/mnrega|mgnrega|pm-?\s?sym|shram|career service|\bncs\b|skill development|self-help|code on wages|fixed-term|employees. state insurance|svanidhi/i, POVERTY],
  [/mixed economy|pareto|public goods|veblen|normal goods|types of goods|marginal utility|factors of production/i, BASICS],
  [/personal income|private income/i, INCOME],
  [/^service sector/i, INDUSTRY],
];

// The part's own heading, for every topic no title rule placed.
const HEADING_RULES = [
  [/global financial/i, ORGS],
  [/money market|capital market|insurance/i, MARKETS],
  [/monetary|banking/i, BANKING],
  [/fiscal/i, PUBLIC_FINANCE],
  [/tax/i, TAXATION],
  [/national income/i, INCOME],
  [/inflation/i, INFLATION],
  [/external/i, EXTERNAL],
  [/agri|primary sector/i, AGRI],
  [/manufactur|secondary|energy|infrastructure|investment model|service/i, INDUSTRY],
  [/micro/i, BASICS],
  [/human|unemployment|matter of choice|ma\s*er of choice/i, POVERTY],
  [/scheme|programme|program/i, CURRENT],
];

/** The chapter for a heading of the PDF, or null. */
export const canonicalTheme = (heading) => {
  if (!heading) return null;
  const hit = HEADING_RULES.find(([re]) => re.test(heading));
  return hit ? hit[1] : null;
};

/** The chapter for one Master File topic, or null if neither its title nor its heading tells. */
export const chapterForTopic = ({ title, sourceTheme }) => {
  const hit = TITLE_RULES.find(([re]) => re.test(title || ''));
  return hit ? hit[1] : canonicalTheme(sourceTheme);
};

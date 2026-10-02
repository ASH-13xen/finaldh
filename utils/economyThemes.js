// The student-facing themes of the Economy Master File, and how each part's own theme
// headings map onto them. The PDF's three parts (Forum, Part B, Vision) cut the syllabus a
// little differently — Vision has e.g. "Money Market and Capital Market" and "Energy Sector" —
// so topics are grouped under one canonical theme and keep their original heading as
// `sourceTheme`.

export const ECONOMY_THEMES = [
  { key: 'monetary-policy', title: 'Monetary Policy & Banking', order: 1 },
  { key: 'fiscal-policy', title: 'Fiscal Policy', order: 2 },
  { key: 'taxation', title: 'Taxation', order: 3 },
  { key: 'national-income', title: 'National Income Accounting', order: 4 },
  { key: 'inflation', title: 'Inflation', order: 5 },
  { key: 'external-sector', title: 'External Sector', order: 6 },
  { key: 'agriculture', title: 'Agriculture', order: 7 },
  { key: 'industry-infra', title: 'Manufacturing & Infrastructure', order: 8 },
  { key: 'services', title: 'Service Sector', order: 9 },
  { key: 'micro-economics', title: 'Micro-economics', order: 10 },
  { key: 'human-resource', title: 'Human Resource Development', order: 11 },
  { key: 'govt-schemes', title: 'Government Schemes', order: 12 },
];

// First match wins; tested against the heading text after "THEME -".
const RULES = [
  [/money market|capital market|insurance/i, 'monetary-policy'],
  [/monetary|banking/i, 'monetary-policy'],
  [/fiscal/i, 'fiscal-policy'],
  [/tax/i, 'taxation'],
  [/national income/i, 'national-income'],
  [/inflation/i, 'inflation'],
  [/external|global financial/i, 'external-sector'],
  [/agri|primary sector/i, 'agriculture'],
  [/manufactur|secondary|energy|infrastructure|investment model/i, 'industry-infra'],
  [/service/i, 'services'],
  [/micro/i, 'micro-economics'],
  [/human|unemployment|matter of choice|ma\s*er of choice/i, 'human-resource'],
  [/scheme|programme|program/i, 'govt-schemes'],
];

export const canonicalTheme = (heading) => {
  if (!heading) return null;
  const hit = RULES.find(([re]) => re.test(heading));
  return hit ? hit[1] : null;
};

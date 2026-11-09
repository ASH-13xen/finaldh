// Text helpers shared by the transcript pipeline and the runtime search: tokenising, canonical names for
// states / optional subjects / boards, and light clean-up of the community-typed transcript text.

const STOPWORDS = new Set(`
a about above according actually after again against ago all also am an and any anything are aren around as ask asked
asking at away be because been before being below between both but by can cannot could did didn do does doesn doing don
done down during each either else even ever every few for from further get gets getting give given go going got had has
have having he her here hers him his how however i if in into is isn it its itself just kind know known let lets like ll
made make many may me might mine more most much must my myself no nor not now of off on once one only or other our ours
out over own please put quite rather re really s said same say says see seem seems shall she should so some something
such sure t tell than that the their theirs them then there these they thing things think this those though through thus
to too toward towards under until up upon us use used very want was wasn way we well were what whats when where whether
which while who whom whose why will with within without would yes yet you your yours yourself ve d m o y sir mam maam
madam ma am ji okay ok also asked question questions regarding related regards explain describe discuss elaborate briefly
tell told view views opinion take stand perspective
`.split(/\s+/).filter(Boolean));

export const isStopword = (w) => STOPWORDS.has(w);

// "Kabbadi" and "kabaddi" are the same hobby; the left side is matched after lowercasing and stripping
// punctuation. Extend as the admin review turns up more variants.
const WORD_ALIASES = {
  kabbadi: 'kabaddi', kabadi: 'kabaddi', kabbaddi: 'kabaddi',
  footbal: 'football', vollyball: 'volleyball', volley: 'volleyball',
  badmintion: 'badminton', baddminton: 'badminton',
  ai: 'artificial intelligence', ml: 'machine learning',
  govt: 'government', gov: 'government', govts: 'government',
  dm: 'district magistrate', sp: 'superintendent of police',
  pm: 'prime minister', cm: 'chief minister',
  sc: 'supreme court', hc: 'high court',
  america: 'usa', uk: 'united kingdom', britain: 'united kingdom',
  programme: 'program', programmes: 'program', organisation: 'organization', organisations: 'organization',
  centre: 'center', defence: 'defense', labour: 'labor', colour: 'color', behaviour: 'behavior'
};

// Very light stemming, enough for "farmers"/"farmer" and "policies"/"policy" to meet.
const stem = (w) => {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
};

export const normalizeText = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Content tokens: lowercased, aliased, stemmed, stopwords and 1-letter tokens removed.
export const tokenize = (s) => {
  const out = [];
  for (const raw of normalizeText(s).split(' ')) {
    if (!raw) continue;
    const aliased = WORD_ALIASES[raw] || raw;
    for (const part of aliased.split(' ')) {
      if (part.length < 2 || STOPWORDS.has(part)) continue;
      if (/^\d+$/.test(part) && !/^(19|20)\d\d$/.test(part)) continue; // keep years, drop list numbers
      out.push(stem(part));
    }
  }
  return out;
};

// ------------------------------------------------------------------ states & places

export const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Puducherry', 'Chandigarh', 'Andaman and Nicobar Islands', 'Lakshadweep', 'Dadra and Nagar Haveli and Daman and Diu'
];

// Spellings and abbreviations seen in the transcripts. Upper-case-only abbreviations ("UP", "MP") are
// matched case-sensitively in stateMentions() so the English words "up" / "mp3" don't count.
const STATE_ALIASES = {
  'orissa': 'Odisha', 'tamilnadu': 'Tamil Nadu', 'tamil nadu': 'Tamil Nadu', 'uttaranchal': 'Uttarakhand',
  'uttarkhand': 'Uttarakhand', 'chattisgarh': 'Chhattisgarh', 'chhatisgarh': 'Chhattisgarh', 'chhattisgarh': 'Chhattisgarh',
  'jammu kashmir': 'Jammu and Kashmir', 'jammu and kashmir': 'Jammu and Kashmir', 'kashmir': 'Jammu and Kashmir',
  'pondicherry': 'Puducherry', 'new delhi': 'Delhi', 'ncr': 'Delhi', 'bengal': 'West Bengal', 'telengana': 'Telangana',
  'maharastra': 'Maharashtra', 'karnatak': 'Karnataka', 'rajastan': 'Rajasthan', 'jharkhnad': 'Jharkhand',
  'himachal': 'Himachal Pradesh', 'andhra': 'Andhra Pradesh', 'arunachal': 'Arunachal Pradesh', 'madhya pradesh': 'Madhya Pradesh',
  'andaman': 'Andaman and Nicobar Islands'
};
const STATE_ABBREVIATIONS = {
  UP: 'Uttar Pradesh', MP: 'Madhya Pradesh', HP: 'Himachal Pradesh', AP: 'Andhra Pradesh', WB: 'West Bengal',
  TN: 'Tamil Nadu', 'J&K': 'Jammu and Kashmir', JK: 'Jammu and Kashmir', UK: 'Uttarakhand', CG: 'Chhattisgarh'
};

// A few big cities whose state is obvious, so "Meerut, IIT Bombay" still yields a home state.
export const CITY_STATE = {
  mumbai: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', nashik: 'Maharashtra', aurangabad: 'Maharashtra',
  kolkata: 'West Bengal', chennai: 'Tamil Nadu', madurai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', bangalore: 'Karnataka',
  bengaluru: 'Karnataka', mysore: 'Karnataka', mysuru: 'Karnataka', hyderabad: 'Telangana', warangal: 'Telangana',
  lucknow: 'Uttar Pradesh', kanpur: 'Uttar Pradesh', meerut: 'Uttar Pradesh', varanasi: 'Uttar Pradesh', prayagraj: 'Uttar Pradesh',
  allahabad: 'Uttar Pradesh', agra: 'Uttar Pradesh', gorakhpur: 'Uttar Pradesh', noida: 'Uttar Pradesh', ghaziabad: 'Uttar Pradesh',
  patna: 'Bihar', gaya: 'Bihar', muzaffarpur: 'Bihar', bhagalpur: 'Bihar', darbhanga: 'Bihar', ranchi: 'Jharkhand',
  jamshedpur: 'Jharkhand', dhanbad: 'Jharkhand', bhopal: 'Madhya Pradesh', indore: 'Madhya Pradesh', gwalior: 'Madhya Pradesh',
  jabalpur: 'Madhya Pradesh', jaipur: 'Rajasthan', jodhpur: 'Rajasthan', udaipur: 'Rajasthan', kota: 'Rajasthan',
  jhunjhunu: 'Rajasthan', bikaner: 'Rajasthan', ajmer: 'Rajasthan', ahmedabad: 'Gujarat', surat: 'Gujarat', vadodara: 'Gujarat',
  rajkot: 'Gujarat', chandigarh: 'Chandigarh', ludhiana: 'Punjab', amritsar: 'Punjab', jalandhar: 'Punjab', patiala: 'Punjab',
  gurgaon: 'Haryana', gurugram: 'Haryana', rohtak: 'Haryana', hisar: 'Haryana', panipat: 'Haryana', dehradun: 'Uttarakhand',
  haridwar: 'Uttarakhand', shimla: 'Himachal Pradesh', srinagar: 'Jammu and Kashmir', jammu: 'Jammu and Kashmir',
  bhubaneswar: 'Odisha', cuttack: 'Odisha', guwahati: 'Assam', raipur: 'Chhattisgarh', bilaspur: 'Chhattisgarh',
  thiruvananthapuram: 'Kerala', trivandrum: 'Kerala', kochi: 'Kerala', kozhikode: 'Kerala', vijayawada: 'Andhra Pradesh',
  visakhapatnam: 'Andhra Pradesh', vizag: 'Andhra Pradesh', guntur: 'Andhra Pradesh', tirupati: 'Andhra Pradesh',
  imphal: 'Manipur', shillong: 'Meghalaya', aizawl: 'Mizoram', kohima: 'Nagaland', agartala: 'Tripura', gangtok: 'Sikkim',
  panaji: 'Goa', leh: 'Ladakh'
};

const STATE_BY_LOWER = new Map(STATES.map((s) => [s.toLowerCase(), s]));

export const canonicalState = (s) => {
  const raw = String(s || '').trim();
  if (!raw) return '';
  if (STATE_ABBREVIATIONS[raw.toUpperCase()] && raw.length <= 3) return STATE_ABBREVIATIONS[raw.toUpperCase()];
  const k = normalizeText(raw);
  return STATE_BY_LOWER.get(k) || STATE_ALIASES[k] || CITY_STATE[k] || '';
};

// Every state named (or implied by a well-known city) anywhere in a piece of profile text.
export const stateMentions = (text) => {
  const found = new Set();
  const src = String(text || '');
  const norm = ` ${normalizeText(src)} `;
  for (const [lower, state] of STATE_BY_LOWER) if (norm.includes(` ${lower} `)) found.add(state);
  for (const [alias, state] of Object.entries(STATE_ALIASES)) if (norm.includes(` ${alias} `)) found.add(state);
  for (const [abbr, state] of Object.entries(STATE_ABBREVIATIONS)) {
    if (new RegExp(`(^|[^A-Za-z&])${abbr.replace('&', '&')}([^A-Za-z&]|$)`).test(src)) found.add(state);
  }
  if (!found.size) for (const [city, state] of Object.entries(CITY_STATE)) if (norm.includes(` ${city} `)) found.add(state);
  return [...found];
};

// ------------------------------------------------------------------ optional subjects

export const OPTIONALS = [
  'PSIR', 'Sociology', 'Anthropology', 'Geography', 'Public Administration', 'History', 'Philosophy', 'Psychology',
  'Economics', 'Law', 'Mathematics', 'Physics', 'Chemistry', 'Botany', 'Zoology', 'Geology', 'Statistics', 'Agriculture',
  'Animal Husbandry and Veterinary Science', 'Medical Science', 'Management', 'Commerce and Accountancy',
  'Civil Engineering', 'Mechanical Engineering', 'Electrical Engineering', 'Literature'
];

const OPTIONAL_PATTERNS = [
  [/psir|political science|pol\.? ?sci|\bpsc\b/i, 'PSIR'],
  [/socio/i, 'Sociology'],
  [/anthro/i, 'Anthropology'],
  [/geog|\bgeo\b/i, 'Geography'],
  [/pub(lic)?\.? ?ad|\bpa\b/i, 'Public Administration'],
  [/philos/i, 'Philosophy'],
  [/psycho/i, 'Psychology'],
  [/econ/i, 'Economics'],
  [/\blaw\b/i, 'Law'],
  [/math/i, 'Mathematics'],
  [/physics/i, 'Physics'],
  [/chem/i, 'Chemistry'],
  [/botany/i, 'Botany'],
  [/zoology/i, 'Zoology'],
  [/geology/i, 'Geology'],
  [/statis/i, 'Statistics'],
  [/agri/i, 'Agriculture'],
  [/veterin|animal husb/i, 'Animal Husbandry and Veterinary Science'],
  [/medical|medicine/i, 'Medical Science'],
  [/management/i, 'Management'],
  [/commerce|accountancy/i, 'Commerce and Accountancy'],
  [/civil eng/i, 'Civil Engineering'],
  [/mech(anical)? eng/i, 'Mechanical Engineering'],
  [/electrical eng/i, 'Electrical Engineering'],
  [/literature|\blit\b|hindi|telugu|tamil|malayalam|kannada|marathi|bengali|odia|gujarati|punjabi|urdu|sanskrit|maithili/i, 'Literature'],
  [/history/i, 'History']
];

export const canonicalOptional = (s) => {
  const raw = String(s || '').trim();
  if (!raw) return '';
  for (const [re, name] of OPTIONAL_PATTERNS) if (re.test(raw)) return name;
  return '';
};

// ------------------------------------------------------------------ boards

const HONORIFICS = /\b(shri|shree|sh|smt|sri|dr|prof|professor|mr|mrs|ms|miss|lt|gen|general|lieutenant|air|marshal|marshall|vice|admiral|retd|hon|honble|hble|honorable|honourable|respected|sir|sirs|mam|maam|maa|madam|mme|ma|am|ji|boss|board|panel|chairman|chairperson|chairwoman|cp|member|interview|session|the|of|s|ifs|ias|ips)\b\.?/gi;

// Words that show the "board" line was a comment about the board, not its name ("Board was cordial").
const NOT_A_NAME = /\b(was|were|is|very|cordial|friendly|polite|nice|good|mocks?|attentive|grill\w*|expression\w*|women|woman|unknown|members|leaving|stress\w*|cool|calm|helpful|chill|strict|tough|positive|supportive|smiling)\b/i;

// The chairpersons named in the 2020-2024 compilations. `keys` are letters-only spellings; a board name
// matches a key within a small edit distance, so "Sheelavardhan", "Sanjay Verms" and "Smitha Nagraj"
// all land on the right person.
const BOARDS = [
  ['Dinesh Dasa', ['dineshdasa', 'dasa', 'dassa']],
  ['Sanjay Verma', ['sanjayverma', 'verma']],
  ['Manoj Soni', ['manojsoni', 'soni']],
  ['Suman Sharma', ['sumansharma', 'suman']],
  ['B.B. Swain', ['bbswain', 'swain', 'bidyutbehariswain']],
  ['Sheel Vardhan Singh', ['sheelvardhansingh', 'sheelvardhan', 'sheel']],
  ['Preeti Sudan', ['preetisudan', 'sudan', 'preeti']],
  ['Raj Shukla', ['rajshukla', 'shukla']],
  ['R.N. Choubey', ['rnchoubey', 'choubey', 'chaubey', 'chaubeyji', 'rajivnayanchoubey', 'rajivnayanchaubey']],
  ['Smita Nagaraj', ['smitanagaraj', 'nagaraj', 'smita']],
  ['M. Sathiyavathy', ['msathiyavathy', 'sathiyavathy', 'satyavati', 'sathyavathi', 'satyavathi', 'sathyawathi']],
  ['T.C.A. Anant', ['tcaanant', 'anant', 'tcanant']],
  ['Sujata Mehta', ['sujatamehta', 'sujata']],
  ['B.B. Vyas', ['bbvyas', 'vyas', 'bharatbhushanvyas']],
  ['Ajit Bhonsle', ['ajitbhonsle', 'bhonsle', 'abhonsle']],
  ['P.K. Joshi', ['pkjoshi', 'pradeepkumarjoshi', 'joshi']]
];

export const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
};

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

// "Shri BB Swain Sir" / "Hon'ble Sheelvardhan" / "B B Swain sir board" -> "B.B. Swain". Returns '' when
// nothing name-like is left ("Board:", "Board was very cordial"). Names outside BOARDS are dropped unless
// allowUnknown is set (the Gemini parser's cleaned names are trusted; the keyword parser's are not).
export const canonicalBoard = (raw, { allowUnknown = false } = {}) => {
  const first = String(raw || '')
    .replace(/\(.*?\)/g, ' ')
    .split(/[,;|]|\s[-–]\s|\bforenoon\b|\bafternoon\b|\bfn\b|\ban\b|\bmorning\b|\bevening\b|\d/i)[0];
  if (NOT_A_NAME.test(first)) return '';
  const s = first
    .replace(/[*_"“”]/g, ' ')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z. ]+/g, ' ')
    .replace(/\./g, ' ')
    .replace(HONORIFICS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!s || s.replace(/ /g, '').length < 3) return '';
  const compact = s.replace(/ /g, '');
  let best = null;
  for (const [name, keys] of BOARDS) {
    for (const key of keys) {
      const allowed = key.length >= 9 ? 2 : key.length >= 5 ? 1 : 0;
      const d = levenshtein(compact, key);
      if (d <= allowed && (!best || d < best.d)) best = { name, d };
    }
  }
  if (best) return best.name;
  // A surname inside a longer string ("dinesh dasa uncle") still counts when it's distinctive.
  for (const [name, keys] of BOARDS) {
    if (keys.some((k) => k.length >= 6 && compact.includes(k))) return name;
  }
  if (!allowUnknown || s.split(' ').length > 4) return '';
  return titleCase(s);
};

// ------------------------------------------------------------------ misc

export const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s || ''));

export const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// Comma / slash / semicolon separated profile values -> trimmed list.
export const splitList = (s) =>
  uniq(String(s || '')
    .split(/[,;/|•]|\s+and\s+|\s+&\s+/i)
    .map((x) => x.replace(/^[\s\-–:.]+|[\s\-–:.]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 2 && x.length <= 80));

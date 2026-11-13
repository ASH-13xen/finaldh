// How interview questions are tagged. The Gemini parser is asked to answer in these same vocabularies,
// and the keyword rules below are the no-AI fallback (and a cross-check) for the same fields.
import { normalizeText, tokenize, isStopword, canonicalOptional, canonicalState, stateMentions, uniq } from './text.js';

// ------------------------------------------------------------------ topics

export const TOPICS = [
  { id: 'polity', label: 'Polity & Governance', words: 'constitution constitutional parliament parliamentary judiciary judicial supreme court high court article amendment fundamental right fundamental duties dpsp directive principle federalism federal governor president vice president election electoral election commission panchayat municipal local self government bureaucracy bureaucrat civil servant civil service governance rti lokpal lokayukta cag ordinance reservation citizenship democracy preamble schedule collegium tribunal police reform e governance accountability transparency corruption legislature legislative bill act law upsc anti defection one nation one election ucc uniform civil code delimitation cabinet minister ministry policy policies reform reforms administration administrative collector district magistrate officer officers judge judges court police rajya sabha lok sabha mla governor speaker niti aayog aadhaar pil sedition uapa ipc crpc freebies welfare state cooperative federalism centre state relation' },
  { id: 'ir', label: 'International Relations', words: 'china chinese pakistan usa russia russian ukraine israel palestine hamas gaza iran afghanistan taliban bangladesh sri lanka srilanka nepal bhutan maldives myanmar japan quad g20 g7 brics sco saarc bimstec asean united nations unsc wto imf world bank nato foreign policy diplomacy diplomatic bilateral neighbour neighbor neighbourhood global south indo pacific canada europe european union africa middle east gulf west asia treaty visa diaspora united kingdom france germany australia korea taiwan trump biden geopolitics geopolitical sanction dedollarization international' },
  { id: 'economy', label: 'Economy', words: 'economy economic gdp inflation budget fiscal monetary rbi reserve bank bank banking npa tax gst income tax investment fdi startup msme industry industrial manufacturing make in india export import trade deficit subsidy privatization privatisation disinvestment stock market sebi upi digital payment crypto cryptocurrency currency rupee dollar unemployment employment poverty growth infrastructure ease of doing business insurance pension ppp psu finance financial loan credit interest rate recession capital market economist price prices company companies business wealth income salary gig cost revenue gold oil fuel petrol diesel electricity discom tourism logistics railway railways bullet train airport port highway smart city housing mgnrega skill skilling labour labor job jobs market economy money investor' },
  { id: 'scitech', label: 'Science & Technology', words: 'technology tech science scientific artificial intelligence machine learning chatgpt llm semiconductor chip space isro chandrayaan aditya gaganyaan satellite nuclear quantum 5g 6g internet cyber data blockchain robot robotics drone biotechnology gene genetic crispr vaccine electric vehicle ev battery digital software computer app social media deepfake telecom spectrum algorithm coding programming hardware innovation research iot cloud metaverse ai ml gps mobile phone smartphone engine physics chemistry biology disease virus telemedicine engineering hacking automation electronics' },
  { id: 'environment', label: 'Environment & Geography', words: 'environment environmental climate change global warming carbon emission net zero cop renewable solar wind energy hydrogen pollution air quality plastic waste forest wildlife tiger elephant biodiversity wetland river water groundwater flood drought cyclone earthquake disaster landslide glacier himalaya ganga monsoon sustainable sustainability sdg ecology ecosystem mangrove coral ozone geography mountain plateau soil mineral ocean island desert coast coastal delta lake dam green heat heatwave temperature weather rain rainfall sea tree trees animal animals national park sanctuary species environmentalist' },
  { id: 'history', label: 'History & Culture', words: 'history historical ancient medieval mughal maratha shivaji ashoka gupta maurya harappa indus valley vedic freedom struggle independence gandhi nehru ambedkar patel subhas bose bhagat singh tilak colonial british raj partition 1857 temple monument architecture heritage unesco culture cultural festival art painting folk tradition literature poet ramayana mahabharat mahabharata purana veda upanishad buddhism buddha jainism sufi bhakti classical language dynasty empire king kingdom fort museum freedom fighter movement revolt mythology god goddess saint philosopher novel author writer script dance music famous gi tag' },
  { id: 'society', label: 'Society & Social Justice', words: 'society social caste women woman gender girl child children education school nep new education policy university student health healthcare hospital ayushman malnutrition population migration migrant urbanization urbanisation tribal tribe dalit minority religion religious secularism lgbtq same sex marriage dowry family youth elderly disability ngo civil society hunger ration pds welfare scheme mental health drug addiction alcohol suicide inequality discrimination dignity people community communities senior citizen widow slum hygiene sanitation toilet swachh nutrition obesity doctor doctors medical medicine teacher teachers coaching exam exams learning literacy digital divide' },
  { id: 'security', label: 'Internal Security & Defence', words: 'security army military defense armed force agniveer agnipath border terrorism terrorist terror naxal naxalism maoist insurgency militancy navy air force missile weapon police internal security cyber security intelligence afspa lac loc surgical strike soldier war conflict paramilitary crpf bsf' },
  { id: 'ethics', label: 'Ethics & Situational', words: 'ethics ethical integrity honesty value values moral morality conscience dilemma emotional intelligence empathy compassion leadership attitude talisman lie bribe pressure politician political pressure whistleblower probity' },
  { id: 'agriculture', label: 'Agriculture & Rural', words: 'agriculture agricultural farmer farmers farming crop msp irrigation fertilizer fertiliser organic farming natural farming stubble paddy rice wheat sugarcane rural village dairy fisheries fishery food processing apmc farm law land reform cooperative horticulture millet millets food security' },
  { id: 'sports', label: 'Sports', words: 'sport sports cricket football hockey kabaddi chess badminton tennis olympic olympics athletics khelo india ipl fifa wrestling boxing shooting player medal coach stadium world cup' }
];

const PHRASE_ONLY_WORDS = new Set('of in one do doing make new high change self local rate world south global east west middle vice right principle union day force media capital interest quality air net zero free ease nation food land farm natural organic raj valley struggle singh bose machine learning cup mental same sex civil society surgical strike armed pressure political emotional intelligence classical relation state welfare smart city digital divide senior citizen national park bullet train freedom fighter gi tag district magistrate'.split(' '));

const TOPIC_RULES = TOPICS.map((t) => {
  // Multi-word phrases are matched as phrases, single words as whole words.
  const words = t.words.split(' ');
  const phrases = [];
  const singles = new Set();
  // Phrase list: any two/three consecutive words that appear as a known phrase above.
  const known = ['rajya sabha', 'lok sabha', 'niti aayog', 'district magistrate', 'welfare state', 'cooperative federalism', 'centre state relation', 'bullet train', 'smart city', 'national park', 'freedom fighter', 'gi tag', 'senior citizen', 'digital divide', 'supreme court', 'high court', 'fundamental right', 'fundamental duties', 'directive principle', 'election commission', 'local self government', 'civil servant', 'civil service', 'police reform', 'e governance', 'anti defection', 'one nation one election', 'uniform civil code', 'sri lanka', 'united nations', 'world bank', 'foreign policy', 'global south', 'indo pacific', 'european union', 'middle east', 'west asia', 'united kingdom', 'reserve bank', 'income tax', 'make in india', 'stock market', 'digital payment', 'ease of doing business', 'interest rate', 'capital market', 'artificial intelligence', 'machine learning', 'electric vehicle', 'social media', 'climate change', 'global warming', 'net zero', 'air quality', 'indus valley', 'freedom struggle', 'bhagat singh', 'subhas bose', 'british raj', 'classical language', 'same sex', 'civil society', 'mental health', 'new education policy', 'armed force', 'air force', 'internal security', 'cyber security', 'surgical strike', 'emotional intelligence', 'political pressure', 'organic farming', 'natural farming', 'food processing', 'farm law', 'land reform', 'food security', 'khelo india', 'world cup'];
  const text = ` ${t.words} `;
  for (const p of known) if (text.includes(` ${p} `)) phrases.push(p);
  // Words that only mean something inside their phrase ("make in india", "air force") don't count alone.
  for (const w of words) if (!isStopword(w) && !PHRASE_ONLY_WORDS.has(w)) singles.add(w);
  return { id: t.id, phrases, singles };
});

export const TOPIC_LABELS = Object.fromEntries(TOPICS.map((t) => [t.id, t.label]));
TOPIC_LABELS.personal = 'Personal & DAF';
TOPIC_LABELS.general = 'General';

// Up to two topics, strongest first. Personal/DAF questions with no subject matter get 'personal'.
export const topicsFor = (text, hooks = []) => {
  const norm = ` ${normalizeText(text)} `;
  const words = new Set(norm.trim().split(' '));
  const scores = [];
  for (const r of TOPIC_RULES) {
    let s = 0;
    for (const p of r.phrases) if (norm.includes(` ${p} `)) s += 2;
    for (const w of r.singles) if (!w.includes(' ') && words.has(w)) s += 1;
    if (s > 0) scores.push([r.id, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const out = [];
  if (scores[0]) out.push(scores[0][0]);
  if (scores[1] && scores[1][1] >= Math.max(1, scores[0][1] / 2)) out.push(scores[1][0]);
  if (!out.length) out.push(hooks.length || / (you|your|yourself) /.test(norm) ? 'personal' : 'general');
  return out;
};

// ------------------------------------------------------------------ DAF hooks

// What in the candidate's DAF (Detailed Application Form) a question was anchored to.
export const HOOK_TYPES = {
  intro: 'Introduction',
  motivation: 'Why civil services',
  name: 'Your name',
  home: 'Home state & district',
  education: 'Education',
  work: 'Work experience',
  optional: 'Optional subject',
  hobby: 'Hobbies & interests',
  eca: 'Achievements & activities',
  service: 'Service preference',
  family: 'Family background',
  language: 'Languages'
};

const HOBBY_WORDS = 'cricket football hockey kabaddi chess badminton tennis table tennis volleyball basketball swimming running jogging marathon cycling trekking hiking mountaineering yoga meditation gym fitness weight training athletics kho kho wrestling boxing archery shooting horse riding skating reading writing poetry poems blogging blog painting sketching drawing doodle art music singing guitar flute piano tabla violin dance dancing kathak bharatanatyam cooking baking gardening photography travelling traveling travel movies cinema films anime manga gaming video games esports quiz quizzing debating debate public speaking stand up comedy calligraphy origami knitting stamp collection coin collection numismatics bird watching birding astronomy stargazing podcast podcasts journaling sudoku rubik theatre theater drama acting content creation youtube vlogging novels storytelling volunteering'.split(' ');
const HOBBY_PHRASES = ['table tennis', 'weight training', 'kho kho', 'horse riding', 'public speaking', 'stand up comedy', 'stamp collection', 'coin collection', 'bird watching', 'video games', 'content creation'];
const ECA_WORDS = 'ncc nss scout scouts guide guides olympiad mun model united nations club society secretary president captain volunteer award awards prize medal gold silver bronze topper scholarship kvpy ntse hackathon fellowship paper published publication patent certificate certification'.split(' ');
const EDU_WORDS = 'btech b.tech be m.tech mtech engineering iit nit iiit bits mbbs md bds ba ma bsc msc bcom mcom mba pgdm phd llb llm jnu du srcc stephens college university graduation graduate postgraduate pg ug cse ece eee mechanical civil electrical chemical computer science electronics biotech biotechnology architecture pharmacy nursing humanities honours hons degree school'.split(' ');
const WORK_WORDS = 'worked working job employee analyst consultant manager officer bank sbi railway railways psu ongc ntpc bhel isro drdo infosys tcs wipro accenture deloitte google microsoft amazon startup company ltd pvt teacher teaching lecturer professor doctor lawyer advocate journalist ras pcs psc irs ips ifs irts ias ca firm intern internship'.split(' ');

const hasAny = (norm, list) => list.some((w) => norm.includes(` ${w} `));

// Decide which DAF bucket a free-form profile keyword ("Meerut", "IIT Bombay", "Kabaddi") belongs to.
export const classifyProfileTerm = (term) => {
  const raw = String(term || '');
  const norm = ` ${normalizeText(raw)} `;
  if (!norm.trim()) return null;
  if (canonicalState(raw) || stateMentions(raw).length) return 'home';
  if (/\boptional\b/i.test(raw) && canonicalOptional(raw)) return 'optional';
  if (hasAny(norm, HOBBY_PHRASES) || hasAny(norm, HOBBY_WORDS)) return 'hobby';
  if (hasAny(norm, ECA_WORDS)) return 'eca';
  if (hasAny(norm, EDU_WORDS) || /\bb\.?\s?tech|\bm\.?\s?tech|\bb\.?\s?sc|\bm\.?\s?sc|\bb\.?\s?a\b|\bm\.?\s?a\b/i.test(raw)) return 'education';
  if (hasAny(norm, WORK_WORDS)) return 'work';
  return null;
};

// Phrases that anchor a question to a DAF area even when no profile word is repeated in it.
const HOOK_PATTERNS = [
  ['intro', /\b(introduce yourself|introduce your ?self|tell (me|us) (something )?about (yourself|your ?self)|about yourself|who are you|brief introduction)\b/],
  ['motivation', /\b(why (do you want to (join|become|be)|civil services?|ias|ips|ifs|irs|upsc|not (ias|ips|ifs|private|corporate))|plan b|backup plan|what if you (dont|do not) (get|clear)|why did you (leave|quit) your job|why (this|the) service|civil services?\b.*\bwhy)\b/],
  ['name', /\b(your name|meaning of (your )?name|name means|named after|your surname)\b/],
  ['home', /\b(your (home ?state|state|district|city|town|village|hometown|native|region|place)|home ?state|home ?town|where (are|do) you (from|live|belong))\b/],
  ['education', /\b(your (college|university|graduation|degree|engineering|branch|stream|subject|course|education|school|thesis|project|dissertation|alma mater|iit|nit|mbbs)|you (studied|graduated))\b/],
  ['work', /\b(your (job|work|company|organi[sz]ation|employer|office|profession|role|workplace|experience|bank|department)|you (worked|work|are working)|while working)\b/],
  ['optional', /\b(your optional|optional subject|why (did you (choose|take|opt))? ?\w* ?as (your )?optional|why .* optional)\b/],
  ['hobby', /\b(your (hobby|hobbies|interest|interests|passion)|hobby|hobbies)\b/],
  ['eca', /\b(your (achievement|achievements|award|medal|certificate|paper|publication|ncc|nss|club|volunteering)|you (won|received|got) (an? )?(award|medal|prize))\b/],
  ['service', /\b(service preference|preference list|cadre|why (ias|ips|ifs|irs) (first|as first)|first preference|your preferences)\b/],
  ['family', /\b(your (father|mother|parents?|family|brother|sister|husband|wife|spouse|grandfather|grandmother)|family background|what (does|do|did) your (father|mother|parents) do)\b/],
  ['language', /\b(your mother ?tongue|mother ?tongue|(which|what|how many) languages|languages? (do )?you (know|speak))\b/]
];

const GENERIC_TERM_TOKENS = new Set(['engineering', 'university', 'college', 'graduation', 'school', 'degree', 'science', 'state', 'india', 'indian', 'work', 'job', 'reading', 'writing', 'others', 'other', 'experience', 'company', 'institute', 'technology', 'hons', 'honours', 'department', 'national', 'government', 'district', 'city']);

// Hooks for one question given the asking candidate's profile terms [{type, value}].
// value is the lower-case profile word the question repeated (e.g. 'cricket'), or '' for a pattern-only hook.
export const hooksFor = (text, profileTerms = []) => {
  const norm = ` ${normalizeText(text)} `;
  const hooks = [];
  const seen = new Set();
  const add = (type, value) => {
    const k = `${type}:${value}`;
    if (seen.has(k)) return;
    seen.add(k);
    hooks.push({ type, value });
  };
  for (const { type, value } of profileTerms) {
    if (!type || !value) continue;
    const v = normalizeText(value);
    if (v.length < 3) continue;
    if (norm.includes(` ${v} `)) { add(type, v); continue; }
    // "IIT Bombay" is still hooked by a question about "Bombay"; generic words don't count, and a
    // multi-word item needs all its distinctive words ("Women empowerment cell" isn't hooked by "women").
    const toks = v.split(' ').filter((t) => t.length >= 4 && !GENERIC_TERM_TOKENS.has(t) && !isStopword(t));
    if (toks.length && toks.length <= 3 && toks.every((t) => norm.includes(` ${t} `))) add(type, v);
  }
  for (const [type, re] of HOOK_PATTERNS) {
    if (re.test(norm)) {
      if (!hooks.some((h) => h.type === type)) add(type, '');
    }
  }
  return hooks;
};

// ------------------------------------------------------------------ question type & shelf life

export const QTYPES = {
  situational: 'Situational',
  opinion: 'Opinion',
  factual: 'Factual',
  personal: 'Personal',
  other: 'Other'
};

export const qtypeFor = (text, hooks = []) => {
  const n = ` ${normalizeText(text)} `;
  if (/ (as an? (dm|district magistrate|collector|sp|superintendent|sdm|ias|ips|officer|administrator|ifs|diplomat|bureaucrat|civil servant|commissioner|district collector|ceo)|if you (are|were|become|get|have to|had to)|suppose|imagine|what will you do|what would you do|how will you (handle|deal|tackle|manage|ensure|solve|convince|address|stop|control|improve|reduce|increase)|how would you|in your district|you are the) /.test(n)) return 'situational';
  if (/ (do you think|dont you think|your (view|views|opinion|take|stand|thoughts)|should|is it (right|good|fair|justified|necessary|correct|wrong|ok)|do you agree|agree|justify|good or bad|pros and cons|how do you see|what do you feel|do you support|is it time|better|criticism|critically|is it a|are we|can we) /.test(n)) return 'opinion';
  if (hooks.length && / (you|your|yourself) /.test(n)) return 'personal';
  if (/^ (what is|what are|whats|who is|who was|who are|when|where|how many|how much|which|name|define|difference between|differentiate|what does|full form|what do you mean|meaning of|what was|list|enumerate) /.test(n)) return 'factual';
  if (/ (you|your|yourself) /.test(n)) return 'personal';
  return 'other';
};

export const shelfLifeFor = (text) =>
  /\b(recent|recently|these days|nowadays|now a days|in news|news|current|currently|latest|this year|last year|last month|last week|yesterday|today|ongoing|upcoming|just (happened|announced)|20(19|2[0-6]))\b/i.test(text)
    ? 'event'
    : 'evergreen';

// ------------------------------------------------------------------ profile -> terms

// Profile of one transcript (or of the logged-in student's DAF) -> [{type, value}] for hooksFor().
export const profileTerms = (profile = {}) => {
  const terms = [];
  const push = (type, v) => { if (v && String(v).trim().length >= 2) terms.push({ type, value: String(v).trim() }); };
  for (const h of profile.hobbies || []) push('hobby', h);
  for (const e of profile.education || []) push('education', e);
  for (const w of profile.work || []) push('work', w);
  for (const a of profile.achievements || []) push('eca', a);
  if (profile.optional) push('optional', profile.optional);
  if (profile.homeState) push('home', profile.homeState);
  if (profile.homeDistrict) push('home', profile.homeDistrict);
  for (const k of profile.keywords || []) {
    const type = classifyProfileTerm(k);
    if (type) push(type, k);
  }
  const seen = new Set();
  return terms.filter((t) => {
    const k = `${t.type}:${normalizeText(t.value)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Questions with fewer than two content words ("Why?", "Anything else?") are kept in their transcript
// but left out of the question bank and of families.
export const isTrivialQuestion = (text) => tokenize(text).length < 2 && String(text || '').length < 40;

export const tagQuestion = (text, profile) => {
  const hooks = hooksFor(text, profileTerms(profile));
  return {
    hooks,
    topics: topicsFor(text, hooks),
    qtype: qtypeFor(text, hooks),
    shelfLife: shelfLifeFor(text)
  };
};

export { uniq };

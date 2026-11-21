// UPSC's interview schedule: reading the PDF UPSC publishes, replacing the stored copy, and looking up one
// candidate by roll number. Rows in the PDF read
//   "1 07-Dec-2026 Monday Forenoon 09:00 HRS 0811049 DIPANSHU GUPTA"
// (cells separated by spaces or tabs). A few long names are cut at the page edge in the PDF itself; the
// rest of such a name sits on an overflow page and is not joined back (the roll number is what matches).
import InterviewSchedule from '../../models/InterviewSchedule.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ROW = /^(\d+)\s+(\d{2})-([A-Za-z]{3})-(\d{4})\s+([A-Za-z]+)\s+(Forenoon|Afternoon)\s+(\d{2}:\d{2})\s*HRS\s+(\d{7})\s+(.+)$/;

// Schedule text (one row per line) -> rows. Lines that aren't rows (headers, page numbers, name tails) are
// skipped; a roll number seen twice keeps its first row.
export const parseScheduleText = (text) => {
  const rows = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.replace(/\s+/g, ' ').trim().match(ROW);
    if (!m) continue;
    const [, sl, dd, mon, yyyy, day, session, time, roll, name] = m;
    const mm = MONTHS[mon.toLowerCase()];
    if (!mm || seen.has(roll)) continue;
    seen.add(roll);
    rows.push({
      sl: Number(sl),
      date: `${yyyy}-${String(mm).padStart(2, '0')}-${dd}`,
      day,
      session,
      reportingTime: time,
      roll,
      name: name.trim().slice(0, 120)
    });
  }
  return rows;
};

export const parseSchedulePdf = async (buffer) => {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const { text } = await parser.getText();
    return parseScheduleText(text);
  } finally {
    await parser.destroy?.().catch?.(() => {});
  }
};

// A new upload replaces the whole schedule (UPSC publishes revised lists).
export const replaceSchedule = async (rows, fileName = '') => {
  await InterviewSchedule.deleteMany({});
  for (let i = 0; i < rows.length; i += 1000) {
    await InterviewSchedule.insertMany(rows.slice(i, i + 1000).map((r) => ({ ...r, fileName })), { ordered: false });
  }
  return scheduleInfo();
};

export const scheduleInfo = async () => {
  const [count, first, last, any] = await Promise.all([
    InterviewSchedule.estimatedDocumentCount(),
    InterviewSchedule.findOne().sort({ date: 1 }).select('date').lean(),
    InterviewSchedule.findOne().sort({ date: -1 }).select('date').lean(),
    InterviewSchedule.findOne().select('createdAt fileName').lean()
  ]);
  return { count, firstDate: first?.date || null, lastDate: last?.date || null, uploadedAt: any?.createdAt || null, fileName: any?.fileName || '' };
};

export const normalizeRoll = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 6) return `0${d}`; // a leading zero read as nothing
  return d.length === 7 ? d : '';
};

export const findByRoll = async (roll) => {
  const r = normalizeRoll(roll);
  return r ? InterviewSchedule.findOne({ roll: r }).lean() : null;
};

// The reporting time as an instant: the schedule's times are Indian time (UTC+5:30).
export const reportingAt = (row) => new Date(`${row.date}T${row.reportingTime}:00+05:30`);

// "DIPANSHU GUPTA" -> "Dipanshu" (for a greeting).
export const firstNameOf = (name) => {
  const w = String(name || '').trim().split(/\s+/)[0] || '';
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
};

// Input sanitisers for user-controlled profile fields. These values end up in places where odd
// characters cause real damage (PDF watermarks, GitHub Actions inputs, regex queries), so we
// normalise them at the door instead of trusting each consumer to cope.

// Code-point ranges we never keep: control chars, zero-width chars, line/paragraph separators and
// bidi overrides. Expressed as numbers (not regex escapes) because some of these code points are
// line terminators inside JS source.
const INVISIBLE_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff]
];
const RIGHT_SINGLE_QUOTE = 0x2019;

const isInvisible = (cp) => INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const isNameChar = (ch) => /^[\p{L}\p{M}]$/u.test(ch) || ch === '.' || ch === "'" || ch === '-' || ch.codePointAt(0) === RIGHT_SINGLE_QUOTE;

// Keeps letters (any script), combining marks, spaces and . ' - . Returns '' when nothing usable is left.
export const sanitizePersonName = (raw, max = 80) => {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (isInvisible(cp) || /\s/u.test(ch)) out += ' ';
    else if (isNameChar(ch)) out += ch;
  }
  return out.replace(/ +/g, ' ').trim().slice(0, max);
};

// Digits with an optional leading +. Returns '' when it does not look like a phone number.
export const sanitizeMobile = (raw) => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return (hasPlus ? '+' : '') + digits;
};

export const sanitizeTelegram = (raw) => {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_.]{3,64}$/.test(s) ? s : '';
};

// For building a RegExp from user input (e.g. UPI transaction IDs).
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

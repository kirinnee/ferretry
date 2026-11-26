/**
 * A `<voice>` line as pieces to speak one after another, so the first sound does not wait for the last word to be
 * turned into sound. A short sentence is one piece; a long sentence is cut into clauses, then bounded to
 * {@link MAX_PIECE_WORDS} words, preferring conjunctions. A clause too short to stand alone joins its neighbour. Numbers are written
 * out first, because the voice's English lexicon has no digits and would skip them. Pure and total.
 */
const MAX_PIECE_WORDS = 12;
const SHORT_CLAUSE = 3;
const CLAUSE_STARTS = new Set(['and', 'but', 'because', 'so', 'when', 'while']);
/** The model is not asked for more than this at once: a longer piece is cut at a space. */
const MAX_PIECE_CHARS = 280;

const words = (text: string): number => text.split(/\s+/u).filter(word => word.length > 0).length;

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…]+["')\]]*(?=\s|$)/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  out.push(text.slice(start).trim());
  return out.filter(sentence => /[\p{L}\p{N}]/u.test(sentence));
}

function clausesOf(sentence: string): string[] {
  if (words(sentence) <= MAX_PIECE_WORDS) return [sentence];
  const clauses: string[] = [];
  let start = 0;
  for (const match of sentence.matchAll(/[,;:](?=\s)/gu)) {
    const end = (match.index ?? 0) + 1;
    clauses.push(sentence.slice(start, end).trim());
    start = end;
  }
  clauses.push(sentence.slice(start).trim());
  // A clause with fewer than three words reads badly alone: it goes with the one after it (or before it, at the end).
  const joined: string[] = [];
  let carry = '';
  for (const clause of clauses) {
    const next = carry === '' ? clause : `${carry} ${clause}`;
    if (words(next) < SHORT_CLAUSE) carry = next;
    else {
      joined.push(next);
      carry = '';
    }
  }
  if (carry !== '') {
    if (joined.length === 0) joined.push(carry);
    else joined[joined.length - 1] = `${joined[joined.length - 1]} ${carry}`;
  }
  return joined;
}

function cut(piece: string): string[] {
  const tokens = piece.split(' ');
  if (tokens.length > MAX_PIECE_WORDS) {
    // A long sentence with no comma must not delay first audio. Keep at least three words in the tail, and prefer
    // "the build failed | because ..." to breaking a noun phrase at an arbitrary word count.
    let boundary = Math.min(MAX_PIECE_WORDS, tokens.length - SHORT_CLAUSE);
    for (let at = SHORT_CLAUSE; at <= Math.min(MAX_PIECE_WORDS, tokens.length - SHORT_CLAUSE); at += 1)
      if (CLAUSE_STARTS.has((tokens[at] ?? '').toLowerCase())) boundary = at;
    return [...cut(tokens.slice(0, boundary).join(' ')), ...cut(tokens.slice(boundary).join(' '))];
  }
  if (piece.length <= MAX_PIECE_CHARS) return [piece];
  // Any word boundary will do, even an early one: a token is cut inside only when it alone exceeds the limit.
  const space = piece.lastIndexOf(' ', MAX_PIECE_CHARS);
  const at = space > 0 ? space : MAX_PIECE_CHARS;
  return [piece.slice(0, at).trim(), ...cut(piece.slice(at).trim())].filter(part => part.length > 0);
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
] as const;

function belowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0)
    parts.push(
      rest < 20
        ? (ONES[rest] as string)
        : `${TENS[Math.floor(rest / 10)]}${rest % 10 === 0 ? '' : ` ${ONES[rest % 10]}`}`,
    );
  return parts.join(' ');
}

/** A whole number as English words. Past the safe integers it is read digit by digit rather than guessed. */
function integerWords(digits: string): string {
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n >= 1e15) return [...digits].map(digit => ONES[Number(digit)]).join(' ');
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of SCALES) {
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${belowThousand(count)} ${name}`);
    rest %= size;
  }
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** "1,204 tests" → "one thousand two hundred four tests"; "3.5" → "three point five"; "50%" → "fifty percent". */
export function spokenNumbers(text: string): string {
  return text.replace(/(?<![\p{L}\d])\d+(?:,\d{3})*(?:\.\d+)?%?(?![\p{L}\d])/gu, match => {
    const percent = match.endsWith('%');
    const [whole = '', fraction] = match.replace(/%$/u, '').replaceAll(',', '').split('.');
    const said =
      fraction === undefined
        ? integerWords(whole)
        : `${integerWords(whole)} point ${[...fraction].map(digit => ONES[Number(digit)]).join(' ')}`;
    return percent ? `${said} percent` : said;
  });
}

export function splitForSpeech(text: string): string[] {
  const folded = spokenNumbers(text).replace(/\s+/gu, ' ').trim();
  return sentencesOf(folded)
    .flatMap(clausesOf)
    .flatMap(cut)
    .filter(piece => /[\p{L}\p{N}]/u.test(piece));
}

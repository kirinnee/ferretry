/**
 * What was typed is never printed back, in any spelling the CLI or the daemon could print it in.
 *
 * A {@link PrivateText} holds the values a person typed (from standard input, or words on the command line) and
 * makes every string a verb prints safe: a long value is replaced by {@link MASK}; a value too short to hide without
 * hiding the words around it ({@link MASK_MIN_LENGTH}) is not masked at all — the string that repeats it is withheld,
 * whole, and the sentence says so. Nothing is left unmasked because it was short.
 *
 * THE BOUNDARY is {@link PrivateText.sealed}: it decodes what is about to be printed (JSON escapes whole or partial,
 * percent escapes in any case, again and again until nothing changes) and compares every stage with every typed value
 * (as typed, in hex, in base64). A match, or a text that will not stop decoding, withholds the whole answer. The masks
 * below only keep an ordinary answer readable; they are never what makes it safe.
 *
 * "Any spelling" the masks know: the text itself; as JSON writes it (`\"`, `\\`, `\n`, `\t`, control characters), with its `/`
 * escaped (`\/`), with every character a `\uXXXX` escape (either case) or only the non-ASCII ones; as a URL carries it
 * (percent-encoded in either case, `+` for a space, every byte encoded); and each of those once more as JSON text
 * inside JSON (what a daemon's answer becomes when this CLI prints it with `--json`).
 *
 * Pure: no IO, no globals.
 */

/** What a masked value becomes. */
export const MASK = '[typed text]';

/** The shortest value that is masked rather than withheld around. */
const MASK_MIN_LENGTH = 3;

/** What replaces a string that repeats a value too short to mask. */
export const WITHHELD =
  '[withheld: this text repeats what you typed, which is too short to hide without hiding the words around it]';

const hex = (code: number, width: number, upper: boolean): string => {
  const digits = code.toString(16).padStart(width, '0');
  return upper ? digits.toUpperCase() : digits;
};

/** `\uXXXX` for each UTF-16 unit of every character (`all`), or of the non-ASCII ones only. */
function unicodeEscapes(value: string, upper: boolean, all: boolean): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    out += all || unit > 0x7e || unit < 0x20 ? `\\u${hex(unit, 4, upper)}` : String.fromCharCode(unit);
  }
  return out;
}

/** Every byte of the text as `%XX`. */
function percentAll(value: string, upper: boolean): string {
  return [...new TextEncoder().encode(value)].map(byte => `%${hex(byte, 2, upper)}`).join('');
}

const lowerPercent = (encoded: string): string => encoded.replace(/%[0-9A-F]{2}/gu, match => match.toLowerCase());

/** The body of `value` as a JSON string literal, without its quotes. */
const jsonBody = (value: string): string => JSON.stringify(value).slice(1, -1);

/** JSON as an ASCII-only encoder writes it: the usual escapes, and a `\uXXXX` for every non-ASCII unit. */
const asciiJson = (value: string, upper: boolean): string =>
  jsonBody(value).replace(/\P{ASCII}/gu, char =>
    Array.from({ length: char.length }, (_, index) => `\\u${hex(char.charCodeAt(index), 4, upper)}`).join(''),
  );

/** One value in every spelling listed above, longest first, never empty. Exported for the tests that prove the list. */
export function spellings(value: string): readonly string[] {
  const json = jsonBody(value);
  const url = encodeURIComponent(value);
  const first = new Set<string>([
    value,
    json,
    json.replaceAll('/', '\\/'),
    asciiJson(value, false),
    asciiJson(value, true),
    asciiJson(value, false).replaceAll('/', '\\/'),
    value.replaceAll('/', '\\/'),
    unicodeEscapes(value, false, true),
    unicodeEscapes(value, true, true),
    unicodeEscapes(value, false, false),
    unicodeEscapes(value, true, false),
    url,
    lowerPercent(url),
    url.replaceAll('%20', '+'),
    encodeURI(value),
    percentAll(value, true),
    percentAll(value, false),
  ]);
  // The same, written once more as JSON text inside JSON.
  const all = new Set<string>(first);
  for (const spelling of first) all.add(jsonBody(spelling));
  all.delete('');
  return [...all].sort((left, right) => right.length - left.length);
}

/** Whether `text` carries any spelling, not counting the mask itself (a value may be a word of the mask's own). */
const repeats = (text: string, spelled: readonly string[]): boolean => {
  const bare = text.split(MASK).join('\u0000');
  return spelled.some(spelling => bare.includes(spelling));
};

// ── decode, then compare ─────────────────────────────────────────────────────────────────────────────────────────

/** How many times a text may be decoded before it is judged unsure. Real answers settle in one or two. */
const MAX_DECODES = 12;

/** What the check stands on in place of the mask and the withheld sentence, which are not the typed value. */
const NEUTRAL = '\u0000';

const JSON_SIMPLE: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** JSON's own escapes (`\uXXXX` in either case, `\"`, `\\`, `\/`, `\n`…) turned back into the characters they spell. */
const unescapeJson = (text: string): string =>
  text.replace(
    /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/gu,
    (_match, unit: string | undefined, simple: string | undefined) =>
      unit === undefined ? (JSON_SIMPLE[simple as string] as string) : String.fromCharCode(Number.parseInt(unit, 16)),
  );

/** A run of `%XX` escapes (hex in any case) read as UTF-8 bytes; bytes that are not UTF-8 stay as one character each. */
const unescapePercent = (text: string): string =>
  text.replace(/(?:%[0-9a-fA-F]{2})+/gu, run => {
    const bytes = Uint8Array.from(run.match(/[0-9a-fA-F]{2}/gu) as string[], pair => Number.parseInt(pair, 16));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return String.fromCharCode(...bytes);
    }
  });

const decodeOnce = (text: string): string => unescapePercent(unescapeJson(text));

/**
 * `text` and every further decoding of it, until nothing changes. `settled` is false when it was still changing after
 * {@link MAX_DECODES} rounds: the caller cannot be sure what the text says, and fails closed.
 */
function decodings(text: string): { readonly stages: readonly string[]; readonly settled: boolean } {
  const stages = [text];
  let current = text;
  for (let round = 0; round < MAX_DECODES; round += 1) {
    const next = decodeOnce(current);
    if (next === current) return { stages, settled: true };
    stages.push(next);
    current = next;
  }
  return { stages, settled: decodeOnce(current) === current };
}

const hexOf = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Base64 of `bytes` as it reads inside a longer base64 text, at each of the three alignments (standard and URL-safe). */
function base64Cores(bytes: Uint8Array): readonly string[] {
  const cores: string[] = [];
  for (const lead of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(lead), bytes]);
    // Only whole 3-byte groups inside the value are fixed whatever follows it; skip the lead's own characters.
    const whole = Math.floor(padded.length / 3) * 4;
    const skip = lead === 0 ? 0 : lead === 1 ? 2 : 3;
    const standard = padded.toString('base64').slice(skip, whole);
    if (standard.length >= 4) cores.push(standard, padded.toString('base64url').slice(skip, whole));
  }
  return cores;
}

/** One typed value in every form a decoded text could still carry it in; never an empty string. */
function needles(value: string): { readonly exact: readonly string[]; readonly hex: string | undefined } {
  const bytes = new TextEncoder().encode(value);
  const canonical = decodings(value).stages.at(-1) as string;
  const exact = new Set<string>([value, value.replaceAll(' ', '+'), canonical, canonical.replaceAll(' ', '+')]);
  // Hex and base64 of something shorter than this would match ordinary ids and words.
  if (value.length >= MASK_MIN_LENGTH) for (const core of base64Cores(bytes)) exact.add(core);
  exact.delete('');
  return { exact: [...exact], hex: value.length >= MASK_MIN_LENGTH ? hexOf(bytes) : undefined };
}

/**
 * Whether `text`, in any of its decodings, carries `value`: as typed, with `+` for a space, as hex (either case) or as
 * base64. `unsure` means the text would not stop decoding: the caller cannot say what it shows.
 */
function carries(text: string, value: string): { readonly found: boolean; readonly unsure: boolean } {
  const bare = text.split(MASK).join(NEUTRAL).split(WITHHELD).join(NEUTRAL);
  const { stages, settled } = decodings(bare);
  const { exact, hex } = needles(value);
  const found = stages.some(
    stage => exact.some(form => stage.includes(form)) || (hex !== undefined && stage.toLowerCase().includes(hex)),
  );
  return { found, unsure: !settled };
}

export class PrivateText {
  private readonly values: readonly { readonly value: string; readonly spelled: readonly string[] }[];

  constructor(typed: readonly string[]) {
    const unique = [...new Set(typed.filter(value => value !== ''))];
    this.values = unique.map(value => ({ value, spelled: spellings(value) }));
  }

  /** Whether anything was typed that needs hiding. */
  get any(): boolean {
    return this.values.length > 0;
  }

  /** `text` with every spelling of every typed value masked; a string that repeats a short one is withheld whole. */
  clean(text: string): string {
    let out = text;
    for (const { value, spelled } of this.values) {
      if (!repeats(out, spelled)) continue;
      if (value.length < MASK_MIN_LENGTH) return WITHHELD;
      for (const spelling of spelled) out = out.split(spelling).join(MASK);
    }
    return out;
  }

  /** Every string inside `data` (and every key), cleaned the same way; the shape is kept. */
  cleanData(data: unknown): unknown {
    if (typeof data === 'string') return this.clean(data);
    if (Array.isArray(data)) return data.map(item => this.cleanData(item));
    if (typeof data === 'object' && data !== null)
      return Object.fromEntries(Object.entries(data).map(([key, item]) => [this.clean(key), this.cleanData(item)]));
    return data;
  }

  /**
   * The last look at what is about to be printed, and the boundary this class stands on: the output is DECODED
   * (JSON escapes in whole or in part, percent escapes in any case, repeated until nothing changes) and every stage is
   * compared with every typed value, as typed, in hex and in base64. A match — or a text that will not stop decoding,
   * so cannot be vouched for — withholds the WHOLE answer with one sentence. No list of spellings decides this, so a
   * spelling nobody thought of is caught all the same. With `asJson` the sentence is still one JSON value.
   */
  sealed(output: string, asJson = false): string {
    for (const { value } of this.values) {
      const { found, unsure } = carries(output, value);
      if (found || unsure) return asJson ? JSON.stringify({ withheld: WITHHELD }) : WITHHELD;
    }
    return output;
  }
}

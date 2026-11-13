/**
 * What was typed is never printed back, in any spelling the CLI or the daemon could print it in.
 *
 * A {@link PrivateText} holds the values a person typed (from standard input, or words on the command line) and
 * makes every string a verb prints safe: a long value is replaced by {@link MASK}; a value too short to hide without
 * hiding the words around it ({@link MASK_MIN_LENGTH}) is not masked at all — the string that repeats it is withheld,
 * whole, and the sentence says so. Nothing is left unmasked because it was short.
 *
 * "Any spelling": the text itself; as JSON writes it (`\"`, `\\`, `\n`, `\t`, control characters), with its `/`
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
   * The last look at what is about to be printed: a masked value cannot remain, but if one does (a spelling this list
   * does not know, joined across two strings) the whole output is withheld rather than printed.
   */
  sealed(output: string): string {
    for (const { value, spelled } of this.values)
      if (value.length >= MASK_MIN_LENGTH && repeats(output, spelled)) return WITHHELD;
    return output;
  }
}

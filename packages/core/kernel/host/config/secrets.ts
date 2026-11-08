/**
 * The raw-secret detector: a configuration file may NEVER hold a secret value (docs/config-files.md).
 *
 * A secret lives in the secret store (`<binary> secret set NAME`) and a file names it as `${secret:NAME}`;
 * Ferretry puts the value into the one child process that needs it and nowhere else
 * (docs/secrets.md). A key pasted into a YAML file instead is readable by every editor of the
 * directory, copied by Clone and Export, and shown by "Edit as YAML" — so a file that holds one is
 * refused, exactly like a file that does not parse, and its last good version stays in effect.
 *
 * Two tests, either of which flags a value:
 *
 * 1. **A known key shape** anywhere in a string: `sk-`, `sk-ant-`, `sk-or-`, `AKIA…`, `ghp_`,
 *    `github_pat_`, `xox…-`, `gsk_`, `csk-`, `AIza…`, `glpat-`. These prefixes are what providers
 *    issue, so they are flagged under any key.
 * 2. **A high-entropy value under a key that names a credential** — `…KEY`, `…TOKEN`, `…SECRET`,
 *    `…PASSWORD`, `…CREDENTIAL(S)` — that is not a reference.
 *
 * WHAT IT NEVER DOES is repeat the value: an issue names where the value is and how to fix it, so a
 * secret that was pasted by mistake travels no further than the file it was pasted into.
 *
 * Pure: no IO.
 */
/**
 * A located finding: the path to the value inside the document, never the value.
 *
 * A KEY shaped like a token is a finding too (`ghp_…: true`): then `path` is the object that holds it, so no message
 * built from `path` can repeat the key, and `atKey` is the full path to the key, for the line number only.
 */
export interface SecretFinding {
  readonly path: readonly (string | number)[];
  /** Set when the secret-shaped thing is a key: the path INCLUDING it. Locate with it; never print it. */
  readonly atKey?: readonly (string | number)[];
}

/** What a person is told to do instead, in one sentence. */
export const rawSecretFix = (binary: string): string =>
  `store the value with \`${binary} secret set NAME\`, then write \${secret:NAME} here instead — a secret value never goes in a configuration file`;

/** What the finding is, in one sentence that never includes the value. */
export const RAW_SECRET_MESSAGE = 'this looks like a raw secret (an API key or token)';

/** The same for a NAME: it never includes the name. */
export const RAW_SECRET_KEY_MESSAGE = 'a name in here looks like a raw secret (an API key or token)';

/**
 * The longest text any pattern in this module is run over at once. A file is at most 256 KiB and a line of it can be
 * all of that, so a long line (or a long value) is looked at in windows of this size and no pattern ever sees more:
 * the cost of each test is bounded by the window, whatever the text. Every pattern here is linear anyway (see each);
 * the window is the second wall.
 */
const SCAN_WINDOW = 4096;

/**
 * How far two windows overlap: more than the shortest text any known shape can match (`AIza` and 30 more, 34
 * characters) plus one character of context on each side, so a key that one window cuts is whole in the next.
 */
const SCAN_OVERLAP = 64;

/**
 * The longest credential word {@link CREDENTIAL_KEY} ends in (`credentials`), with room to spare: the pattern is
 * anchored at the END of the key, so only this much of the key is ever shown to it.
 */
const CREDENTIAL_KEY_TAIL = 16;

/**
 * Linear: each is a `\b`, a fixed literal, then ONE character class repeated, and nothing after it but (for AKIA) a
 * `\b`. A start that does not spell the literal fails in a few characters, and the class is never followed by
 * anything it could give characters back to, so no start costs more than the run it reads.
 */
const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-or-[A-Za-z0-9_-]{8,}/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bgsk_[A-Za-z0-9]{20,}/u,
  /\bcsk-[A-Za-z0-9]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
];

/** The same shapes, to list every match in one window (a match a window's edge may have faked is skipped, not final). */
const KNOWN_SHAPES_EVERYWHERE: readonly RegExp[] = KNOWN_SHAPES.map(shape => new RegExp(shape.source, 'gu'));

/**
 * A key whose value is a credential by its name. Linear: anchored at the end, every alternative a fixed word, and only
 * the key's last {@link CREDENTIAL_KEY_TAIL} characters are ever tested.
 */
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;

/**
 * A value that names a secret rather than holding one: `${secret:NAME}`, `${NAME}` or `$NAME`. Linear: anchored at
 * both ends, so it is tried from one start, and each branch is one class run with one way to end it. Tested only on a
 * value of at most {@link SCAN_WINDOW} characters: a longer one is no reference.
 */
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;

/**
 * A path or a URL: a scheme and `://`, or a leading `/`, `~` or `.`. Linear: anchored at the start, one class run, then
 * a fixed literal; tested on the value's first {@link SCAN_WINDOW} characters only.
 */
const PLACE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu;

/** One whitespace character. Linear: a single class, tested one window at a time. */
const WHITESPACE = /\s/u;

/** The shortest value the entropy test considers; shorter strings are words, not keys. */
const MIN_SECRET_LENGTH = 16;

/** Bits per character above which a value under a credential key reads as random. */
const ENTROPY_THRESHOLD = 3.5;

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Whether any known key shape is anywhere in `text`, no pattern ever seeing more than {@link SCAN_WINDOW} characters.
 *
 * Windows overlap by {@link SCAN_OVERLAP}, and each after the first starts one character early so a `\b` sees what is
 * really before it. A window's edges can still fake a match — the borrowed first character's own boundary is unknown,
 * and a match running into a cut may be ending only because the window does — so such a match is skipped here, and is
 * always whole, with its true context, in the neighbouring window: one at the borrowed character began a full overlap
 * before the previous window's end, and one running into the cut began inside the next window.
 */
function holdsKnownShape(text: string): boolean {
  if (text.length <= SCAN_WINDOW) return KNOWN_SHAPES.some(shape => shape.test(text));
  const step = SCAN_WINDOW - SCAN_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    const from = start === 0 ? 0 : start - 1;
    const window = text.slice(from, start + SCAN_WINDOW);
    const last = start + SCAN_WINDOW >= text.length;
    for (const shape of KNOWN_SHAPES_EVERYWHERE) {
      for (const match of window.matchAll(shape)) {
        if (from !== start && match.index === 0) continue;
        const cut = !last && match.index + match[0].length === window.length;
        if (cut && from + match.index >= start + step) continue;
        return true;
      }
    }
    if (last) break;
  }
  return false;
}

/** Whether `text` holds a whitespace character, each test seeing one window. */
function holdsWhitespace(text: string): boolean {
  for (let start = 0; start < text.length; start += SCAN_WINDOW) {
    if (WHITESPACE.test(text.slice(start, start + SCAN_WINDOW))) return true;
  }
  return false;
}

/** Whether `value`, found under `key`, looks like a raw secret. */
export function looksLikeRawSecret(key: string | number | undefined, value: string): boolean {
  if (holdsKnownShape(value)) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key.slice(-CREDENTIAL_KEY_TAIL))) return false;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH || holdsWhitespace(trimmed)) return false;
  if (trimmed.length <= SCAN_WINDOW && REFERENCE.test(trimmed)) return false;
  // A path or a URL under a "…key" name (a key file, a JWKS endpoint) is where a secret is, not one.
  if (PLACE.test(trimmed.slice(0, SCAN_WINDOW))) return false;
  return shannonEntropy(trimmed) >= ENTROPY_THRESHOLD;
}

/** Every string in `document` that looks like a raw secret, by path. */
export function findRawSecrets(document: unknown): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (typeof value === 'string') {
      // The nearest KEY names the value — an item in a list under `api_keys:` is still a key.
      if (
        looksLikeRawSecret(
          path.findLast(part => typeof part === 'string'),
          value,
        )
      )
        findings.push({ path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, [...path, index]);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        // A key shaped like a token is refused like a value, and nothing below it is walked: any path under it
        // would carry the key into a message.
        if (looksLikeRawSecret(undefined, key)) findings.push({ path, atKey: [...path, key] });
        else visit(item, [...path, key]);
      }
    }
  };
  visit(document, []);
  return findings;
}

/** Whether `character` is one character of whitespace (what `\s` and `trim` both mean). */
const isBlank = (character: string): boolean => character !== '' && character.trim() === '';

/**
 * A line's `key: value` — the key and the value without quotes or a list dash: enough to ask
 * {@link looksLikeRawSecret}. Read by hand, left to right, each character looked at a bounded number of times: a
 * pattern for this (a lazy key beside `\s*`, a lazy value before `\s*$`) backtracks cubically on a line of blanks, and
 * one 4 KiB line of spaces took seconds.
 *
 * The shape it reads: blanks; an optional `-` and at least one blank; an optional quote; the KEY, one or more
 * characters up to the first `:`, quote or `#`; an optional closing quote and blanks; the `:`; then the VALUE, the
 * rest, trimmed, without one opening and one closing quote. A `#` before the colon is a comment, so no key: a comment
 * line is looked at for known key shapes only. A key that ends at the colon is trimmed; one closed by a quote is kept
 * as quoted.
 */
function keyValueOfLine(line: string): { readonly key: string; readonly value: string } | undefined {
  let rest = line.trimStart();
  if (rest.startsWith('-')) {
    const afterDash = rest.slice(1).trimStart();
    if (afterDash.length < rest.length - 1) rest = afterDash;
  }
  if (rest.startsWith('"') || rest.startsWith("'")) rest = rest.slice(1);
  let end = 0;
  while (end < rest.length && !':"\'#'.includes(rest.charAt(end))) end += 1;
  if (end === 0 || end === rest.length) return undefined;
  let colon = end;
  const quoted = rest.charAt(end) === '"' || rest.charAt(end) === "'";
  if (quoted) {
    colon += 1;
    while (isBlank(rest.charAt(colon))) colon += 1;
  }
  if (rest.charAt(colon) !== ':') return undefined;
  const key = quoted ? rest.slice(0, end) : rest.slice(0, end).trimEnd();
  let value = rest.slice(colon + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1);
  if (value.endsWith('"') || value.endsWith("'")) value = value.slice(0, -1);
  return { key, value };
}

/** What a secret found only in the raw text is, in one sentence that never includes it: a comment or a tag counts. */
export const RAW_TEXT_SECRET_MESSAGE =
  'this line looks like it holds a raw secret (an API key or token) — a comment or a tag counts';

/**
 * The first line (1-based) of the RAW TEXT of a file that holds anything shaped like a secret, or `undefined`. It
 * scans what {@link findRawSecrets} cannot: a file that does not parse, and a comment or a tag of one that does (the
 * parsed walk sees values only). Line by line: a known key shape anywhere on the line, or a high-entropy value under a
 * key that names a credential. It answers a line number and nothing else: never WHAT is there.
 *
 * Linear in the text: lines are cut at `\n` by hand (a trailing `\r` dropped), each line is read once by
 * {@link keyValueOfLine}, and every pattern sees at most {@link SCAN_WINDOW} characters at a time.
 */
export function rawTextSecretLine(text: string): number | undefined {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (looksLikeRawSecret(undefined, line)) return index + 1;
    const pair = keyValueOfLine(line);
    if (pair !== undefined && looksLikeRawSecret(pair.key, pair.value)) return index + 1;
  }
  return undefined;
}

/** Whether {@link rawTextSecretLine} finds a line: a caller that gets `true` withholds the text. */
export function rawTextHoldsSecret(text: string): boolean {
  return rawTextSecretLine(text) !== undefined;
}

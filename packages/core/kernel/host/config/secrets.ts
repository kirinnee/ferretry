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
 * A third test, for the write path only, is {@link findFlagSecrets}: a raw secret given to a FLAG (`--token <v>`).
 *
 * Pure: no IO.
 */
import { createHash } from 'node:crypto';
import { endsInCredentialWord, HIDDEN_VALUE_TEXT, namesCredential, urlPasswordCuts } from './secret-words.ts';

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

/** The same shapes, to list every match in one window from a chosen start (a match a cut may have faked is skipped). */
const KNOWN_SHAPES_EVERYWHERE: readonly RegExp[] = KNOWN_SHAPES.map(shape => new RegExp(shape.source, 'gu'));

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
 * really before it — and is searched from its SECOND character: the borrowed one is context only, never the start of a
 * match. (A match let start there would be fake, since that character's own boundary is unknown; and skipping it after
 * it was found was not enough, because the search goes on after the END of a match, and a fake one could swallow a
 * real key that starts inside it: `sk-ant-AAAA-sk-ant-…` with the first `s` borrowed.) A shape at the borrowed
 * character is found by the previous window, where it began a full overlap before the end.
 *
 * A match running into a cut may be ending only because the window does, so one that also begins inside the next
 * window's own region is skipped: it is whole, with its true context, in that window. Nothing after it is lost — the
 * search resumes at the cut, and any match after it would begin in that region too.
 */
function holdsKnownShape(text: string): boolean {
  if (text.length <= SCAN_WINDOW) return KNOWN_SHAPES.some(shape => shape.test(text));
  const step = SCAN_WINDOW - SCAN_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    const from = start === 0 ? 0 : start - 1;
    const window = text.slice(from, start + SCAN_WINDOW);
    const last = start + SCAN_WINDOW >= text.length;
    for (const shape of KNOWN_SHAPES_EVERYWHERE) {
      shape.lastIndex = start - from;
      for (let match = shape.exec(window); match !== null; match = shape.exec(window)) {
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
  if (typeof key !== 'string' || !endsInCredentialWord(key)) return false;
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

// ── A raw secret given to a flag (CFG-LEAK-W) ────────────────────────────────────────────────────────────────────────

/**
 * A raw secret given to a flag, found by the write rule: where it is, and a digest of `<name>\0<value>`. The digest is
 * in memory only — it tells a write whether a finding is one the file on disk already holds — and is never returned,
 * logged or put in an issue.
 */
export interface FlagFinding {
  readonly path: readonly (string | number)[];
  readonly digest: string;
}

/** A word that is exactly a flag: one or two dashes and a name, no value in it. */
const FLAG_ONLY = /^-{1,2}([A-Za-z0-9][A-Za-z0-9_.-]*)$/u;

/** A flag glued to its value by `=`: `--token=v`, `-k=v`. */
const FLAG_GLUED = /^-{1,2}([A-Za-z0-9][^=\s]*)=([\s\S]*)$/u;

/** A word that starts with `NAME=` or `NAME:` and a value: `API_KEY=v`, `Authorization: Bearer v`. */
const NESTED_PAIR = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*([\s\S]*)$/u;

/** A header's name that is a credential by itself, whatever it ends in. */
const CREDENTIAL_HEADER = /^(?:authorization|cookie)$/iu;

/** The scheme word an `Authorization` value may start with; the credential is what follows it. */
const AUTH_SCHEME = /^(?:bearer|basic|token)[ \t]+/iu;

/** One pair of matching quotes around a value. */
const QUOTED_VALUE = /^(["'])([\s\S]*)\1$/u;

/** The shortest URL password the rule judges: a URL password has no entropy convention (E6). */
const MIN_URL_PASSWORD = 8;

/** White space in a string, and a run of it to split at. */
const ANY_BLANK = /\s/u;
const BLANK_RUNS = /\s+/u;

const flagDigest = (name: string, value: string): string =>
  createHash('sha256').update(`${name.toLowerCase()}\0${value}`, 'utf8').digest('hex');

/** The value as the secret test reads it: unquoted, and past an `Authorization` scheme word. */
function secretPart(value: string): string {
  const inner = QUOTED_VALUE.exec(value)?.[2] ?? value;
  return inner.trim().replace(AUTH_SCHEME, '');
}

/** The pairs of one word: `[name, value]` of each raw secret it gives to a flag. `next` is the word after it, if any. */
function pairsOf(
  word: string,
  next: string | undefined,
): readonly { readonly name: string; readonly value: string; readonly onNext: boolean }[] {
  const pairs: { name: string; value: string; onNext: boolean }[] = [];
  const judged = (name: string, value: string, onNext = false): void => {
    const secret = secretPart(value);
    if (looksLikeRawSecret('token', secret)) pairs.push({ name, value: secret, onNext });
  };
  // A value that holds a nested key, from a flag or on its own: `--header=Authorization: Bearer v`, `API_KEY=v`.
  const nested = (text: string): void => {
    const pair = NESTED_PAIR.exec(text);
    const name = pair?.[1] ?? '';
    if (namesCredential(name) || CREDENTIAL_HEADER.test(name)) judged(name, pair?.[2] ?? '');
  };
  const glued = FLAG_GLUED.exec(word);
  if (glued !== null) {
    const [, name = '', value = ''] = glued;
    if (namesCredential(name)) judged(name, value);
    nested(value);
  }
  const flag = FLAG_ONLY.exec(word);
  if (flag !== null && next !== undefined && !next.startsWith('-') && namesCredential(flag[1] ?? ''))
    judged(flag[1] ?? '', next, true);
  nested(word);
  for (const [from, to] of urlPasswordCuts(word)) {
    const password = word.slice(from, to);
    // The mask's own stand-in is no password: a cut URL is not a finding (the net in `shownConfigText` reads shown text).
    if (to - from >= MIN_URL_PASSWORD && password !== HIDDEN_VALUE_TEXT)
      pairs.push({ name: 'password', value: password, onNext: false });
  }
  return pairs;
}

/**
 * Every raw secret a document gives to a FLAG (CFG-LEAK-W), by place and digest.
 *
 * Every list of strings, at any key and any depth, is a command line read as words; every string with blanks outside a
 * list is split into words at them; every other string is one word. A string with blanks is judged as a whole too, so
 * a nested key written with its blank (`Authorization: Bearer v`) is seen. Per word:
 * - **W1** `--token=v`, **W2** `--token` then `v` (the next word does not start with `-`);
 * - **W3** a nested `NAME=v` or `NAME: v` (`-e API_KEY=v`, `Authorization: Bearer v`), also inside a W1 or W2 value;
 * - **W4** a URL's user password (`scheme://user:PASS@host`) of at least {@link MIN_URL_PASSWORD} characters.
 *
 * The NAME test is the one a raw-secret key uses ({@link endsInCredentialWord}, shared with the read mask) on the name with its dashes stripped, or
 * `Authorization` / `Cookie` as a nested key: `--token`, `--api-key`, `--client-secret`, `--password`, `--key` count;
 * `--token-file`, `--auth`, `--auth-mode`, `--header` and a one-letter flag do not. The VALUE test is
 * {@link looksLikeRawSecret} past its name gate: unquoted, at least 16 characters, no white space, no pointer
 * (`${secret:NAME}`, `$NAME`, `${NAME}`), no path or URL, entropy 3.5. A read mask may over-hide; a write rule must not
 * over-refuse, so this is the narrow, certain one, and every pair it finds is also cut by the read mask.
 *
 * Linear in the document: each word is read a bounded number of times, whatever it holds.
 */
export function findFlagSecrets(document: unknown): readonly FlagFinding[] {
  const found = new Map<string, FlagFinding>();
  const add = (path: readonly (string | number)[], name: string, value: string): void => {
    const digest = flagDigest(name, value);
    found.set(JSON.stringify([path, digest]), { path, digest });
  };
  const judge = (
    word: string,
    next: string | undefined,
    path: readonly (string | number)[],
    nextPath: readonly (string | number)[],
  ): void => {
    for (const pair of pairsOf(word, next)) add(pair.onNext ? nextPath : path, pair.name, pair.value);
  };
  /** One string: as a whole, and — with blanks in it — as the words it is made of. */
  const judgeString = (
    text: string,
    next: string | undefined,
    path: readonly (string | number)[],
    nextPath: readonly (string | number)[],
  ): void => {
    judge(text, next, path, nextPath);
    if (!ANY_BLANK.test(text)) return;
    const words = text.split(BLANK_RUNS).filter(word => word !== '');
    words.forEach((word, index) => {
      judge(word, words[index + 1], path, path);
    });
  };
  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (typeof value === 'string') {
      judgeString(value, undefined, path, path);
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => {
        const here = [...path, index];
        if (typeof item === 'string') {
          const after = value[index + 1];
          judgeString(item, typeof after === 'string' ? after : undefined, here, [...path, index + 1]);
        } else visit(item, here);
      });
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(document, []);
  return [...found.values()];
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

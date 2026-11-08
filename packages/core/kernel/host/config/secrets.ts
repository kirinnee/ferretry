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

/** A key whose value is a credential by its name. */
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;

/** A value that names a secret rather than holding one: `${secret:NAME}`, `${NAME}` or `$NAME`. */
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;

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

/** Whether `value`, found under `key`, looks like a raw secret. */
export function looksLikeRawSecret(key: string | number | undefined, value: string): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key)) return false;
  const trimmed = value.trim();
  if (REFERENCE.test(trimmed) || trimmed.length < MIN_SECRET_LENGTH || /\s/u.test(trimmed)) return false;
  // A path or a URL under a "…key" name (a key file, a JWKS endpoint) is where a secret is, not one.
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
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

/** A line's `key: value`, the key and the value without quotes or a list dash: enough to ask {@link looksLikeRawSecret}. */
const KEY_VALUE_LINE = /^\s*(?:-\s+)?["']?([^:"'#]+?)["']?\s*:\s*["']?(.+?)["']?\s*$/u;

/** What a secret found only in the raw text is, in one sentence that never includes it: a comment or a tag counts. */
export const RAW_TEXT_SECRET_MESSAGE =
  'this line looks like it holds a raw secret (an API key or token) — a comment or a tag counts';

/**
 * The first line (1-based) of the RAW TEXT of a file that holds anything shaped like a secret, or `undefined`. It
 * scans what {@link findRawSecrets} cannot: a file that does not parse, and a comment or a tag of one that does (the
 * parsed walk sees values only). Line by line: a known key shape anywhere on the line, or a high-entropy value under a
 * key that names a credential. It answers a line number and nothing else: never WHAT is there.
 */
export function rawTextSecretLine(text: string): number | undefined {
  const index = text.split(/\r?\n/u).findIndex(line => {
    if (looksLikeRawSecret(undefined, line)) return true;
    const pair = KEY_VALUE_LINE.exec(line);
    return pair?.[1] !== undefined && pair[2] !== undefined && looksLikeRawSecret(pair[1], pair[2]);
  });
  return index < 0 ? undefined : index + 1;
}

/** Whether {@link rawTextSecretLine} finds a line: a caller that gets `true` withholds the text. */
export function rawTextHoldsSecret(text: string): boolean {
  return rawTextSecretLine(text) !== undefined;
}

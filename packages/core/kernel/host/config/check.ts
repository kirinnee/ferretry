/**
 * One configuration file, checked: does it parse, does it hold a raw secret, does it satisfy its schema — every
 * problem located to a line and column and said with a plain fix. This is the one check every editor gets: the
 * daemon on every reload and every write. Today's `checkConfigFile`, taken from the fixed list of kinds to a
 * plugin's own `defineConfig` schema.
 *
 * Pure.
 */
import type { z } from 'zod';
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import { HIDDEN_VALUE_TEXT } from './secret-words.ts';
import {
  findFlagSecrets,
  findRawSecrets,
  RAW_SECRET_KEY_MESSAGE,
  RAW_SECRET_MESSAGE,
  RAW_TEXT_SECRET_MESSAGE,
  rawSecretFix,
  rawTextSecretLine,
} from './secrets.ts';
import {
  CONFIG_TOO_LARGE,
  configTextTooLarge,
  MAX_SYNTAX_ERRORS,
  readConfigText,
  type TextPosition,
} from '@ferretry/std/yaml';

/** A located finding. */
export interface ConfigIssue {
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
}

export interface CheckedConfigText {
  readonly ok: true;
  readonly value: unknown;
  /** The plain value as written, before defaults: what a comment-keeping edit starts from. */
  readonly written: unknown;
  readonly text: string;
}

/** Why a file did not check, so a write can say `refused` with the right reason. */
export type ConfigRefusal = 'yaml' | 'raw_secret' | 'schema';

export interface RefusedConfigText {
  readonly ok: false;
  readonly reason: ConfigRefusal;
  readonly issues: readonly ConfigIssue[];
}

/**
 * The most problems one answer lists. A file of 256 KiB can hold a hundred thousand of them (every line a wrong value),
 * and each is located in the file and said to whoever asked — an agent's context, a log line, an editor's list: the
 * first {@link MAX_CONFIG_ISSUES} are, and the rest are counted in ONE fixed sentence ({@link moreIssues}) that says
 * nothing of them. Only the listed ones are ever located, so the cost of an answer does not grow with the count.
 */
export const MAX_CONFIG_ISSUES = MAX_SYNTAX_ERRORS;

/** The most names one "remove these keys" problem repeats; the rest are counted. */
const MAX_NAMED_KEYS = 10;

const problems = (count: number): string => `${String(count)} more ${count === 1 ? 'problem' : 'problems'}`;

/** The one issue that stands for every problem not listed: a count and nothing of what they are. */
export const moreIssues = (path: string, count: number): ConfigIssue => ({
  path,
  severity: 'error',
  message: `and ${problems(count)} not listed here`,
  fix: 'fix the problems listed, then check the file again to see the rest',
});

/** {@link moreIssues}'s sentence, read back for its count. */
const MORE_ISSUES = /^and (\d{1,9}) more problems? not listed here$/u;

/** How many problems `issues` stand for: one each, and a {@link moreIssues} for the count it carries. */
export function countProblems(issues: readonly { readonly message: string }[]): number {
  return issues.reduce((count, issue) => count + Number(MORE_ISSUES.exec(issue.message)?.[1] ?? 1), 0);
}

/**
 * The first {@link MAX_CONFIG_ISSUES} of `found`, each made an issue by `issueOf` — the rest are never looked at, only
 * counted, in one {@link moreIssues} at the end. `counted` is how many more the source never handed over.
 */
function cappedIssues<T>(
  path: string,
  found: readonly T[],
  issueOf: (item: T) => ConfigIssue,
  counted = 0,
): { readonly issues: readonly ConfigIssue[] } {
  const listed = found.slice(0, MAX_CONFIG_ISSUES).map(issueOf);
  const omitted = found.length - listed.length + counted;
  return { issues: omitted === 0 ? listed : [...listed, moreIssues(path, omitted)] };
}

const at = (position: TextPosition | undefined): Pick<ConfigIssue, 'line' | 'column'> =>
  position === undefined ? {} : { line: position.line, column: position.column };

/** A dotted path a person can find in the file: `env.ANTHROPIC_AUTH_TOKEN`, `contents[2]`. */
export function describePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === 'number' ? `${text}[${String(part)}]` : text === '' ? String(part) : `${text}.${String(part)}`,
    '',
  );
}

/** The most characters of one key an answer quotes; a longer key is cut there and its length said. */
const MAX_KEY_CHARACTERS = 64;

/** A key, quoted — or its first {@link MAX_KEY_CHARACTERS} characters and its length, when it is longer. */
const quotedKey = (key: string): string =>
  key.length <= MAX_KEY_CHARACTERS
    ? `"${key}"`
    : `"${key.slice(0, MAX_KEY_CHARACTERS)}…" (${String(key.length)} characters)`;

/**
 * At most {@link MAX_NAMED_KEYS} keys, each quoted to at most {@link MAX_KEY_CHARACTERS} characters, and how many more
 * there are: one answer holds a few hundred characters of names, whatever the file's keys are (a 256 KiB key was
 * repeated twice, 525 KiB, before).
 */
function namedKeys(keys: readonly string[]): string {
  const named = keys.slice(0, MAX_NAMED_KEYS).map(quotedKey).join(', ');
  return keys.length > MAX_NAMED_KEYS ? `${named} and ${String(keys.length - MAX_NAMED_KEYS)} more` : named;
}

/** The plain fix for one schema issue. Specific where the cause is common, the message itself otherwise. */
function fixFor(issue: z.core.$ZodIssue, where: string): string {
  if (issue.code === 'unrecognized_keys') {
    return `remove ${namedKeys(issue.keys)}${where === '' ? '' : ` from ${where}`} — this file has no such setting`;
  }
  if (issue.code === 'invalid_type' && /received undefined$/u.test(issue.message)) {
    return `add "${String(issue.path.at(-1) ?? '')}" — it is required`;
  }
  if (issue.code === 'custom') return `correct ${where === '' ? 'the file' : where}`;
  return where === '' ? `change the file: ${issue.message}` : `change ${where}: ${issue.message}`;
}

/**
 * What a schema issue says: zod's words, except that a long list of unknown keys names only the first few, and a key
 * longer than {@link MAX_KEY_CHARACTERS} is cut (zod quotes every key whole).
 */
function messageOf(issue: z.core.$ZodIssue): string {
  if (
    issue.code === 'unrecognized_keys' &&
    (issue.keys.length > MAX_NAMED_KEYS || issue.keys.some(key => key.length > MAX_KEY_CHARACTERS))
  )
    return `Unrecognized ${issue.keys.length === 1 ? 'key' : 'keys'}: ${namedKeys(issue.keys)}`;
  return issue.message;
}

/**
 * Whether a schema found a secret in a file: ANY issue is a custom issue its schema marked `params: { rawSecret: true }`,
 * whatever else is wrong with the file (a typo key, a bad reference). Any plugin may mark an issue, so a rule that lives in a
 * schema (a login's environment) is handled as a raw key the kernel's own scan found, which also wins over every schema fault:
 * the file's text is never shown to an agent. The unmarked issues stay in the list; they quote no value.
 */
function markedRawSecret(error: z.ZodError): boolean {
  return error.issues.some(issue => issue.code === 'custom' && issue.params?.rawSecret === true);
}

/** The issues a failed schema parse means, the first {@link MAX_CONFIG_ISSUES} each located in the file. */
function schemaIssues(
  path: string,
  error: z.ZodError,
  locate: (path: readonly PropertyKey[]) => TextPosition | undefined,
): RefusedConfigText {
  return {
    ok: false,
    reason: markedRawSecret(error) ? 'raw_secret' : 'schema',
    ...cappedIssues(path, error.issues, issue => {
      const site = issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys.slice(0, 1)] : issue.path;
      const where = describePath(issue.path);
      const message = messageOf(issue);
      return {
        path,
        ...at(locate(site)),
        severity: 'error' as const,
        message: where === '' || issue.code === 'custom' ? message : `${where}: ${message}`,
        fix: fixFor(issue, where),
      };
    }),
  };
}

/** Check one file's text against the schema its definition declares. */
export function checkConfigText(
  def: ConfigDef,
  path: string,
  text: string,
  binary: string,
): CheckedConfigText | RefusedConfigText {
  // Bounded before ANY reading — parse, alias walk, raw scan: a text over the cap is refused in one fixed sentence and
  // nothing else is said about it (a scan of it could only cost, and the sentence never quotes it).
  if (configTextTooLarge(text)) {
    return {
      ok: false,
      reason: 'yaml',
      issues: [{ path, severity: 'error', message: CONFIG_TOO_LARGE, fix: 'make the file smaller' }],
    };
  }
  return checkReadConfigText(def, path, text, binary, readConfigText(text));
}

/**
 * {@link checkConfigText} of a text under the cap that the caller has already read: a read that both checks and masks a
 * text (`shown-text.ts`) parses it once, whether the check passes or not.
 */
export function checkReadConfigText(
  def: ConfigDef,
  path: string,
  text: string,
  binary: string,
  read: ReturnType<typeof readConfigText>,
): CheckedConfigText | RefusedConfigText {
  if (!read.ok) {
    // A key in text that does not parse (in an undeclared tag handle, say) is refused as a key, by line only: the
    // first thing said about such a file is that it holds one, never anything quoted from around it.
    const held = rawTextIssue(path, text, binary);
    if (held !== undefined) return held;
    return {
      ok: false,
      reason: 'yaml',
      ...cappedIssues(
        path,
        read.errors,
        error => ({
          path,
          ...at(error.position),
          severity: 'error' as const,
          message: `this is not valid YAML: ${error.message}`,
          fix: 'correct the YAML at that line — check the indentation, and quote a value that holds a colon',
        }),
        read.omitted,
      ),
    };
  }
  const secrets = findRawSecrets(read.read.value);
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: 'raw_secret',
      ...cappedIssues(path, secrets, finding => ({
        path,
        ...at(read.read.locate(finding.atKey ?? finding.path)),
        severity: 'error' as const,
        // The path to the value, never the value: a secret pasted by mistake travels no further than its file.
        // For a secret-shaped NAME the path stops at the object that holds it, so the name is never repeated.
        message:
          finding.atKey === undefined
            ? `${describePath(finding.path)}: ${RAW_SECRET_MESSAGE}`
            : `${describePath(finding.path) || 'the top of the file'}: ${RAW_SECRET_KEY_MESSAGE}`,
        fix: rawSecretFix(binary),
      })),
    };
  }
  // The walk above sees parsed VALUES only, so a key left in a comment or a tag is found on the raw text: refused the same.
  const held = rawTextIssue(path, text, binary);
  if (held !== undefined) return held;
  // A schema that THROWS (a plugin's rule hit a value it did not expect) must not stop a reload, which the host awaits
  // unguarded: the file is invalid, and the error's words (which could quote the value) are never kept.
  let parsed: ReturnType<typeof def.schema.safeParse>;
  try {
    parsed = def.schema.safeParse(read.read.value);
  } catch {
    return {
      ok: false,
      // A def of credential records could not judge the file, so its text is withheld as for a raw secret.
      reason: def.credentialRecords === true ? 'raw_secret' : 'schema',
      issues: [
        {
          path,
          severity: 'error',
          message: 'this file could not be checked',
          fix: 'correct the file, or tell whoever maintains this setting',
        },
      ],
    };
  }
  if (!parsed.success) return schemaIssues(path, parsed.error, read.read.locate);
  return { ok: true, value: parsed.data, written: read.read.value, text };
}

// ── The rules of a WRITE (CFG-LEAK-W) ────────────────────────────────────────────────────────────────────────────────
// Not part of `checkConfigText`: that is the check every reload runs, and a rule added there would make a file that
// already holds one invalid at the next reload. These two run only where a text is about to be put on disk.

/** How many times `mark` is in `text`. */
function countOf(text: string, mark: string): number {
  let count = 0;
  for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + mark.length)) count += 1;
  return count;
}

/** The line (1-based) of the `nth` (1-based) `mark` in `text`. */
function lineOfNth(text: string, mark: string, nth: number): number {
  let at = -mark.length;
  for (let seen = 0; seen < nth; seen += 1) at = text.indexOf(mark, at + mark.length);
  return text.slice(0, at).split('\n').length;
}

/** A string of a value that holds `‹hidden›` (a key's own name included), and the place it is at. */
interface MarkedString {
  readonly place: string;
  readonly path: readonly (string | number)[];
  readonly text: string;
}

/** Every string of a value that holds `‹hidden›`, a key's name included. Linear in the value. */
function markedStrings(value: unknown): readonly MarkedString[] {
  const found: MarkedString[] = [];
  const visit = (node: unknown, path: readonly (string | number)[]): void => {
    if (typeof node === 'string') {
      if (node.includes(HIDDEN_VALUE_TEXT)) found.push({ place: JSON.stringify(['value', path]), path, text: node });
    } else if (Array.isArray(node)) {
      node.forEach((item: unknown, index) => {
        visit(item, [...path, index]);
      });
    } else if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        const here = [...path, key];
        if (key.includes(HIDDEN_VALUE_TEXT))
          found.push({ place: JSON.stringify(['key', here]), path: here, text: key });
        visit(item, here);
      }
    }
  };
  visit(value, []);
  return found;
}

/**
 * W0: the mask is never written back. A text that holds MORE `‹hidden›` than the text on disk was made from a read that
 * hid a value, and saving it would write the mask over the value. "More", not "any": a file that already holds the
 * literal (in a comment, say) stays editable. A value that holds one where the disk value at the same place does not is
 * refused too, so a mark in a comment on disk never lets a mask through. Refused as `schema` at the line of the first one
 * in excess.
 */
function hiddenMarkRefusal(
  path: string,
  text: string,
  written: unknown,
  prior: string | undefined,
): RefusedConfigText | undefined {
  if (!text.includes(HIDDEN_VALUE_TEXT)) return undefined;
  const before = prior === undefined ? 0 : countOf(prior, HIDDEN_VALUE_TEXT);
  // Fewer or as many marks as on disk is not enough: one in a comment on disk must not let a value that holds one
  // where the disk value did not (the mask of a value the reader was shown) through. Each value that holds one is the
  // same string at the same place on disk, or the text is refused at its line.
  const readPrior = prior === undefined ? undefined : readConfigText(prior);
  const onDisk = new Map(
    (readPrior?.ok === true ? markedStrings(readPrior.read.value) : []).map(marked => [marked.place, marked.text]),
  );
  const excess = markedStrings(written).find(marked => onDisk.get(marked.place) !== marked.text);
  const counted = countOf(text, HIDDEN_VALUE_TEXT) > before;
  if (!counted && excess === undefined) return undefined;
  const read = excess === undefined ? undefined : readConfigText(text);
  const located = read?.ok === true && excess !== undefined ? read.read.locate(excess.path) : undefined;
  return {
    ok: false,
    reason: 'schema',
    issues: [
      {
        path,
        line: located?.line ?? lineOfNth(text, HIDDEN_VALUE_TEXT, before + 1),
        column: 1,
        severity: 'error',
        message: `a value hidden from the device or agent that read this file is still ${HIDDEN_VALUE_TEXT} here; nothing was written`,
        fix: `type the real value at the machine, or replace ${HIDDEN_VALUE_TEXT} with \${secret:NAME}`,
      },
    ],
  };
}

/**
 * W: a raw secret given to a flag (`findFlagSecrets`) that the text on disk does not already hold. NEW-ONLY: a file that
 * already holds one keeps loading and keeps every write that leaves it as it is; one more, one moved to another file or
 * one whose value changed is refused `raw_secret`, one issue each (located, capped), never repeating the value.
 */
function flagSecretRefusal(
  path: string,
  text: string,
  written: unknown,
  prior: string | undefined,
  binary: string,
): RefusedConfigText | undefined {
  const found = findFlagSecrets(written);
  if (found.length === 0) return undefined;
  const readPrior = prior === undefined ? undefined : readConfigText(prior);
  const known = new Set(
    (readPrior?.ok === true ? findFlagSecrets(readPrior.read.value) : []).map(finding => finding.digest),
  );
  const added = found.filter(finding => !known.has(finding.digest));
  if (added.length === 0) return undefined;
  const read = readConfigText(text);
  return {
    ok: false,
    reason: 'raw_secret',
    ...cappedIssues(path, added, finding => ({
      path,
      ...at(read.ok ? read.read.locate(finding.path) : undefined),
      severity: 'error' as const,
      // The path to the value, never the value.
      message: `${describePath(finding.path)}: this looks like a raw secret given to a flag (an API key, token or password)`,
      fix: rawSecretFix(binary),
    })),
  };
}

/**
 * What a text may not be when it is about to be put on disk, beyond {@link checkConfigText}: it writes the read mask back
 * (W0), or it gives a raw secret to a flag the file on disk does not already hold (W). `written` is the plain value of
 * the text, which passed its check; `prior` is the text on disk before this write (`undefined` when there is none).
 */
export function writeRefusal(
  path: string,
  text: string,
  written: unknown,
  prior: string | undefined,
  binary: string,
): RefusedConfigText | undefined {
  return hiddenMarkRefusal(path, text, written, prior) ?? flagSecretRefusal(path, text, written, prior, binary);
}

/** A raw key anywhere in the text — a comment, a tag, an anchor, a line that does not parse — refused by its line alone. */
function rawTextIssue(path: string, text: string, binary: string): RefusedConfigText | undefined {
  const line = rawTextSecretLine(text);
  if (line === undefined) return undefined;
  return {
    ok: false,
    reason: 'raw_secret',
    issues: [{ path, line, column: 1, severity: 'error', message: RAW_TEXT_SECRET_MESSAGE, fix: rawSecretFix(binary) }],
  };
}

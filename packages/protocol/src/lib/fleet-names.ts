/**
 * The names of a login and of the runtime made on it (docs/design/account-model.md §4.6).
 *
 * ONE OWNER, MANY READERS. The Add a login page, Add a runtime, setup, `fy login add`, the first-run
 * import and the daemon all name the same two things, and they used to disagree: one added the harness
 * prefix twice (`claude-claude-default`), another never added it. The prefix is added ONCE, here.
 *
 * Pure and total: no I/O, no clock, every input is a string.
 */

export type NamedHarness = 'claude' | 'codex';

/** The longest id a login can have, and the room left for a `-2`, `-3`… suffix. */
const LOGIN_ID_LIMIT = 64;
const SUFFIX_ROOM = 3;

/** The most characters a person-chosen login name may have. */
export const LOGIN_NAME_MAX = 40;

/** What each CLI is called in a sentence. */
export const NAMED_HARNESS_WORDS: Readonly<Record<NamedHarness, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** `claude` + `default` → `claude-default`; `claude` + `claude-default` → `claude-default`. */
export const harnessPrefixed = (harness: NamedHarness, word: string): string =>
  word === harness || word.startsWith(`${harness}-`) ? word : `${harness}-${word}`;

/** Letters, digits and dashes, lower case. */
export const nameSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/** The first free `<base>`, `<base>-2`, `<base>-3`, … */
const firstFree = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** The id a new login gets: the harness prefix once, the slug of its name, then `-2`… until free. */
export const loginIdFor = (harness: NamedHarness, name: string | undefined, taken: ReadonlySet<string>): string => {
  const base = harnessPrefixed(harness, nameSlug(name ?? '') || 'login')
    .slice(0, LOGIN_ID_LIMIT - SUFFIX_ROOM)
    .replace(/-+$/u, '');
  return firstFree(base, taken);
};

/** A runtime named after what it runs on (a login id or a profile): the prefix once, then `-2`… until free. */
export const runtimeNameFor = (harness: NamedHarness, base: string, taken: ReadonlySet<string>): string =>
  firstFree(harnessPrefixed(harness, nameSlug(base) || 'runtime'), taken);

/** A login as far as naming cares. */
export interface NamedLogin {
  readonly id?: string;
  readonly harness: NamedHarness;
  readonly label?: string | undefined;
  readonly email?: string | undefined;
}

const sameLabel = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();

/** The other logins of this CLI, leaving out the one being renamed. */
const othersOf = (harness: NamedHarness, logins: readonly NamedLogin[], exceptId?: string): readonly NamedLogin[] =>
  logins.filter(login => login.harness === harness && (exceptId === undefined || login.id !== exceptId));

/** Whether another login of this CLI already has this label (trimmed, case-insensitive). */
export const loginLabelTaken = (
  name: string,
  harness: NamedHarness,
  logins: readonly NamedLogin[],
  exceptId?: string,
): boolean =>
  name.trim() !== '' && othersOf(harness, logins, exceptId).some(login => sameLabel(login.label ?? '', name));

/** The daemon's refusal for a label another login of this CLI has. */
export const loginLabelTakenSentence = (name: string, harness: NamedHarness): string =>
  `You already have a ${NAMED_HARNESS_WORDS[harness]} login named ${name.trim()}.`;

/** Whether the Add a login page must be given a name: the machine already has a login of this CLI. */
export const loginNameRequired = (harness: NamedHarness, logins: readonly NamedLogin[]): boolean =>
  othersOf(harness, logins).length > 0;

/**
 * Why a login name cannot be used, as one sentence, or `null`. The name is required when another login of
 * this CLI already exists, and optional for the first.
 */
export const loginNameProblem = (name: string, harness: NamedHarness, logins: readonly NamedLogin[]): string | null => {
  const trimmed = name.trim();
  if (trimmed === '')
    return loginNameRequired(harness, logins) ? 'Give it a name so you can tell the two apart.' : null;
  if (trimmed.length > LOGIN_NAME_MAX) return `Keep it to ${String(LOGIN_NAME_MAX)} characters.`;
  if (nameSlug(trimmed) === '') return 'Use at least one letter or digit.';
  if (loginLabelTaken(trimmed, harness, logins))
    return `You already have a ${NAMED_HARNESS_WORDS[harness]} login named ${trimmed}. Pick another name.`;
  return null;
};

/** Where a person who is already signed in to the wrong account is told what to do. */
export const SIGN_IN_OTHER_ACCOUNT_TIP: Readonly<Record<NamedHarness, string>> = {
  claude:
    'Already signed in to Claude in this browser as someone else? Open the link in a private window, or sign out of claude.ai first.',
  codex:
    'Already signed in to ChatGPT in this browser as someone else? Open the link in a private window, or sign out of chatgpt.com first.',
};

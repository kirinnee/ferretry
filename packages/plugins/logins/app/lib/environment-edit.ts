/**
 * Editing a login's environment, the pure half. A row is one variable on screen; {@link envChange} turns the rows into
 * ONE `login.env` change, or says in one sentence why it cannot.
 *
 * REFERENCES ONLY. A secret is never typed here: a value that looks like a key, or an address holding one, is refused
 * BEFORE any request, by the same detector the daemon applies to a login file, and the sentence names the VARIABLE and
 * never the value. A variable the page shows as a secret or as hidden has no value on this screen; it is sent as
 * `{ keep: true }` unless the person typed a replacement (a `${secret:NAME}` reference). A replacement they typed that
 * was emptied before Save (`wiped`) is refused instead: a silent keep would drop what they meant to apply.
 */

import {
  type LoginChange,
  type LoginEnvironment,
  nameLooksLikeKey,
  RESERVED_LOGIN_ENV_NAMES,
  storedEnvironmentIssue,
} from '../../contract/index.ts';

/** One variable on screen. `new` is a row the person added; its name is theirs to type. */
export interface EditRow {
  /** Stable for as long as the row is on screen, so typing in one never moves another's input. */
  readonly key: string;
  readonly name: string;
  readonly kind: 'plain' | 'secret' | 'hidden' | 'new';
  /** A plain value, or what the person typed. Empty for a secret or hidden one that is kept as it is. */
  readonly value: string;
  readonly removed: boolean;
  /**
   * The person typed a value into this masked row and it was emptied since (the page was hidden, or a held change
   * took it). Such a row is refused at Save, never sent as "keep": the person meant to replace it.
   */
  readonly wiped?: boolean;
}

type EnvChange = Extract<LoginChange, { kind: 'login.env' }>;

export type EnvEdit =
  | { readonly kind: 'change'; readonly change: EnvChange }
  | { readonly kind: 'refused'; readonly sentence: string };

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The rows the editor starts from: every variable the login has, a plain one with its value. */
export const editRows = (environment: LoginEnvironment): readonly EditRow[] =>
  environment.variables.map(variable => ({
    key: `variable:${variable.name}`,
    name: variable.name,
    kind: variable.kind,
    value: variable.kind === 'plain' ? variable.value : '',
    removed: false,
  }));

/** Whether the rows differ from where the editor started. */
export const rowsChanged = (before: readonly EditRow[], after: readonly EditRow[]): boolean =>
  before.length !== after.length ||
  after.some(row => {
    const first = before.find(candidate => candidate.name === row.name && candidate.kind === row.kind);
    return first === undefined || first.value !== row.value || first.removed !== row.removed;
  });

/** What a value may not be, in words. Names the variable, never the value. */
const issueSentence = (name: string, issue: 'secret' | 'userinfo' | 'query'): string =>
  issue === 'secret'
    ? `${name} looks like a key. Keys are not typed here: put it in Settings › Secrets and write its NAME as \${secret:NAME}.`
    : `${name} is an address holding a ${issue === 'userinfo' ? 'password' : 'key in its query string'}. Write it without that and keep it in Settings › Secrets.`;

const refused = (sentence: string): EnvEdit => ({ kind: 'refused', sentence });

/** The `login.env` change the rows mean, or the one sentence that says why not. */
export function envChange(loginId: string, rows: readonly EditRow[]): EnvEdit {
  // A Map, not a literal: a variable may be called `__proto__` or `constructor`, and a plain object would lose or misjudge it.
  const env = new Map<string, string | { readonly keep: true }>();
  for (const row of rows) {
    if (row.removed) continue;
    const name = row.kind === 'new' ? row.name.trim() : row.name;
    if (row.kind === 'new' && name === '' && row.value.trim() === '' && row.wiped !== true) continue;
    if (name === '') return refused('A new variable needs a name.');
    // A name that failed the check is never repeated: it is free text, and may be a key.
    if (!POSIX_NAME.test(name))
      return refused(
        "The new variable's name is not a variable name: letters, digits and underscores, not starting with a digit.",
      );
    if (nameLooksLikeKey(name))
      return refused(
        `The new variable's name looks like a key. A name is a label: put the key in Settings › Secrets and write its NAME as \${secret:NAME} in the value.`,
      );
    if ((RESERVED_LOGIN_ENV_NAMES as readonly string[]).includes(name))
      return refused(`${name} is reserved: Ferretry sets it for the runtime itself.`);
    if (env.has(name)) return refused(`${name} is listed twice.`);
    if (row.wiped === true && row.value === '') return refused(`${name} needs a value.`);
    if (row.kind === 'new' && row.value.trim() === '') return refused(`${name} needs a value.`);
    if ((row.kind === 'secret' || row.kind === 'hidden') && row.value === '') {
      env.set(name, { keep: true });
      continue;
    }
    const issue = storedEnvironmentIssue(name, row.value);
    if (issue !== undefined) return refused(issueSentence(name, issue));
    env.set(name, row.value);
  }
  return { kind: 'change', change: { kind: 'login.env', id: loginId, env: Object.fromEntries(env) } };
}

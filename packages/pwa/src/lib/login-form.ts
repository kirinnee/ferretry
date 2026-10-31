/**
 * THE SAVED-LOGINS FORMS, AS DECISIONS.
 *
 * What a form may send and what it may not: which fields a put carries, the 2FA seed that needs its tick, the
 * password that is only ever replaced. Pure, so the settings component only draws. A value is an argument and
 * is never returned except inside the one request body.
 */

import {
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_MATCH_MAX,
  LOGIN_PASSWORD_MIN_LENGTH,
  LoginEntryIdSchema,
  type LoginEntrySummary,
  LoginMatchSchema,
  type PutLoginEntryRequest,
  TotpSeedSchema,
} from '@ferretry/protocol';

export const MATCH_HELP =
  'What it is for: program@host (sudo@kirin-box) or a web host (github.com). Separate several with commas.';

/** `sudo@kirin-box, github.com` → the list; blanks dropped, lowercase. */
export const parseMatch = (text: string): readonly string[] =>
  text
    .split(/[,\n]/u)
    .map(part => part.trim().toLowerCase())
    .filter(part => part !== '');

export const matchText = (match: readonly string[]): string => match.join(', ');

export interface NewLoginDraft {
  readonly label: string;
  readonly id: string;
  readonly match: string;
  readonly username: string;
  readonly password: string;
}

/** Why an add cannot go yet, or `undefined`. Shown beside the form so the button and the sentence agree. */
export const newLoginProblem = (draft: NewLoginDraft, held: readonly string[]): string | undefined => {
  if (draft.label.trim() === '' || draft.id === '') return undefined;
  if (draft.label.trim().length > LOGIN_LABEL_MAX_LENGTH)
    return `A label is at most ${LOGIN_LABEL_MAX_LENGTH} characters.`;
  if (!LoginEntryIdSchema.safeParse(draft.id).success)
    return 'A handle is uppercase letters, digits and underscores, starting with a letter.';
  if (held.includes(draft.id)) return `${draft.id} already exists. Pick another handle, or edit that one.`;
  const bad = parseMatch(draft.match).find(entry => !LoginMatchSchema.safeParse(entry).success);
  if (bad !== undefined) return `"${bad}" is not a program@host or a web host.`;
  if (parseMatch(draft.match).length > LOGIN_MATCH_MAX) return `At most ${LOGIN_MATCH_MAX} matches.`;
  if (draft.password !== '' && draft.password.length < LOGIN_PASSWORD_MIN_LENGTH)
    return `A saved password is at least ${LOGIN_PASSWORD_MIN_LENGTH} characters, so it can be masked out of output safely.`;
  return undefined;
};

export const canAddLogin = (draft: NewLoginDraft, held: readonly string[]): boolean =>
  draft.label.trim() !== '' &&
  draft.id !== '' &&
  draft.password.length >= LOGIN_PASSWORD_MIN_LENGTH &&
  newLoginProblem(draft, held) === undefined;

/** The body that creates an entry. An empty username is left out rather than sent blank. */
export const newLoginBody = (draft: NewLoginDraft): PutLoginEntryRequest => ({
  label: draft.label.trim(),
  match: [...parseMatch(draft.match)],
  ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
  password: draft.password,
});

export interface EditLoginDraft {
  readonly label: string;
  readonly match: string;
  readonly username: string;
}

/**
 * The body that edits label, match and username: only what changed is sent, so everything else (the password,
 * a 2FA seed) is kept. An emptied username is `null`, which removes it. `undefined` when nothing changed.
 */
export const editLoginBody = (entry: LoginEntrySummary, draft: EditLoginDraft): PutLoginEntryRequest | undefined => {
  const label = draft.label.trim();
  const match = parseMatch(draft.match);
  const username = draft.username.trim();
  const body: PutLoginEntryRequest = {
    ...(label !== '' && label !== entry.label ? { label } : {}),
    ...(matchText(match) !== matchText(entry.match) ? { match: [...match] } : {}),
    ...(username !== (entry.username ?? '') ? { username: username === '' ? null : username } : {}),
  };
  return Object.keys(body).length === 0 ? undefined : body;
};

/** A new password replaces the old one; it is write-only. */
export const replacePasswordBody = (password: string): PutLoginEntryRequest => ({ password });

export const passwordProblem = (password: string): string | undefined =>
  password !== '' && password.length < LOGIN_PASSWORD_MIN_LENGTH
    ? `At least ${LOGIN_PASSWORD_MIN_LENGTH} characters.`
    : undefined;

/** Whether the seed field holds something the daemon would accept; checked locally for a sentence, not for trust. */
export const seedProblem = (seed: string): string | undefined =>
  seed.trim() === '' || TotpSeedSchema.safeParse(seed).success
    ? undefined
    : 'A 2FA seed is base32 (letters A-Z and digits 2-7), 16 to 128 characters.';

/**
 * Adds a 2FA seed. It needs the explicit tick: without it nothing is built, so a seed can never go in on a
 * stray press. The warning is shown by the form before the tick is offered.
 */
export const addTotpBody = (seed: string, acknowledged: boolean): PutLoginEntryRequest | undefined =>
  acknowledged && seed.trim() !== '' && seedProblem(seed) === undefined
    ? { totp: { seed }, totpAcknowledged: true }
    : undefined;

export const removeTotpBody = (): PutLoginEntryRequest => ({ totp: null });

/** Which secret fields an entry holds, as words: never a value. */
export const fieldWords = (entry: LoginEntrySummary): readonly string[] => [
  entry.fields.password ? 'password ✓' : 'no password',
  entry.fields.totp ? '2FA ✓' : 'no 2FA',
];

/** A handle offered while a label is typed: `GitHub (kirinnee)` → `GITHUB_KIRINNEE`. Editable by the owner. */
export const handleFromLabel = (label: string): string =>
  label
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 64);

/**
 * "SET UP AUTOMATIC CODES", AS DECISIONS (docs/input-requests.md, "Set up automatic codes").
 *
 * The panel under a code card where the owner pastes a 2FA key so Ferretry can make the codes. Everything it decides
 * that is not drawing lives here as a pure function: which account the key is for, what reading the paste came to,
 * whether Save may be pressed, and which sentence a refusal becomes. The component only draws these.
 *
 * NO FUNCTION HERE KEEPS A KEY. The pasted text comes in as an argument; a refusal is a fixed sentence that holds no
 * part of it (the parser's own problems say nothing of the input). The seed is sent once, padded, and the field is
 * cleared the moment the daemon has staged it; what is saved is bound to a passkey for that one stage.
 */

import {
  type AccountList,
  type AccountSummary,
  factorMismatch,
  factorMismatchWords,
  type InputSaved,
  MAX_SEEDS_PER_ACCOUNT,
  type ParsedTotpKey,
  type Place,
  parseTotpInput,
  TWO_FACTOR_ERROR_CODES,
  type TwoFactorSeedSaved,
} from '@ferretry/protocol';
import { grantRefusalNotice } from './grants.ts';

/** The account a key would be saved to, with what the mismatch check reads of it. */
export interface CodesAccount {
  readonly id: AccountSummary['id'];
  readonly label: string;
  readonly username?: string;
  readonly places: readonly Place[];
  /** How many of its keys already hold a seed. */
  readonly seeds: number;
}

/**
 * The accounts a code card's panel may save to: the ones the daemon MATCHED for this card (an offer's `id` is the
 * account's handle), in the daemon's order. An account the daemon did not match is never offered, and the daemon
 * refuses a stage for any other (`not_this_cards_account`), so this only decides what is worth drawing.
 */
export const codesAccounts = (saved: InputSaved | undefined, list: AccountList): readonly CodesAccount[] => {
  const matched = (saved?.offers ?? []).filter(offer => offer.matched);
  const accounts: CodesAccount[] = [];
  for (const offer of matched) {
    const account = list.accounts.find(each => each.id === offer.id);
    if (account === undefined || accounts.some(each => each.id === account.id)) continue;
    accounts.push({
      id: account.id,
      label: account.label,
      ...(account.username === undefined ? {} : { username: account.username }),
      places: list.signIns.filter(signIn => account.signIns.includes(signIn.id)).map(signIn => signIn.place),
      seeds: account.factors.filter(key => key.automatic).length,
    });
  }
  return accounts;
};

/**
 * Which account the panel starts on: the daemon's one-tap choice when it made one, else the only one. With several
 * and no primary the owner picks (`undefined` here), so the panel never guesses an account for a seed.
 */
export const startingAccount = (
  saved: InputSaved | undefined,
  accounts: readonly CodesAccount[],
): CodesAccount | undefined => {
  const primary = saved?.offers.find(offer => offer.primary === true && offer.matched);
  const chosen = primary === undefined ? undefined : accounts.find(account => account.id === primary.id);
  return chosen ?? (accounts.length === 1 ? accounts[0] : undefined);
};

/** "GitHub · kirinnee": how the panel names the account a key goes to. */
export const accountWords = (account: Pick<CodesAccount, 'label' | 'username'>): string =>
  account.username === undefined ? account.label : `${account.label} · ${account.username}`;

/** The panel's heading, collapsed: the account is named, because the key is saved to that one. */
export const panelHeading = (account: Pick<CodesAccount, 'label' | 'username'> | undefined): string =>
  account === undefined ? 'Set up automatic codes' : `Set up automatic codes for ${accountWords(account)}`;

/** What reading the paste came to: the state the form is in before anything is sent. */
export type SeedDraft =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'parsed'; readonly reads: string; readonly parsed: ParsedTotpKey }
  | {
      readonly kind: 'mismatch';
      readonly reads: string;
      readonly words: string;
      readonly parsed: ParsedTotpKey;
    };

/** "6 digits, every 30 seconds · for GitHub · kirinnee": what the parser read, never any of the key. */
const readsWords = (parsed: ParsedTotpKey): string => {
  const { digits, period } = parsed.params;
  const whom = [parsed.issuer, parsed.accountName].filter(part => part !== undefined).join(' · ');
  return `${String(digits)}-digit codes, new every ${String(period)} seconds${whom === '' ? '' : ` · for ${whom}`}`;
};

/**
 * What the pasted text is. The daemon reads it again and decides; this is only the instant feedback, and for the
 * second tick: a key that says it is for another account needs "save it here anyway" BEFORE it is staged.
 */
export const readSeedDraft = (text: string, account: CodesAccount | undefined): SeedDraft => {
  if (text.trim() === '') return { kind: 'empty' };
  const read = parseTotpInput(text);
  if (!read.ok) return { kind: 'invalid', problem: read.error };
  const reads = readsWords(read.value);
  const mismatch =
    account === undefined
      ? undefined
      : factorMismatch({ label: account.label, username: account.username }, account.places, read.value);
  return mismatch === undefined || account === undefined
    ? { kind: 'parsed', reads, parsed: read.value }
    : {
        kind: 'mismatch',
        reads,
        words: factorMismatchWords(read.value, { label: account.label, username: account.username }),
        parsed: read.value,
      };
};

export interface SaveGate {
  readonly draft: SeedDraft;
  readonly account: CodesAccount | undefined;
  readonly warningTick: boolean;
  readonly mismatchTick: boolean;
  readonly busy: boolean;
}

/** Why Save is not pressable, in words, or `undefined` when it is. */
export const saveBlocked = (gate: SaveGate): string | undefined => {
  if (gate.account === undefined) return 'Pick the account this key is for.';
  if (gate.account.seeds >= MAX_SEEDS_PER_ACCOUNT)
    return `${gate.account.label} already has ${String(MAX_SEEDS_PER_ACCOUNT)} keys that make codes: remove one in Settings › Accounts first.`;
  if (gate.draft.kind === 'empty') return 'Paste the key or its otpauth:// link.';
  if (gate.draft.kind === 'invalid') return gate.draft.problem;
  if (!gate.warningTick) return 'Tick the box to say you read the warning.';
  if (gate.draft.kind === 'mismatch' && !gate.mismatchTick) return 'Tick the second box to save it here anyway.';
  if (gate.busy) return 'Saving…';
  return undefined;
};

/**
 * The ticks the daemon is told. The warning tick is always `true` (the daemon refuses without it); the mismatch tick
 * only when this key says it is for another account and the owner ticked it. Never sent on a key that matches.
 */
export const stageTicks = (gate: Pick<SaveGate, 'draft' | 'mismatchTick'>): { readonly mismatchAcknowledged?: true } =>
  gate.draft.kind === 'mismatch' && gate.mismatchTick ? { mismatchAcknowledged: true } : {};

interface HttpFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Where a passkey is added, in the sentence a refusal for having none says. */
const NEEDS_PASSKEY_WORDS = 'Needs a passkey: add one in Settings › Security, then set this up again.';

/** What a failed stage or save comes to, in the owner's words. None of it repeats anything that was pasted. */
export const seedFailureWords = (error: unknown): string => {
  const failure = (error !== null && typeof error === 'object' ? error : {}) as HttpFailure;
  if (failure.code === TWO_FACTOR_ERROR_CODES.passkeyRequired) return NEEDS_PASSKEY_WORDS;
  if (failure.code === TWO_FACTOR_ERROR_CODES.notThisCardsAccount)
    return 'This card is for another account now. Close the panel and open it again.';
  if (failure.code === TWO_FACTOR_ERROR_CODES.mismatch)
    return 'That key says it is for another account: tick the second box to save it here anyway.';
  if (failure.code === TWO_FACTOR_ERROR_CODES.notAKey) return 'That is not a 2FA key Ferretry can make codes from.';
  if (failure.code === TWO_FACTOR_ERROR_CODES.stageGone)
    return 'The save timed out before it was confirmed. Paste the key and try again.';
  if (failure.code === TWO_FACTOR_ERROR_CODES.tooManyStages)
    return 'Too many keys are waiting to be saved on this machine. Try again in a minute.';
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`;
  if (typeof failure.status === 'number')
    return typeof failure.message === 'string' && failure.message !== '' ? failure.message : 'The daemon refused this.';
  return 'Could not reach the machine. Nothing was saved.';
};

/** The passkey prompt was dismissed: the staged key is dropped, nothing is saved. */
export const DISMISSED_WORDS = 'You did not confirm with your passkey, so nothing was saved.';

/** What a saved key says: that it was saved, and whether the daemon typed its first code into the card. */
export const savedSeedWords = (saved: Pick<TwoFactorSeedSaved, 'typed' | 'mismatch'>, label: string): string =>
  saved.typed === true
    ? `Saved. Ferretry typed the first code for ${label} into the card.`
    : `Saved. Ferretry will make ${label}’s codes from now on.`;

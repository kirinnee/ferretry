/** "Set up automatic codes" as decisions (`app/lib/automatic-codes.ts`): what a paste reads as, when Save may go, what a refusal says. */

import { describe, expect, it } from 'bun:test';
import { InputSavedSchema } from '@ferretry/core-vault/contract';
import { MAX_SEEDS_PER_ACCOUNT, TWO_FACTOR_ERROR_CODES } from '../../../contract/routes/index.ts';
import { list as accountList } from '../../support/app/accounts-fixtures.ts';
import { savedPrimary, savedTwo } from '../../support/app/input-card-fixtures.ts';
import {
  accountWords,
  addKeyActWords,
  codesAccounts,
  type CodesAccount,
  panelHeading,
  readSeedDraft,
  type SaveGate,
  saveBlocked,
  savedSeedWords,
  seedFailureWords,
  type SeedDraft,
  stageTicks,
  startingAccount,
} from '../../../app/lib/automatic-codes.ts';

const SEED = 'JBSWY3DPEHPK3PXP';
const github: CodesAccount = {
  id: 'GITHUB',
  label: 'GitHub',
  username: 'kirinnee',
  places: [{ kind: 'site', domains: ['github.com'], match: [] }],
  seeds: 0,
};

describe('how the panel names the account a key is saved to', () => {
  it('uses the label, and the username when the account has one', () => {
    expect(accountWords(github)).toBe('GitHub · kirinnee');
    expect(accountWords({ label: 'Google' })).toBe('Google');
    expect(addKeyActWords(github)).toBe('save automatic codes to GitHub · kirinnee');
  });

  it('names the account in the heading only once one is picked', () => {
    expect(panelHeading(undefined)).toBe('Set up automatic codes');
    expect(panelHeading(github)).toBe('Set up automatic codes for GitHub · kirinnee');
  });
});

describe('what reading a paste comes to', () => {
  it('is empty for nothing but whitespace', () => {
    expect(readSeedDraft('  \n ', github)).toEqual({ kind: 'empty' });
  });

  it('is invalid, with the parser’s own sentence, for text that is not a key', () => {
    const draft = readSeedDraft('not a key!', github);
    expect(draft).toEqual({
      kind: 'invalid',
      problem:
        'That is not a 2FA key: paste the key itself (letters A to Z and digits 2 to 7, spaces are fine) or an otpauth://totp link.',
    });
    expect(JSON.stringify(draft)).not.toContain('not a key!');
  });

  it('reads a bare key as its default codes, saying nothing of who it is for', () => {
    const draft = readSeedDraft(SEED, github);
    expect(draft.kind).toBe('parsed');
    if (draft.kind === 'parsed') expect(draft.reads).toBe('6-digit codes, new every 30 seconds');
  });

  it('reads who an otpauth link says it is for, and takes a key for this account as a match', () => {
    const draft = readSeedDraft(
      `otpauth://totp/GitHub:kirinnee?secret=${SEED}&issuer=GitHub&digits=8&period=60`,
      github,
    );
    expect(draft.kind).toBe('parsed');
    if (draft.kind === 'parsed')
      expect(draft.reads).toBe('8-digit codes, new every 60 seconds · for GitHub · kirinnee');
  });

  it('takes any key as a match while no account is picked yet', () => {
    expect(readSeedDraft(`otpauth://totp/Okta:bob@x.test?secret=${SEED}&issuer=Okta`, undefined).kind).toBe('parsed');
  });

  it('flags a key that says it is for another account, in words naming both', () => {
    const draft = readSeedDraft(`otpauth://totp/Okta:bob@x.test?secret=${SEED}&issuer=Okta`, github);
    expect(draft.kind).toBe('mismatch');
    if (draft.kind === 'mismatch') {
      expect(draft.words).toBe("This key says it is for Okta · bob@x.test, but you're saving it to GitHub · kirinnee.");
      expect(draft.reads).toContain('for Okta · bob@x.test');
    }
  });
});

describe('when Save may be pressed', () => {
  const parsed = readSeedDraft(SEED, github);
  const mismatch = readSeedDraft(`otpauth://totp/Okta:bob@x.test?secret=${SEED}&issuer=Okta`, github);
  const ready: SaveGate = { draft: parsed, account: github, warningTick: true, mismatchTick: false, busy: false };

  it('waits for an account', () => {
    expect(saveBlocked({ ...ready, account: undefined })).toBe('Pick the account this key is for.');
  });

  it('refuses an account that already holds the most keys that make codes', () => {
    expect(saveBlocked({ ...ready, account: { ...github, seeds: MAX_SEEDS_PER_ACCOUNT } })).toBe(
      `GitHub already has ${String(MAX_SEEDS_PER_ACCOUNT)} keys that make codes: remove one in Settings › Accounts first.`,
    );
  });

  it('waits for a paste, and gives the parser’s sentence for a bad one', () => {
    expect(saveBlocked({ ...ready, draft: { kind: 'empty' } })).toBe('Paste the key or its otpauth:// link.');
    expect(saveBlocked({ ...ready, draft: { kind: 'invalid', problem: 'That is not a key.' } })).toBe(
      'That is not a key.',
    );
  });

  it('needs the warning ticked, then the second tick for a key that names another account', () => {
    expect(saveBlocked({ ...ready, warningTick: false })).toBe('Tick the box to say you read the warning.');
    expect(saveBlocked({ ...ready, draft: mismatch })).toBe('Tick the second box to save it here anyway.');
    expect(saveBlocked({ ...ready, draft: mismatch, mismatchTick: true })).toBeUndefined();
  });

  it('says it is saving while busy, and is otherwise ready', () => {
    expect(saveBlocked({ ...ready, busy: true })).toBe('Saving…');
    expect(saveBlocked(ready)).toBeUndefined();
  });

  it('sends the mismatch tick only for a mismatching key the owner ticked', () => {
    const tick = (draft: SeedDraft, mismatchTick: boolean) => stageTicks({ draft, mismatchTick });
    expect(tick(mismatch, true)).toEqual({ mismatchAcknowledged: true });
    expect(tick(mismatch, false)).toEqual({});
    expect(tick(parsed, true)).toEqual({});
  });
});

describe('what a refusal comes to, in the owner’s words', () => {
  it('has a sentence for each of the daemon’s own refusal codes', () => {
    const words = (code: string) => seedFailureWords({ status: 400, code });
    expect(words(TWO_FACTOR_ERROR_CODES.passkeyRequired)).toContain('add one in Settings › Security');
    expect(words(TWO_FACTOR_ERROR_CODES.notThisCardsAccount)).toContain('another account now');
    expect(words(TWO_FACTOR_ERROR_CODES.mismatch)).toContain('tick the second box');
    expect(words(TWO_FACTOR_ERROR_CODES.notAKey)).toContain('not a 2FA key');
    expect(words(TWO_FACTOR_ERROR_CODES.stageGone)).toContain('timed out');
    expect(words(TWO_FACTOR_ERROR_CODES.tooManyStages)).toContain('Too many keys');
  });

  it('puts a grant refusal in the shell’s words, with the daemon’s detail when it gave one', () => {
    const explanation = 'This device’s access to this machine does not allow that.';
    expect(seedFailureWords({ status: 403, code: 'grant_not_allowed' })).toBe(explanation);
    expect(seedFailureWords({ status: 403, code: 'grant_not_allowed', message: 'secrets.use' })).toBe(
      `${explanation} secrets.use`,
    );
  });

  it('gives the daemon’s message for any other refusal, or says it refused', () => {
    expect(seedFailureWords({ status: 500, message: 'The vault is locked.' })).toBe('The vault is locked.');
    expect(seedFailureWords({ status: 500, message: '' })).toBe('The daemon refused this.');
    expect(seedFailureWords({ status: 500 })).toBe('The daemon refused this.');
  });

  it('says nothing was saved when the machine could not be reached', () => {
    expect(seedFailureWords(new Error('offline'))).toBe('Could not reach the machine. Nothing was saved.');
    expect(seedFailureWords(null)).toBe('Could not reach the machine. Nothing was saved.');
  });
});

describe('what a saved key says', () => {
  it('says whether Ferretry typed the first code into the card', () => {
    expect(savedSeedWords({ typed: true, mismatch: false }, 'GitHub')).toBe(
      'Saved. Ferretry typed the first code for GitHub into the input.',
    );
    expect(savedSeedWords({ mismatch: false }, 'GitHub')).toBe('Saved. Ferretry will make GitHub’s codes from now on.');
  });
});

describe('which accounts a code card may save a key to', () => {
  const saved = (offers: readonly Record<string, unknown>[] = [], match: string | null = 'github.com') =>
    InputSavedSchema.parse({ ...(match === null ? {} : { match }), offers });
  const list = accountList();

  it('offers only accounts the daemon matches to the card’s place, and nothing when the card has none', () => {
    expect(codesAccounts(saved(), list).map(each => each.id)).toEqual(['GITHUB', 'GITHUB_WORK']);
    // Vercel signs in at vercel.com, Google nowhere: neither is offered on a github.com card.
    expect(codesAccounts(saved(), list).some(each => each.id === 'VERCEL' || each.id === 'GOOGLE')).toBe(false);
    expect(codesAccounts(saved([], 'vercel.com'), list).map(each => each.id)).toEqual(['VERCEL']);
    expect(codesAccounts(saved([], 'nowhere.test'), list)).toEqual([]);
    expect(codesAccounts(saved([], null), list)).toEqual([]);
    expect(codesAccounts(undefined, list)).toEqual([]);
  });

  it('puts the daemon’s one-tap choice first, and reads label, username, places and how many keys hold a seed', () => {
    const picked = codesAccounts(savedPrimary('GITHUB_WORK'), list);
    expect(picked.map(each => each.id)).toEqual(['GITHUB_WORK', 'GITHUB']);
    const github = picked.find(each => each.id === 'GITHUB');
    expect(github).toEqual({
      id: 'GITHUB',
      label: 'GitHub',
      username: 'kirinnee',
      places: [{ kind: 'site', domains: ['github.com'], match: [] }],
      seeds: 1,
    });
    expect(picked.find(each => each.id === 'GITHUB_WORK')?.seeds).toBe(0);
    expect(picked.find(each => each.id === 'GITHUB_WORK')).not.toHaveProperty('username', undefined);
  });
});

describe('which account the panel starts on', () => {
  const list = accountList();
  it('is the daemon’s one-tap choice when there is one', () => {
    const accounts = codesAccounts(savedPrimary('GITHUB_WORK'), list);
    expect(startingAccount(savedPrimary('GITHUB_WORK'), accounts)?.id).toBe('GITHUB_WORK');
  });

  it('is the only account when there is just one', () => {
    const accounts = codesAccounts(InputSavedSchema.parse({ match: 'vercel.com', offers: [] }), list);
    expect(startingAccount(InputSavedSchema.parse({ match: 'vercel.com', offers: [] }), accounts)?.id).toBe('VERCEL');
  });

  it('never guesses: several accounts and no one-tap choice is the owner’s pick', () => {
    const accounts = codesAccounts(savedTwo(), list);
    expect(accounts).toHaveLength(2);
    expect(startingAccount(savedTwo(), accounts)).toBeUndefined();
    expect(startingAccount(undefined, accounts)).toBeUndefined();
    expect(startingAccount(savedTwo(), [])).toBeUndefined();
  });

  it('ignores a one-tap choice that is not among the accounts offered, and falls back on the only one left', () => {
    const left = codesAccounts(savedPrimary('GITHUB'), list).slice(1);
    expect(left.map(each => each.id)).toEqual(['GITHUB_WORK']);
    expect(startingAccount(savedPrimary('GITHUB'), left)?.id).toBe('GITHUB_WORK');
    expect(
      startingAccount(savedPrimary('GITHUB'), [
        ...left,
        ...codesAccounts(InputSavedSchema.parse({ match: 'vercel.com', offers: [] }), list),
      ]),
    ).toBeUndefined();
  });
});

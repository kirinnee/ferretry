/**
 * "SAVE AS" ON A CARD (docs/input-requests.md): the one write the input service makes to the account store, a login
 * card's typed username and password kept as one account in one change (I26, I147, I153). The input bridge's
 * matching, facts and `account.hint` read sign-ins from {@link LoginDirectory.accounts}. It holds the
 * {@link AccountDirectory} it was built over, so the two always share ONE store lock (I151).
 */

import {
  type AccountId,
  LOGIN_MATCH_MAX,
  type LoginEntryId,
  MAX_SIGN_INS_PER_ACCOUNT,
  placeHosts,
  placesOfMatch,
  type SitePlace,
} from '../../contract/routes/index.ts';
import {
  type AccountDirectoryOptions,
  type AccountDraft,
  AccountDirectory,
  type ClockPort,
  type LoginFieldValues,
  LoginEntryError,
  type LoginIndexStore,
  type LoginSweep,
  signInsOf,
} from './accounts.ts';
import type { SecretCipherPort, SecretDocumentStore } from './seal.ts';

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

export class LoginDirectory {
  readonly accounts: AccountDirectory;

  constructor(
    index: LoginIndexStore,
    sealed: SecretDocumentStore,
    cipher: SecretCipherPort,
    clock: ClockPort,
    options: AccountDirectoryOptions = {},
  ) {
    this.accounts = new AccountDirectory(index, sealed, cipher, clock, options);
  }

  /**
   * Keeps typed values in an account in ONE change ("Save as" on a card): a new account labelled `label`, or the
   * existing one (its label kept). The place it was typed at is added when the account does not sign in there yet: to
   * its website for a web host (as a saved login's `match` grew), else as a sign-in of its own. The username and the
   * password of one login card are kept together or not at all.
   *
   * `mode` is the owner's choice, checked UNDER THE STORE LOCK so a card raised before another saved cannot write over
   * it: `new` refuses a handle an account already has, `update` refuses one no account has, and refuses another person:
   * a username that is not the account's own, or a page (`pageUsername`, what the ferret typed there) signing in someone
   * the account is not — including an account with no username saved, which nothing says is the same person. Absent
   * `mode`: either, as before (the input service always names one; the CLI and Settings write accounts their own way).
   */
  async saveFields(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: LoginFieldValues,
    mode?: 'new' | 'update',
    pageUsername?: string,
  ): Promise<AccountId> {
    return await this.accounts.transact(async draft => {
      const existing = Object.hasOwn(draft.accounts, id) ? draft.accounts[id] : undefined;
      if (mode === 'new' && existing !== undefined)
        throw new LoginEntryError('login_exists', `${id} is already an account's CLI name`);
      if (mode === 'update' && existing === undefined)
        throw new LoginEntryError('unknown_login', `there is no account ${id} to update`);
      const had = existing?.username?.trim().toLowerCase();
      const otherBox =
        fields.username !== undefined && had !== undefined && had !== fields.username.trim().toLowerCase();
      const otherPage = pageUsername !== undefined && had !== pageUsername.trim().toLowerCase();
      if (mode === 'update' && (otherBox || otherPage))
        throw new LoginEntryError('invalid_change', `${id} is someone else; save it as a new account`);
      const account = await this.accounts.applyAccount(draft, id, {
        ...(existing === undefined ? { label } : {}),
        ...(fields.username === undefined ? {} : { username: fields.username }),
        ...(fields.password === undefined ? {} : { password: fields.password }),
      });
      if (match !== undefined) this.addPlace(draft, account.key, match);
      return id;
    });
  }

  private addPlace(draft: AccountDraft, key: string, match: string): void {
    const own = signInsOf(draft.signIns, key);
    if (own.some(([, signIn]) => placeHosts(signIn.place).includes(match))) return;
    const [place] = placesOfMatch([match], this.accounts.hostName);
    if (place === undefined) return;
    const site = own.find(([, signIn]) => signIn.place.kind === 'site');
    if (place.kind === 'site' && site !== undefined) {
      const [siteId, signIn] = site;
      const at = signIn.place as SitePlace;
      draft.signIns[siteId] = {
        ...signIn,
        place: {
          kind: 'site',
          domains: unique([...at.domains, match]).slice(-LOGIN_MATCH_MAX),
          match: unique([...at.match, match]).slice(-LOGIN_MATCH_MAX),
        },
        updatedAt: draft.at,
      };
      return;
    }
    if (own.length >= MAX_SIGN_INS_PER_ACCOUNT) return;
    draft.signIns[this.accounts.freshSignInId(draft)] = {
      account: key,
      place,
      createdAt: draft.at,
      updatedAt: draft.at,
    };
  }

  /** AT BOOT: the account store's boot step (the sweep). See {@link AccountDirectory.prepare}. */
  async sweepUnreferenced(): Promise<LoginSweep> {
    return await this.accounts.prepare();
  }
}

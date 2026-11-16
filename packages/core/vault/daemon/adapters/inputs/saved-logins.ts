import { z } from 'zod';
import type { SavedLoginsProvider } from '../../../contract/index.ts';
import {
  AccountListSchema,
  type AccountId,
  type AccountList,
  type LoginEntryId,
  type LoginFieldRole,
  type LoginFieldValues,
  type LoginObservation,
  type SignInChoiceContext,
  SignInChoiceContextSchema,
  type SignInId,
  type TwoFactorId,
} from '../../lib/inputs/borrowed.ts';
import type { LoginFactSink } from '../../lib/inputs/login-observer.ts';
import type { InputChoicePort, InputLoginPort } from '../../lib/inputs/ports.ts';

/** The `input.saved:saved` provider in effect now, or nothing when Accounts is off (§4.7). */
export type SavedLoginsProviderLookup = () => SavedLoginsProvider | undefined;

/** Said when a saved login is asked for while Accounts provides none: nothing is read, typed or kept. */
const NO_ACCOUNTS = 'Accounts is not available, so there are no saved logins.';

const ListingSchema = AccountListSchema.pick({ accounts: true, signIns: true });

/** What `fill` may answer: one non-empty string. Anything else is refused whole, and said without naming a value. */
const FilledSchema = z.string().min(1);
const UNREADABLE_FILL = 'Accounts answered a value Ferretry cannot read.';

/**
 * THE VAULT'S VIEW OF ACCOUNTS' SAVED LOGINS, looked up on every call: an Accounts that was turned off since a card was
 * raised answers "cannot tell", so nothing is offered, nothing is saved and every value is typed (fail closed).
 *
 * What a provider says about the accounts and about who is asking is PARSED here against the Vault's own strict
 * schemas: a field the card may not show is refused whole, never drawn. `fill` is the one place a value comes back, and
 * the caller types it into the target and nowhere else.
 */
export class SavedLoginsThroughHook implements InputLoginPort, InputChoicePort, LoginFactSink {
  constructor(private readonly provider: SavedLoginsProviderLookup) {}

  async listing(): Promise<Pick<AccountList, 'accounts' | 'signIns'>> {
    const parsed = ListingSchema.safeParse(await this.asked(provider => provider.listing()));
    if (!parsed.success) throw new Error('Accounts answered a listing Ferretry cannot read.');
    return parsed.data;
  }

  async fill(
    id: LoginEntryId,
    role: LoginFieldRole,
    nowMs: number,
    options: { readonly factor?: TwoFactorId } = {},
  ): Promise<string> {
    const parsed = FilledSchema.safeParse(await this.asked(provider => provider.fill(id, role, nowMs, options)));
    if (!parsed.success) throw new Error(UNREADABLE_FILL);
    return parsed.data;
  }

  async save(
    id: LoginEntryId,
    label: string,
    match: string | undefined,
    fields: LoginFieldValues,
    mode?: 'new' | 'update',
    pageUsername?: string,
  ): Promise<void> {
    await this.asked(provider => provider.save(id, label, match, fields, mode, pageUsername));
  }

  /** The order a card is drawn in; what cannot be told leaves the site lines alone (a card is never lost to it). */
  async of(sessionId: string): Promise<Omit<SignInChoiceContext, 'hint'>> {
    try {
      const parsed = SignInChoiceContextSchema.safeParse(await this.provider()?.choice(sessionId));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async observeSignIn(id: SignInId, seen: LoginObservation): Promise<void> {
    await this.provider()?.observeSignIn(id, seen);
  }

  async checkedByUse(account: AccountId, factor: TwoFactorId, worked: boolean): Promise<void> {
    await this.provider()?.checkedByUse(account, factor, worked);
  }

  private async asked<T>(call: (provider: SavedLoginsProvider) => Promise<T>): Promise<T> {
    const provider = this.provider();
    if (provider === undefined) throw new Error(NO_ACCOUNTS);
    return await call(provider);
  }
}

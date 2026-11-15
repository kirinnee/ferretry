/**
 * WHAT ACCOUNTS ANSWERS THE VAULT'S INPUT CARD (`input.saved:saved`, docs/input-requests.md): the saved logins a card
 * offers, "Save as", the order of a sign-in card and the facts the daemon saw after a submit, all from the account
 * store Accounts already keeps. It is reachable ONLY through the Vault's input path: no route, command or agent tool
 * holds it, and `fill` is the one member that answers a value (the Vault types it into the card's target and nowhere
 * else). Everything the Vault sends is parsed here first; a bad id or shape is refused with a fixed sentence that names
 * no value.
 */
import type { SavedLoginsProvider } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import {
  AccountIdSchema,
  type AccountList,
  LoginEntryIdSchema,
  LoginFieldRoleSchema,
  SignInIdSchema,
  TwoFactorIdSchema,
} from '../../contract/routes/index.ts';
import type { AccountVault } from './accounts.ts';
import type { LoginDirectory } from './logins.ts';
import type { SignInChoicePort } from './sign-in-context.ts';

/** What the Vault reports after a submit (`LoginObservation`): facts about a target, never a value. */
const ObservationSchema = z.strictObject({
  at: z.string().min(1).max(320),
  surface: z.enum(['page', 'terminal']),
  identity: z.string().min(1).max(128),
  masked: z.boolean().optional(),
  noEchoAfterSubmit: z.boolean().optional(),
  navigatedAway: z.boolean().optional(),
  secondFactor: z.enum(['push', 'code', 'none']).optional(),
  tapped: z.boolean().optional(),
});

const FieldsSchema = z.strictObject({ username: z.string().optional(), password: z.string().optional() });
const ModeSchema = z.enum(['new', 'update']);

/** What the hook reads of Accounts: the directory (names, places, saving), the vault (the one value) and the order. */
export interface SavedLoginsDeps {
  readonly logins: LoginDirectory;
  /** Absent: no value can be made, so `fill` refuses. */
  readonly vault?: Pick<AccountVault, 'fill'>;
  readonly choice: SignInChoicePort;
}

export class AccountsSavedLogins implements SavedLoginsProvider {
  constructor(private readonly deps: SavedLoginsDeps) {}

  async listing(): Promise<Pick<AccountList, 'accounts' | 'signIns'>> {
    return await this.deps.logins.accounts.list();
  }

  async fill(
    id: string,
    role: 'username' | 'password' | 'totp',
    nowMs: number,
    options: { readonly factor?: string } = {},
  ): Promise<string> {
    const { vault } = this.deps;
    if (vault === undefined) throw new Error('Accounts keeps no values, so nothing was typed.');
    const factor = options.factor === undefined ? undefined : TwoFactorIdSchema.parse(options.factor);
    return await vault.fill(
      LoginEntryIdSchema.parse(id),
      LoginFieldRoleSchema.parse(role),
      nowMs,
      factor === undefined ? {} : { factor },
    );
  }

  async save(
    id: string,
    label: string,
    match: string | undefined,
    fields: { readonly username?: string; readonly password?: string },
    mode?: 'new' | 'update',
    pageUsername?: string,
  ): Promise<void> {
    const kept = FieldsSchema.parse(fields);
    await this.deps.logins.saveFields(
      LoginEntryIdSchema.parse(id),
      label,
      match,
      {
        ...(kept.username === undefined ? {} : { username: kept.username }),
        ...(kept.password === undefined ? {} : { password: kept.password }),
      },
      mode === undefined ? undefined : ModeSchema.parse(mode),
      pageUsername,
    );
  }

  async choice(sessionId: string): Promise<unknown> {
    return await this.deps.choice.of(sessionId);
  }

  async observeSignIn(id: string, seen: unknown): Promise<void> {
    const observation = ObservationSchema.parse(seen);
    await this.deps.logins.accounts.observeSignIn(SignInIdSchema.parse(id), {
      at: observation.at,
      surface: observation.surface,
      identity: observation.identity,
      ...(observation.masked === undefined ? {} : { masked: observation.masked }),
      ...(observation.noEchoAfterSubmit === undefined ? {} : { noEchoAfterSubmit: observation.noEchoAfterSubmit }),
      ...(observation.navigatedAway === undefined ? {} : { navigatedAway: observation.navigatedAway }),
      ...(observation.secondFactor === undefined ? {} : { secondFactor: observation.secondFactor }),
      ...(observation.tapped === undefined ? {} : { tapped: observation.tapped }),
    });
  }

  async checkedByUse(account: string, factor: string, worked: boolean): Promise<void> {
    await this.deps.logins.accounts.checkedByUse(
      AccountIdSchema.parse(account),
      TwoFactorIdSchema.parse(factor),
      worked,
    );
  }
}

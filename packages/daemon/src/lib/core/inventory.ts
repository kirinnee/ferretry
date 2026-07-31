/**
 * The account inventory the daemon reasons over.
 *
 * Everything here is *declared*, never parsed out of a name. The source inferred the harness from a
 * `claude-`/`codex-` filename prefix, the served model from a table of wrapper-name regexes, and
 * the set of unattended accounts from a directory listing filtered by `^(claude|codex)-auto-`.
 * Three separate tables encoding the same knowledge, none of them able to disagree loudly: a
 * configuration that declared an account's model unavailable still had that model offered, and
 * recommended first.
 *
 * So the daemon declares the shape it needs and an adapter supplies it from the published fleet
 * manifest. The opaque {@link CoreAccount.id} is the only join key; `agent`, `displayName` and the
 * rest are attributes that can be renamed without breaking a single join.
 */

/** The agent harness an account drives. */
export type HarnessKind = 'claude' | 'codex';

/** The lane an account runs in — declared, so a name can never imply it. */
export type AccountMode = 'interactive' | 'auto';

/** One model an account may be asked to serve. An unavailable model must say why. */
export interface CoreAccountModel {
  readonly id: string;
  readonly displayName?: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface CoreAccount {
  /** Opaque, stable identity. The only value any consumer may join on. */
  readonly id: string;
  /** Executable name this account is launched through. An attribute, never parsed for meaning. */
  readonly agent: string;
  readonly kind: HarnessKind;
  readonly mode: AccountMode;
  readonly displayName: string;
  /** The model served when a caller names none; `null` when the account names none. */
  readonly defaultModel: string | null;
  readonly models: readonly CoreAccountModel[];
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/** Supplied by an adapter over the published fleet manifest. */
export interface AccountInventoryPort {
  accounts(): Promise<readonly CoreAccount[]>;
}

/** The accounts that may take unattended work: the auto lane, minus anything declared down. */
export function selectableAutoAccounts(accounts: readonly CoreAccount[]): readonly CoreAccount[] {
  return accounts.filter(account => account.mode === 'auto' && account.available);
}

/** Look an account up by its stable identity. */
export function findAccountById(accounts: readonly CoreAccount[], id: string): CoreAccount | undefined {
  return accounts.find(account => account.id === id);
}

/**
 * Look an account up by the executable name a usage row or a running session carries. Ambiguity is
 * refused rather than resolved: two accounts sharing an executable name is a manifest defect, and
 * silently picking the first was how the source attached one account's quota to another's session.
 */
export function findAccountByAgent(accounts: readonly CoreAccount[], agent: string): CoreAccount | undefined {
  const matches = accounts.filter(account => account.agent === agent);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The models an account may actually be asked for right now. */
export function servableModels(account: CoreAccount): readonly CoreAccountModel[] {
  return account.available ? account.models.filter(model => model.available) : [];
}

/** Whether this account can serve the named model. An unavailable model is not servable. */
export function canServeModel(account: CoreAccount, model: string): boolean {
  return servableModels(account).some(entry => entry.id === model);
}

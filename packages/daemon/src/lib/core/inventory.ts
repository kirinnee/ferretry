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

import { z } from 'zod';

const NonEmptyString = z.string().min(1);

/** The agent harness an account drives. */
export const HarnessKindSchema = z.enum(['claude', 'codex']);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/** The lane an account runs in — declared, so a name can never imply it. */
export const AccountModeSchema = z.enum(['interactive', 'auto']);
export type AccountMode = z.infer<typeof AccountModeSchema>;

/** One model an account may be asked to serve. An unavailable model must say why. */
export const CoreAccountModelSchema = z.object({
  id: NonEmptyString,
  displayName: NonEmptyString.optional(),
  available: z.boolean(),
  unavailableReason: NonEmptyString.optional(),
});
export type CoreAccountModel = z.infer<typeof CoreAccountModelSchema>;

/**
 * Deliberately not `strictObject`: the published manifest is written by the fleet provisioner and
 * carries provisioning attributes the daemon has no business knowing about. Refusing a manifest for
 * containing a field the daemon does not read would couple every fleet change to a daemon release.
 */
export const CoreAccountSchema = z.object({
  /** Opaque, stable identity. The only value any consumer may join on. */
  id: NonEmptyString,
  /** Executable name this account is launched through. An attribute, never parsed for meaning. */
  agent: NonEmptyString,
  kind: HarnessKindSchema,
  mode: AccountModeSchema,
  displayName: NonEmptyString,
  /** The model served when a caller names none; `null` when the account names none. */
  defaultModel: NonEmptyString.nullable(),
  models: z.array(CoreAccountModelSchema).readonly(),
  available: z.boolean(),
  unavailableReason: NonEmptyString.optional(),
});
export type CoreAccount = z.infer<typeof CoreAccountSchema>;

/**
 * The published fleet manifest, as the daemon reads it.
 *
 * A row that does not parse is dropped rather than failing the whole manifest: one malformed account
 * must not blind the daemon to every other account in the fleet.
 */
export function parseAccountManifest(payload: unknown): readonly CoreAccount[] {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { accounts?: unknown }).accounts)
      ? (payload as { accounts: readonly unknown[] }).accounts
      : undefined;
  if (rows === undefined) return [];
  return rows
    .map(row => CoreAccountSchema.safeParse(row))
    .filter(result => result.success)
    .map(result => result.data);
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

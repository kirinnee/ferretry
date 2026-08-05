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
 * So an adapter supplies this inventory from the published fleet manifest — and it does so through
 * `@ferretry/fleet`'s OWN schema, the one the provisioner writes with, rather than a second
 * declaration of the same file. The second declaration is not hypothetical: this module used to
 * carry one, it required an `agent` field the provisioner has never written, and the daemon
 * therefore read every real manifest as an empty fleet while `fy fleet ls` listed the accounts from
 * the very same bytes. Two halves that each passed their own tests and disagreed with each other.
 *
 * The opaque {@link CoreAccount.id} is the only join key; `agent`, `displayName` and the rest are
 * attributes that can be renamed without breaking a single join.
 */

import {
  type FleetManifestAccount,
  type FleetManifestModel,
  FleetManifestSchema,
  HarnessKindSchema,
  wrapperName,
} from '@ferretry/fleet';
import { z } from 'zod';

/** The agent harness an account drives. The fleet's own enum, never a second copy of it. */
export { HarnessKindSchema };
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/** One model an account may be asked to serve. An unavailable model must say why. */
export type CoreAccountModel = FleetManifestModel;

/**
 * One published account, as the daemon reads it: the manifest row itself, plus the executable NAME
 * derived from the path it publishes.
 *
 * `agent` is not a second field on disk — {@link wrapperName} derives it from `wrapper`, so there is
 * nothing here a manifest could contradict. It exists because a name is what an operator types
 * (`fy start claude-auto-loge`), what a session record carries and what a usage row is keyed by,
 * while `wrapper` is what a start actually runs.
 */
export interface CoreAccount extends FleetManifestAccount {
  readonly agent: string;
}

/**
 * A manifest that is present and cannot be read. NOT an empty fleet.
 *
 * The distinction is the whole point: an ABSENT manifest is a legitimate state — the daemon runs
 * before a fleet is ever provisioned — while a PRESENT one the daemon cannot parse is damaged state,
 * and reading damaged state as the benign empty case is what let a schema disagreement masquerade as
 * "no accounts are published" for an entire release. It names the file and the failure so the first
 * person to hit it is told what is wrong with which file, rather than a confident falsehood.
 */
export class FleetManifestUnreadableError extends Error {
  constructor(
    readonly source: string,
    readonly reason: string,
  ) {
    super(`the fleet manifest at ${source} is present but cannot be read: ${reason}`);
    this.name = 'FleetManifestUnreadableError';
  }
}

/**
 * The published fleet manifest, as the daemon reads it.
 *
 * ALL OR NOTHING, through the provisioner's own schema. A row this refuses is a row the provisioner
 * could not have written, so it is evidence the file is damaged rather than evidence about one
 * account — and a fleet that silently shrinks by one account is the same fail-open as a fleet that
 * silently empties, just harder to notice.
 */
export function parseAccountManifest(payload: unknown, source: string): readonly CoreAccount[] {
  const parsed = FleetManifestSchema.safeParse(payload);
  if (!parsed.success) throw new FleetManifestUnreadableError(source, z.prettifyError(parsed.error));
  return parsed.data.accounts.map(account => ({ ...account, agent: wrapperName(account) }));
}

/**
 * Supplied by an adapter over the published fleet manifest.
 *
 * Answers an empty fleet for a manifest that is not there, and THROWS
 * {@link FleetManifestUnreadableError} for one that is there and unreadable. Every caller therefore
 * fails closed by default: forgetting the damaged case surfaces it loudly instead of quietly
 * reporting a fleet nobody provisioned.
 */
export interface AccountInventoryPort {
  accounts(): Promise<readonly CoreAccount[]>;
}

/**
 * What a boot or a `--check` says about a manifest it could not read.
 *
 * It states the CONSEQUENCE as well as the cause. A diagnosis on its own leaves a reader deciding
 * for themselves how much still works, and the defect this replaces is the proof of how badly that
 * goes: told only that no account was published, the owner had every reason to believe their fleet
 * was the problem rather than the reader in front of them.
 */
export function fleetManifestRefusal(error: FleetManifestUnreadableError, clientName: string): string {
  return `${error.message}. Every session start will be refused until it is repaired — run \`${clientName} fleet apply\` to republish it, or remove the file if this host has no fleet.`;
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

import { resolveRuntimeReference, type RuntimeIds } from '@ferretry/fleet';
import { accountLaunchability, type ExecutableResolverPort } from '../core/harness-readiness.ts';
import {
  type AccountInventoryPort,
  type CoreAccount,
  FleetManifestUnreadableError,
  fleetManifestRefusal,
} from '../core/inventory.ts';
import { SessionControlError } from '../runtime/mounts/session-control.ts';
import { unrunnableAccountRefusal } from '../session/lifecycle/policy.ts';
import { defaultSessionLifecycleSettings } from '../session/lifecycle/settings.ts';

/**
 * The runtime names the fleet recorded in `ids.json` (docs/design/account-model.md R6, §10.4), read
 * for the one thing a start needs from them: an OLD wrapper name, which keeps working forever.
 *
 * Answers `undefined` when there is no `ids.json` — a version-1 fleet, or a machine with no fleet —
 * and THROWS for one that is there and unreadable, so a start that needed it can say so.
 */
export interface RuntimeNamesPort {
  ids(): Promise<RuntimeIds | undefined>;
}

/**
 * The account this start names, or a refusal that says which half of the resolution failed.
 *
 * A start names a runtime by its NAME, then by a NAME IT HAD BEFORE (recorded in `ids.json` by a
 * migration or a rename), then by its opaque ID (§8.4) — in that order, so a runtime's own name is
 * never shadowed by another's former one. The old names come from the inventory's optional
 * {@link RuntimeNamesPort} half, so the ONE inventory every start already shares carries them and no
 * call site has a second thing to pass; an inventory without it resolves names and ids as before.
 *
 * THE LAUNCHABILITY RULE IS THE DOMAIN'S, not a second copy written here. `fyd --check` and the boot
 * preflight report on whether a harness could serve, and they answer that question by asking this
 * same `accountLaunchability`. Two spellings of "could a start run this?" would eventually disagree,
 * and the disagreement would be a preflight that promises a harness a start then refuses.
 *
 * `clientName` is the CLI a human drives. It is a parameter because only the composition root knows
 * it; every refusal below names the command to run next.
 */
export async function resolveStartAccount(
  accounts: AccountInventoryPort & Partial<RuntimeNamesPort>,
  requested: string,
  executables: ExecutableResolverPort,
  clientName: string,
): Promise<{ readonly account: CoreAccount; readonly executable: string }> {
  // A manifest this daemon cannot read refuses the START, rather than answering it with an empty
  // fleet and the unknown-agent message that empty fleet would earn. The caller asked for an account
  // that may well be published; what this daemon has is no way to tell.
  const published = await accounts.accounts().catch((error: unknown) => {
    if (error instanceof FleetManifestUnreadableError)
      throw new SessionControlError('unavailable', fleetManifestRefusal(error, clientName));
    throw error;
  });
  const account = await findRequested(published, requested, accounts.ids?.bind(accounts));
  if (account === undefined)
    throw new SessionControlError(
      'unknown_agent',
      `no account in the fleet manifest is published as ${JSON.stringify(requested)}`,
    );
  // Refused HERE, where the published accounts are in hand, rather than left to the launch: the
  // launch's own authorization sees only a path, so it can say the path is wrong but not which
  // account would have worked — and the account `fy fleet ls` lists first is one it refuses.
  const unrunnable = unrunnableAccountRefusal(account, published, defaultSessionLifecycleSettings, clientName);
  if (unrunnable !== undefined) throw new SessionControlError('invalid', unrunnable);
  const launchability = accountLaunchability(account, executables);
  // Both halves are `unavailable` to a caller: the account exists and cannot serve. Which half is
  // the operator's business, and it is the reason the rule reports the two separately.
  if (launchability.kind !== 'launchable') throw new SessionControlError('unavailable', launchability.reason);
  return { account, executable: launchability.executable };
}

/** Name, then former name, then id. `ids.json` is read only when the name alone did not match. */
async function findRequested(
  published: readonly CoreAccount[],
  requested: string,
  readIds: RuntimeNamesPort['ids'] | undefined,
): Promise<CoreAccount | undefined> {
  const byName = published.find(row => row.agent === requested);
  if (byName !== undefined) return byName;
  const byId = published.find(row => row.id === requested);
  if (readIds === undefined) return byId;
  const ids = await readIds().catch((error: unknown) => {
    // An id needs no `ids.json`, so an unreadable one costs only the old-name lookup.
    if (byId !== undefined) return undefined;
    // Fail closed: an unreadable `ids.json` could be hiding the runtime this old name now is, and
    // answering "no such account" would send somebody looking for a runtime that exists.
    throw new SessionControlError(
      'unavailable',
      `${JSON.stringify(requested)} is not a runtime name, and the fleet's runtime ids (ids.json) could not be read to check whether it is an old one: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const reference = ids === undefined ? undefined : resolveRuntimeReference(ids, requested);
  if (reference?.matched === 'former-name') {
    const renamed = published.find(row => row.agent === reference.name);
    if (renamed !== undefined) return renamed;
  }
  return byId;
}

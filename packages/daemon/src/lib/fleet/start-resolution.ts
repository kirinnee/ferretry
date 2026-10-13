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
 * The account this start names, or a refusal that says which half of the resolution failed.
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
  accounts: AccountInventoryPort,
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
  // The wrapper NAME first, then the opaque id: `fy start claude-auto-loge` names the wrapper a human
  // types, and the recommender answers with account ids, so both must resolve.
  const account = published.find(row => row.agent === requested) ?? published.find(row => row.id === requested);
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

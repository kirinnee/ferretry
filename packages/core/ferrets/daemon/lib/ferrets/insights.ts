import type { FerretId, TurnUsage } from '../../../contract/index.ts';
import {
  type AgentControl,
  effectiveAgentControl,
  type LimitsFile,
  NO_AGENT_CONTROL,
} from '../../../contract/index.ts';
import type { Instant } from '@ferretry/std';
import type { FerretsCore } from './core.ts';

/**
 * What a ferret may control (today's `AccountModelAgentControlPolicy`, over `limits.yaml`): read fresh for every
 * call, so a change applies to its very next action with no restart and no cache. An unknown ferret controls nothing.
 */
export async function agentControl({ registry, ports }: FerretsCore, ferret: FerretId): Promise<AgentControl> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return NO_AGENT_CONTROL;
  return effectiveAgentControl(ports.limits?.());
}

/**
 * What a ferret spent, read through the harness its record names. `undefined` (PARTIAL, never zero) for a ferret this
 * daemon does not know, a harness that is off, and a reader that throws: its error text can carry a path or a line of
 * the transcript, so none is passed on.
 */
export async function turnUsage(
  { registry, ports }: FerretsCore,
  ferret: FerretId,
  since?: Instant,
): Promise<readonly TurnUsage[] | undefined> {
  await ports.ready?.();
  const record = registry.get(ferret);
  if (record === undefined) return undefined;
  try {
    return await ports.harness(record.harness)?.usage.turns(ferret, since);
  } catch {
    return undefined;
  }
}

/**
 * `limits.yaml` as it is in effect now: the kernel's config file, read fresh on every call, so a launch reads the file
 * as it stands (a broken file reads its last good version). No limits port bound: the empty file, so the defaults.
 */
export async function effectiveLimits({ ports }: FerretsCore): Promise<LimitsFile> {
  return ports.limits?.() ?? {};
}

/** Revokes a ferret's token (owner only at the route); it can no longer call the daemon until it restarts. */
export async function revokeToken(
  { tokens, ports, serial, requireTokens }: FerretsCore,
  ferret: FerretId,
): Promise<boolean> {
  return await serial.run(ferret, async () => {
    await ports.ready?.();
    requireTokens();
    const revoked = tokens.holds(ferret);
    tokens.cutOff(ferret, ports.now());
    await ports.saveTokens(tokens.snapshot());
    // The session document's mark follows, in the same queue: the lifecycle's rotation reads it, and no launch of
    // either kind may hand the ferret a credential again. A failure here is the owner's to see; the directory's
    // cut-off above already holds, and a launch reads both.
    await ports.cutOffMark?.cutOff(ferret);
    return revoked;
  });
}

/**
 * The one seam that makes resource limits real: the exact argv a managed pane execs.
 *
 * DISABLED MEANS BYTE-FOR-BYTE DIRECT EXECUTION. No wrapper, no probe, no manager call — a daemon
 * with enforcement off must behave exactly as one built before this module existed, because that is
 * the behaviour every host without a user manager depends on.
 *
 * THE SAVED DOCUMENT IS READ PER LAUNCH rather than captured once. An operator who lowers a cap and
 * then starts an agent gets the cap they just saved; a cached configuration would hand the next
 * agent the value the daemon booted with. The read is one small file and a launch is already
 * spawning a terminal, so the cost is not measurable.
 *
 * THIS DAEMON IS EXCLUDED STRUCTURALLY. It never invokes itself through this planner, so its own
 * placement stays outside the fleet slice by construction rather than by a rule someone has to
 * remember — and the settings surface still PROVES that separately instead of repeating the claim.
 *
 * ORDERING IS NOT THIS MODULE'S PROBLEM. Every launch already runs inside the session lifecycle's
 * serial executor, and a settings change takes the same executor exclusively, so a save can never
 * land in the gap between choosing this argv and the multiplexer creating the pane.
 */

import { parseStoredCgroupConfig } from './config.ts';
import { launchIsExempt, resolveFleetExemption } from './exemption.ts';
import { cgroupsSupported, effectiveCgroupLimits } from './limits.ts';
import type { CgroupCommandPort, CgroupConfigStore, CgroupHostFacts, SessionSpawnFactsPort } from './ports.ts';
import { agentScopeCommand, agentScopeName, FLEET_SLICE, slicePropertyCommand } from './scope.ts';
import { runCgroupCommand } from './apply.ts';

export interface CgroupLaunchPorts {
  readonly store: CgroupConfigStore;
  readonly host: CgroupHostFacts;
  readonly commands: CgroupCommandPort;
  readonly sessions: SessionSpawnFactsPort;
  /** An unguessable suffix per launch, so a relaunch cannot collide with a scope that is still
   *  deactivating. Injected because a test that could not fix it could not assert an argv. */
  readonly nonce: () => string;
  /** Overridable only so a live verification can exercise the real path against a throwaway unit
   *  instead of the slice a running fleet is in. */
  readonly slice?: string;
}

/** Decides, per launch, whether this agent runs inside a managed scope and with which limits. */
export class CgroupLaunchPlanner {
  constructor(private readonly ports: CgroupLaunchPorts) {}

  /**
   * The argv this pane must exec.
   *
   * Four ways to get the command back unchanged, and each is a deliberate one: enforcement is off,
   * the host cannot enforce anything, the session is supervision OR descends from it, or the
   * session's own document could not be read (see `exemption.ts` for why that direction protects
   * the watchdog). Everything else is wrapped.
   *
   * A FAILURE TO PREPARE THE SLICE FAILS THE LAUNCH. Returning the bare command would put an agent
   * on the host with none of the limits the operator saved and nothing saying so; the lifecycle
   * records the reason on the session instead, where it is visible.
   */
  async command(sessionId: string, command: readonly string[]): Promise<readonly string[]> {
    const { config } = parseStoredCgroupConfig(await this.ports.store.read());
    if (!config.enabled || !cgroupsSupported(this.ports.host)) return command;
    if (launchIsExempt(await resolveFleetExemption(sessionId, this.ports.sessions))) return command;
    const slice = this.ports.slice ?? FLEET_SLICE;
    const limits = effectiveCgroupLimits(config, this.ports.host);
    await runCgroupCommand(
      this.ports.commands,
      slicePropertyCommand(slice, limits.fleet),
      `could not configure ${slice}`,
    );
    return agentScopeCommand({
      scope: agentScopeName(sessionId, this.ports.nonce()),
      slice,
      limits: limits.perAgent,
      command,
    });
  }
}

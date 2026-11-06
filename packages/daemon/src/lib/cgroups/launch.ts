/**
 * The one seam that makes ferret limits real: the exact argv a managed pane execs.
 *
 * ON BY DEFAULT, DEGRADING LOUDLY. `limits.yaml` absent means limits ON with every number computed from
 * the machine. When the machine cannot enforce them (no user manager, not cgroup v2) the command comes
 * back unchanged and the status says why; when the OWNER wrote `enabled: true` themselves the launch
 * FAILS instead, because they asked for a guarantee and a silent unlimited ferret is the thing they
 * asked not to have. `enabled: false` is byte-for-byte direct execution.
 *
 * READ PER LAUNCH. The configuration in effect is asked for on every launch, so a cap the owner just
 * tightened reaches the next ferret with no restart; the launch itself prepares the fleet slice
 * (`set-property --runtime` is idempotent) so a slice another run configured differently is corrected.
 *
 * ONLY NEW LAUNCHES. A live process is never moved: a running ferret keeps the scope it started in
 * (possibly `tmux-spawn-*.scope`), and a relaunch is what brings it under the slice.
 *
 * THIS DAEMON IS EXCLUDED STRUCTURALLY — it never launches itself through this planner — and so is
 * supervision (`exemption.ts`): the facility that notices a wedged fleet is never throttled by it.
 *
 * ORDERING IS NOT THIS MODULE'S PROBLEM. Every launch already runs inside the session lifecycle's
 * serial executor.
 */
import { type LimitsConfig, resolveLimits } from '@ferretry/protocol';
import { CgroupError, failureText, runCgroupCommand } from './apply.ts';
import type { EnforcementState } from './enforcement.ts';
import { launchIsExempt, resolveFleetExemption } from './exemption.ts';
import { ferretScopeProperties, fleetSliceProperties } from './limits.ts';
import type { CgroupCommandPort, CgroupHostFacts, SessionSpawnFactsPort } from './ports.ts';
import type { EnforcementRuntime } from './runtime.ts';
import {
  agentScopeCommand,
  agentScopeName,
  FLEET_SLICE,
  IONICE_PREFIX,
  MACOS_NICE_PREFIX,
  MACOS_PREFIX,
  slicePropertyCommand,
} from './scope.ts';

export interface CgroupLaunchPorts {
  /** The `limits.yaml` in effect (the last good version), or its defaults. */
  readonly limits: () => Promise<LimitsConfig>;
  readonly host: CgroupHostFacts;
  readonly commands: CgroupCommandPort;
  readonly sessions: SessionSpawnFactsPort;
  readonly enforcement: EnforcementRuntime;
  /** An unguessable suffix per launch, so a relaunch cannot collide with a scope that is still deactivating. */
  readonly nonce: () => string;
  /** Overridable only so a live verification can exercise the real path against a throwaway unit. */
  readonly slice?: string;
}

function priorityPrefix(state: Extract<EnforcementState, { kind: 'priority' }>): readonly string[] {
  if (state.wrapper === 'taskpolicy') return MACOS_PREFIX;
  return state.wrapper === 'nice' ? MACOS_NICE_PREFIX : [];
}

/** Decides, per launch, how this agent is wrapped. */
export class CgroupLaunchPlanner {
  constructor(private readonly ports: CgroupLaunchPorts) {}

  /** The argv this pane must exec. */
  async command(sessionId: string, command: readonly string[]): Promise<readonly string[]> {
    const config = await this.ports.limits();
    const resolved = resolveLimits(config, { memoryCeilingBytes: this.ports.host.memoryCeilingBytes });
    if (!resolved.enabled) return command;
    if (launchIsExempt(await resolveFleetExemption(sessionId, this.ports.sessions))) return command;
    const explicit = config.enabled === true;
    const state = await this.ports.enforcement.current();
    if (state.kind === 'priority') {
      const prefix = priorityPrefix(state);
      if (prefix.length === 0 && explicit)
        throw new CgroupError(
          'unsupported',
          'limits are switched on in limits.yaml but this Mac has neither taskpolicy nor nice',
        );
      return [...prefix, ...command];
    }
    const ionice = resolved.ionice && state.ionice ? IONICE_PREFIX : [];
    if (state.kind === 'direct') {
      if (explicit)
        throw new CgroupError(
          'unsupported',
          `limits are switched on in limits.yaml but cannot be applied: ${state.reason}`,
        );
      return [...ionice, ...command];
    }
    const slice = this.ports.slice ?? FLEET_SLICE;
    const interactive = (await this.ports.sessions.facts(sessionId).catch(() => undefined))?.interactive === true;
    try {
      await runCgroupCommand(
        this.ports.commands,
        slicePropertyCommand(slice, fleetSliceProperties(resolved.fleet, this.ports.host)),
        `could not configure ${slice}`,
      );
    } catch (error) {
      // The manager may have gone away since boot: ask again (rate limited) so the status says so.
      this.ports.enforcement.recordLaunchFailure(failureText(error));
      await this.ports.enforcement.afterFailure();
      if (explicit) throw error instanceof CgroupError ? error : new CgroupError('failed', failureText(error));
      return [...ionice, ...command];
    }
    this.ports.enforcement.recordLaunchSuccess();
    return agentScopeCommand({
      scope: agentScopeName(sessionId, this.ports.nonce()),
      slice,
      properties: ferretScopeProperties(resolved.perFerret, this.ports.host, interactive),
      command: [...ionice, ...command],
    });
  }
}

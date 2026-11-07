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
import { type LimitsConfig, type ResolvedLimits, resolveLimits } from '../protocol/limits.ts';
import { WARDEN_LABEL } from '../warden/types.ts';
import { CgroupError, failureText, runCgroupCommand } from './apply.ts';
import type { EnforcementState } from './enforcement.ts';
import { launchIsExempt, resolveFleetExemption } from './exemption.ts';
import { ferretScopeProperties, fleetSliceProperties } from './limits.ts';
import type { CgroupCommandPort, CgroupHostFacts, SessionSpawnFactsPort } from './ports.ts';
import type { EnforcementRuntime } from './runtime.ts';
import {
  agentScopeCommand,
  agentScopeName,
  browserScopeName,
  FLEET_SLICE,
  ferretSliceName,
  IONICE_PREFIX,
  MACOS_NICE_PREFIX,
  MACOS_PREFIX,
  probeScopeName,
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
  /** Said out loud when a ferret had to start unconfined (the daemon log). */
  readonly warn?: (message: string) => void;
}

/** What kind of process a launch is, so the scope it gets says so. */
export interface LaunchKind {
  /** A shell an agent opened: named apart, inside the opener's shared per-ferret allowance. */
  readonly terminal?: boolean;
}

function priorityPrefix(state: Extract<EnforcementState, { kind: 'priority' }>): readonly string[] {
  if (state.wrapper === 'taskpolicy') return MACOS_PREFIX;
  return state.wrapper === 'nice' ? MACOS_NICE_PREFIX : [];
}

/** Decides, per launch, how this agent is wrapped. */
export class CgroupLaunchPlanner {
  constructor(private readonly ports: CgroupLaunchPorts) {}

  /**
   * The argv this pane must exec.
   *
   * THE WRAPPER IS PROVEN BEFORE IT IS HANDED OUT. A wrapped argv that fails to start would kill the pane
   * before the harness ran, with nobody to tell: the launch would look like a ferret that died at once and the
   * status would go on saying limits work. So the exact scope (or the Mac wrapper) is first started around
   * `true` with the same properties: if the manager went away since boot, or refuses a property, the failure
   * is HERE, recorded, re-probed, and the ferret starts unconfined with a loud warning — or, if the owner wrote
   * `enabled: true`, the launch fails. What remains is a manager that dies in the milliseconds between the
   * proof and the real start; the next launch's proof then says so.
   */
  async command(sessionId: string, command: readonly string[], kind: LaunchKind = {}): Promise<readonly string[]> {
    const config = await this.ports.limits();
    const resolved = resolveLimits(config, { memoryCeilingBytes: this.ports.host.memoryCeilingBytes });
    if (!resolved.enabled) return command;
    const own = await this.ports.sessions.facts(sessionId).catch(() => undefined);
    // Terminal exemptions require evidence that the trusted opener IS the Warden. An unreadable opener or
    // a lineage helper must not silently receive an unlimited shell, whichever target session holds it.
    const exempt =
      kind.terminal === true
        ? own?.label?.trim() === WARDEN_LABEL
        : launchIsExempt(await resolveFleetExemption(sessionId, this.ports.sessions));
    if (exempt) return command;
    const interactive = own?.interactive === true;
    return await this.limitedCommand(sessionId, command, config, resolved, interactive, kind);
  }

  /** Both shared agent browser children share a bounded slice; the owner's own browser never uses this. */
  async browserCommand(command: readonly string[]): Promise<readonly string[]> {
    const config = await this.ports.limits();
    const resolved = resolveLimits(config, { memoryCeilingBytes: this.ports.host.memoryCeilingBytes });
    if (!resolved.enabled) return command;
    return await this.limitedCommand('agent browser', command, config, resolved, false, undefined);
  }

  private async limitedCommand(
    sessionId: string,
    command: readonly string[],
    config: LimitsConfig,
    resolved: ResolvedLimits,
    interactive: boolean,
    kind: LaunchKind | undefined,
  ): Promise<readonly string[]> {
    const explicit = config.enabled === true;
    const state = await this.ports.enforcement.current();
    if (state.kind === 'priority') return await this.onMac(state, command);
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
    const allowance = ferretSliceName(kind === undefined ? 'browser' : sessionId, slice);
    const nonce = this.ports.nonce();
    const properties = ferretScopeProperties(resolved.perFerret, this.ports.host, interactive);
    try {
      await runCgroupCommand(
        this.ports.commands,
        slicePropertyCommand(slice, fleetSliceProperties(resolved.fleet, this.ports.host)),
        `could not configure ${slice}`,
      );
      await runCgroupCommand(
        this.ports.commands,
        slicePropertyCommand(allowance, properties),
        `could not configure ${allowance}`,
      );
      await runCgroupCommand(
        this.ports.commands,
        agentScopeCommand({ scope: probeScopeName(nonce), slice: allowance, properties: [], command: ['true'] }),
        `could not start a scope in ${allowance}`,
      );
    } catch (error) {
      // The manager may have gone away since boot: ask again (rate limited) so the status says so.
      const reason = failureText(error);
      this.ports.enforcement.recordLaunchFailure(reason);
      await this.ports.enforcement.afterFailure();
      if (explicit) throw error instanceof CgroupError ? error : new CgroupError('failed', reason);
      this.ports.warn?.(`starting ${sessionId} without ferret limits: ${reason}`);
      return [...ionice, ...command];
    }
    this.ports.enforcement.recordLaunchSuccess();
    return agentScopeCommand({
      // A terminal's nonce starts with `t`: still one session's scope (the name keeps the session id) but never
      // the same unit as that session's harness.
      scope:
        kind === undefined
          ? browserScopeName(nonce)
          : agentScopeName(sessionId, kind.terminal === true ? `t${nonce}` : nonce),
      slice: allowance,
      properties: [],
      command: [...ionice, ...command],
    });
  }

  /**
   * macOS is best effort by design: a Mac that cannot lower priority just runs the ferret as it always did, and
   * `limits.yaml` cannot demand a guarantee there. The wrapper is proven the same way as a scope.
   */
  private async onMac(
    state: Extract<EnforcementState, { kind: 'priority' }>,
    command: readonly string[],
  ): Promise<readonly string[]> {
    const prefix = priorityPrefix(state);
    if (prefix.length === 0) return command;
    const proof = await this.ports.commands.execute([...prefix, 'true']).then(
      result => (result.code === 0 ? undefined : result.stderr.trim() || `exit ${result.code}`),
      (error: unknown) => failureText(error),
    );
    if (proof === undefined) {
      this.ports.enforcement.recordLaunchSuccess();
      return [...prefix, ...command];
    }
    this.ports.enforcement.recordLaunchFailure(proof);
    await this.ports.enforcement.afterFailure();
    this.ports.warn?.(`starting a ferret without a lower priority: ${proof}`);
    return command;
  }
}

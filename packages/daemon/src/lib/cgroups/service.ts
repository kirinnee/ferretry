/**
 * What the settings surface reads and what a save actually does.
 *
 * WHAT A SAVE CAN AND CANNOT DO LIVE. A managed agent's scope takes new limits immediately — that
 * is the whole reason the scope exists. Nothing else can: a live process cannot be adopted INTO a
 * transient scope, and it cannot be moved OUT of one either, so both transitions are reported as a
 * restart requirement rather than performed. Turning enforcement off therefore writes no
 * `CPUQuota=infinity`; already-scoped sessions keep the limits they were launched with until they
 * are relaunched, and this daemon says so instead of claiming a live release it did not perform.
 *
 * UNKNOWN IS NOT UNCAPPED. A pane whose placement cannot be read produces a warning and is
 * conservatively marked restart-required. The opposite reading — "we could not see a scope, so
 * there isn't one" — is the exact shape of the absent-evidence-read-as-a-benign-result bug this
 * repository has fixed repeatedly.
 *
 * A SAVE PERSISTS EVEN WHEN THE HOST REFUSES THE APPLY. The operator's intent is durable and the
 * next relaunch honours it; the host's refusal comes back as a warning with the manager's own words
 * in it, and every live session is marked restart-required because none of them provably received
 * the new value. Reporting the save as a failure would be worse in both directions: it would hide
 * the fact that the document DID change, and it would leave the surface showing the old numbers.
 * The refusal is also WRITTEN DOWN — see `status.ts` — so a page refresh or a daemon restart cannot
 * turn a session that is knowably running under stale limits back into a current one.
 *
 * SERIALIZED AGAINST SESSION BOOTSTRAP, not against itself only. The executor is the session
 * lifecycle's own — the single owner of that ordering in this process — taken exclusively here. So
 * a save cannot land between a launch choosing its argv and the pane existing, and two saves cannot
 * interleave their read-modify-write of one document.
 */

import type { CgroupConfig, CgroupConfigPatch, CgroupConfigView } from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import { CgroupError, failureText, runCgroupCommand } from './apply.ts';
import { applyCgroupConfigPatch, parseStoredCgroupConfig } from './config.ts';
import { resolveFleetExemption } from './exemption.ts';
import { cgroupsSupported, effectiveCgroupLimits } from './limits.ts';
import type {
  CgroupApplyStatusStore,
  CgroupCommandPort,
  CgroupConfigStore,
  CgroupHostFacts,
  CgroupPaneLedger,
  CgroupPlacementPort,
  SessionSpawnFactsPort,
} from './ports.ts';
import { agentScopeInPlacement, FLEET_SLICE, placedUnderSlice, slicePropertyCommand } from './scope.ts';
import {
  type CgroupApplyStatus,
  type CgroupScopeApplyFailure,
  cleanCgroupApplyStatus,
  fleetApplyWarning,
  parseStoredCgroupApplyStatus,
  pendingCgroupApplyStatus,
  scopeApplyWarning,
  unappliedCgroupEvidence,
} from './status.ts';

export interface CgroupServicePorts {
  readonly store: CgroupConfigStore;
  /** Where a refused apply is written down, so a later read cannot report a stale scope as
   *  current. See `status.ts` for what supersedes an entry. */
  readonly applyStatus: CgroupApplyStatusStore;
  readonly host: CgroupHostFacts;
  readonly commands: CgroupCommandPort;
  readonly placements: CgroupPlacementPort;
  readonly panes: CgroupPaneLedger;
  readonly sessions: SessionSpawnFactsPort;
  /** The session lifecycle's own executor. Taken exclusively, never keyed: a limit change is about
   *  every session at once, and the point is to exclude a bootstrap that has not created its pane. */
  readonly serial: SerialExecutor;
  /** This daemon's own pid, so its exclusion from the fleet slice is measured rather than asserted. */
  readonly daemonPid: number;
  /** Overridable only so a live verification can exercise the real path against a throwaway unit. */
  readonly slice?: string;
}

/** One live pane, resolved against both the cgroup tree and its session's own document. */
interface PanePlacement {
  readonly sessionId: string;
  /** The managed scope it is in, when it is in one. */
  readonly scope?: string;
  /** True when this session must never be capped; see `exemption.ts`. */
  readonly exempt: boolean;
  /** Set exactly when something about this pane could not be established. */
  readonly warning?: string;
}

interface LiveCgroupState {
  readonly placements: readonly PanePlacement[];
  readonly warnings: readonly string[];
  /** The pane ledger did not enumerate its whole population. */
  readonly incomplete?: string;
}

export class CgroupService {
  constructor(private readonly ports: CgroupServicePorts) {}

  private get slice(): string {
    return this.ports.slice ?? FLEET_SLICE;
  }

  /**
   * What this daemon is configured to enforce, and what is true on the host right now.
   *
   * The shape of a placement is not the whole answer. A session that kept its old cap because the
   * host manager refused the write still HAS a scope and enforcement is still on, so shape alone
   * calls it current — which is why the refusal the save recorded is read back here and applied on
   * top. This read never rewrites that record; only a save supersedes it.
   */
  async config(): Promise<CgroupConfigView> {
    const stored = parseStoredCgroupConfig(await this.ports.store.read());
    const recorded = parseStoredCgroupApplyStatus(await this.ports.applyStatus.read(), stored.config);
    const live = await this.live();
    const restart = live.placements.flatMap(placement => {
      if (placement.exempt && placement.warning === undefined) return [];
      // A pane whose state could not be established is restart-required in every direction: the
      // daemon cannot claim it holds the current limits, nor that it holds none.
      if (placement.warning !== undefined) return [placement.sessionId];
      return (placement.scope !== undefined) === stored.config.enabled ? [] : [placement.sessionId];
    });
    const unapplied = unappliedCgroupEvidence({
      stored: recorded,
      placements: live.placements,
      slice: this.slice,
    });
    return await this.view(
      stored.config,
      live.placements,
      [...restart, ...unapplied.restart],
      [...stored.warnings, ...recorded.warnings, ...live.warnings, ...unapplied.warnings],
    );
  }

  /**
   * Save an operator's change and apply as much of it as can be applied live.
   *
   * The patch is merged onto whatever is stored NOW rather than onto a value the caller read
   * earlier, inside the exclusive section, so two saves cannot lose one another's fields.
   */
  async updateConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView> {
    return await this.ports.serial.runExclusive(async () => await this.save(patch));
  }

  private async save(patch: CgroupConfigPatch): Promise<CgroupConfigView> {
    const stored = parseStoredCgroupConfig(await this.ports.store.read());
    if (stored.readFailure !== undefined)
      throw new CgroupError(
        'failed',
        `could not update resource limits because the stored configuration could not be read (${stored.readFailure}); no configuration or apply record was changed`,
      );
    let merged: CgroupConfig;
    try {
      merged = applyCgroupConfigPatch(stored.config, patch);
    } catch (error) {
      throw new CgroupError('invalid', failureText(error));
    }
    if (merged.enabled && !cgroupsSupported(this.ports.host))
      throw new CgroupError(
        'unsupported',
        `resource limits need Linux with the unified cgroup hierarchy; this host reports ${this.ports.host.platform}${this.ports.host.unifiedHierarchy ? '' : ' without it'}`,
      );
    // WRITE-AHEAD, before either durable intent or live host state changes. This is what makes an
    // interrupted identical-config retry conservative too: content linkage alone cannot tell two
    // attempts with the same numbers apart, while a pending record can.
    await this.beginRecord(merged);
    await this.ports.store.write(merged);
    const live = await this.live();
    const applied = merged.enabled
      ? await this.enforce(merged, live)
      : // Turning enforcement off writes nothing to the host, so there is nothing left it could
        // have failed to apply: this save supersedes every recorded refusal.
        { restart: release(live.placements), warnings: [], status: cleanCgroupApplyStatus(merged) };
    const recorded = await this.record(applied.status);
    return await this.view(merged, live.placements, applied.restart, [
      ...stored.warnings,
      ...live.warnings,
      ...applied.warnings,
      ...recorded,
    ]);
  }

  /** Refuse before changing anything when conservative write-ahead evidence cannot be established. */
  private async beginRecord(config: CgroupConfig): Promise<void> {
    try {
      await this.ports.applyStatus.write(pendingCgroupApplyStatus(config));
    } catch (error) {
      throw new CgroupError(
        'failed',
        `could not begin recording the resource-limit apply (${failureText(error)}); no configuration was changed`,
      );
    }
  }

  /**
   * Write down what this save could and could not apply.
   *
   * A failure to record is a warning rather than a refusal: the document DID change and the host
   * DID receive whatever it accepted, and turning that into a rejected save would leave the surface
   * describing a state the daemon is no longer in. What it must never do is pass in silence — an
   * unrecorded refusal is exactly the stale-scope-read-as-current bug this record exists to close.
   */
  private async record(status: CgroupApplyStatus): Promise<readonly string[]> {
    try {
      await this.ports.applyStatus.write(status);
      return [];
    } catch (error) {
      return [
        `could not record the exact outcome of this save (${failureText(error)}); the durable record remains conservative, so later reads require affected sessions to restart until the limits are saved again`,
      ];
    }
  }

  /**
   * Put the new limits on the fleet slice and on every managed scope that already exists.
   *
   * A slice that cannot be configured is reported once and makes every non-exempt live session
   * restart-required: none of them provably has the new ceiling, and per-scope work underneath an
   * unconfigured aggregate would be describing a hierarchy that is not there.
   */
  private async enforce(
    config: CgroupConfig,
    live: LiveCgroupState,
  ): Promise<{
    readonly restart: readonly string[];
    readonly warnings: readonly string[];
    readonly status: CgroupApplyStatus;
  }> {
    const placements = live.placements;
    const limits = effectiveCgroupLimits(config, this.ports.host);
    const governed = placements.filter(placement => !placement.exempt || placement.warning !== undefined);
    try {
      await runCgroupCommand(
        this.ports.commands,
        slicePropertyCommand(this.slice, limits.fleet),
        `could not configure ${this.slice}`,
      );
    } catch (error) {
      const failure = failureText(error);
      return {
        restart: governed.map(placement => placement.sessionId),
        warnings: [fleetApplyWarning(failure, this.slice)],
        status: this.applyStatus(config, live, { fleet: failure, scopes: [] }),
      };
    }
    const warnings: string[] = [];
    const restart: string[] = [];
    const scopes: CgroupScopeApplyFailure[] = [];
    for (const placement of governed) {
      if (placement.scope === undefined) {
        // Either unreadable, or a pane launched before enforcement was on. Neither can be adopted
        // into a transient scope after the fact.
        restart.push(placement.sessionId);
        continue;
      }
      try {
        await runCgroupCommand(
          this.ports.commands,
          slicePropertyCommand(placement.scope, limits.perAgent),
          `could not update ${placement.scope}`,
        );
      } catch (error) {
        const refused: CgroupScopeApplyFailure = {
          sessionId: placement.sessionId,
          scope: placement.scope,
          failure: failureText(error),
        };
        scopes.push(refused);
        restart.push(placement.sessionId);
        warnings.push(scopeApplyWarning(refused));
      }
    }
    return { restart, warnings, status: this.applyStatus(config, live, { scopes }) };
  }

  /** Bind one apply outcome to its exact config and retain every pane the save could not address. */
  private applyStatus(
    config: CgroupConfig,
    live: LiveCgroupState,
    applied: Pick<CgroupApplyStatus, 'fleet' | 'scopes'>,
  ): CgroupApplyStatus {
    const unproven = live.placements.flatMap(placement =>
      placement.warning === undefined ? [] : [{ sessionId: placement.sessionId, failure: placement.warning }],
    );
    return {
      config,
      ...(applied.fleet === undefined ? {} : { fleet: applied.fleet }),
      scopes: applied.scopes,
      unproven,
      ...(live.incomplete === undefined ? {} : { incomplete: live.incomplete }),
    };
  }

  /**
   * Every live pane, placed in the tree and checked against its own session document.
   *
   * A REGISTRATION THIS DAEMON COULD NOT PROVE IS STILL A PANE. It becomes a placement with no
   * scope and a warning, which every caller already reads as "restart-required, never hot-applied"
   * — so a damaged registration or a recycled pid produces conservative evidence instead of an
   * unhandled failure on a settings read, and never an address a property write could land on.
   */
  private async live(): Promise<LiveCgroupState> {
    const panes = await this.ports.panes.live();
    const placements = await Promise.all(
      panes.panes.map(async pane => await this.placementOf(pane.sessionId, pane.pid)),
    );
    const unproven = panes.unproven.map(pane => ({
      sessionId: pane.sessionId,
      exempt: false,
      warning: pane.failure,
    }));
    return {
      placements: [...placements, ...unproven],
      warnings: panes.incomplete === undefined ? [] : [panes.incomplete],
      ...(panes.incomplete === undefined ? {} : { incomplete: panes.incomplete }),
    };
  }

  private async placementOf(sessionId: string, pid: number): Promise<PanePlacement> {
    const exemption = await resolveFleetExemption(sessionId, this.ports.sessions);
    const exempt = exemption !== 'governed';
    let placement: string;
    try {
      placement = await this.ports.placements.placement(pid);
    } catch (error) {
      return {
        sessionId,
        exempt,
        warning: `could not read the cgroup placement of ${sessionId} (pid ${pid}): ${failureText(error)}`,
      };
    }
    if (exemption === 'unknown')
      return {
        sessionId,
        exempt,
        warning: `could not read the spawn record of ${sessionId}, so it was left uncapped; relaunch it once its session document is readable`,
      };
    const underSlice = placedUnderSlice(placement, this.slice);
    // The claim the settings surface makes about supervision, MEASURED. An exempt session that
    // somehow sits inside the capped slice is the one state that would make the copy a lie.
    if (exempt && underSlice)
      return {
        sessionId,
        exempt,
        warning: `${sessionId} is supervision but is inside ${this.slice}; relaunch it so it is not bounded by the fleet's own cap`,
      };
    const scope = agentScopeInPlacement(placement);
    if (scope === undefined) return { sessionId, exempt };
    /**
     * A SCOPE NAME IS NOT A PLACEMENT. `agentScopeInPlacement` recognises this product's scope
     * naming anywhere in the tree, and a unit can carry that name while sitting somewhere else
     * entirely — a scope left over from a previous `fleetSlice`, or one a person ran by hand. Writing
     * the aggregate's per-agent property onto it would report enforcement this daemon's own slice is
     * not providing, so a scope that is not beneath the configured slice is treated as unmanaged:
     * warned about, marked restart-required, and never hot-applied.
     */
    if (!underSlice)
      return {
        sessionId,
        exempt,
        warning: `${sessionId} is in ${scope}, which is not beneath ${this.slice}; its limits are not this daemon's to change, so relaunch it to bring it under the configured aggregate`,
      };
    return { sessionId, exempt, scope };
  }

  /**
   * The complete answer, including the one fact nothing else in this daemon establishes: that the
   * process serving this very request is not itself inside the slice it is configuring.
   */
  private async view(
    config: CgroupConfig,
    placements: readonly PanePlacement[],
    restart: readonly string[],
    warnings: readonly string[],
  ): Promise<CgroupConfigView> {
    const supported = cgroupsSupported(this.ports.host);
    const unenforceable =
      config.enabled && !supported
        ? [
            `enforcement is enabled in the saved document but this host cannot enforce it (${this.ports.host.platform}), so every agent launches uncapped`,
          ]
        : [];
    const observed = placements.flatMap(placement => (placement.warning === undefined ? [] : [placement.warning]));
    return {
      config,
      supported,
      fleetSlice: this.slice,
      effective: effectiveCgroupLimits(config, this.ports.host),
      restartRequiredSessions: [...new Set(restart)].sort(),
      warnings: [...new Set([...warnings, ...observed, ...unenforceable, ...(await this.daemonWarnings())])],
    };
  }

  /** Proof — not a claim — that this daemon is outside the slice it caps. An unreadable placement is
   *  reported as unproven rather than passed over, because "we could not look" and "we looked and it
   *  is outside" are the two answers this surface must never merge. */
  private async daemonWarnings(): Promise<readonly string[]> {
    try {
      const placement = await this.ports.placements.placement(this.ports.daemonPid);
      return placedUnderSlice(placement, this.slice)
        ? [
            `this daemon (pid ${this.ports.daemonPid}) is itself inside ${this.slice}; restart it outside the slice before relying on these limits`,
          ]
        : [];
    } catch (error) {
      return [`could not prove this daemon is outside ${this.slice}: ${failureText(error)}`];
    }
  }
}

/**
 * Turning enforcement off.
 *
 * Nothing is written to the host. A managed process cannot be reparented out of its transient
 * scope, so it keeps its limits until it is relaunched — and a pane whose placement is unknown is
 * reported the same way, because claiming a cap was lifted on evidence nobody has is the failure
 * this whole surface is built to avoid.
 */
function release(placements: readonly PanePlacement[]): readonly string[] {
  return placements
    .filter(placement => placement.warning !== undefined || (!placement.exempt && placement.scope !== undefined))
    .map(placement => placement.sessionId);
}

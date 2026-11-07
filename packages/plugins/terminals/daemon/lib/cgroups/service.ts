/**
 * What the settings surface reads: the limits in force on this machine, right now.
 *
 * READ-ONLY. `limits.yaml` is the source of truth and the config-file service is its only writer (it
 * holds a loosening for the owner to confirm); this answers the question "what is actually in force
 * and is it working?". The view is built from the file in effect, the last probe of the machine, the
 * disk scheduler and the memory watcher's last look — nothing here touches a ferret.
 */
import { type LimitsConfig, type LimitsView } from '../protocol/limits.ts';
import { failureText } from './apply.ts';
import type {
  CgroupHostFacts,
  CgroupPlacementPort,
  DiskSchedulerPort,
  ServiceWeights,
  ServiceWeightsPort,
} from './ports.ts';
import type { EnforcementRuntime } from './runtime.ts';
import { FLEET_SLICE, placedUnderSlice } from './scope.ts';
import { buildLimitsView } from './view.ts';
import type { FleetMemoryWatcher } from './watch.ts';

export interface LimitsServicePorts {
  readonly limits: () => Promise<LimitsConfig>;
  readonly host: CgroupHostFacts;
  readonly enforcement: EnforcementRuntime;
  readonly disk: DiskSchedulerPort;
  readonly services: ServiceWeightsPort;
  readonly watcher: FleetMemoryWatcher;
  readonly placements: CgroupPlacementPort;
  readonly daemonPid: number;
  readonly file: string;
  readonly uid: number;
  readonly clock: (iso: string) => string;
  readonly slice?: string;
}

export class LimitsService {
  constructor(private readonly ports: LimitsServicePorts) {}

  async view(): Promise<LimitsView> {
    const [config, disk, services, live, warnings] = await Promise.all([
      this.ports.limits(),
      this.ports.disk.read().catch(() => ({})),
      this.ports.services.read().catch((): ServiceWeights => ({ voiceState: 'unknown' })),
      this.ports.watcher.state(),
      this.daemonWarnings(),
    ]);
    const launchFailure = this.ports.enforcement.lastLaunchFailure();
    return buildLimitsView({
      config,
      host: this.ports.host,
      enforcement: this.ports.enforcement.last(),
      ...(launchFailure === undefined ? {} : { launchFailure }),
      disk,
      services,
      live,
      file: this.ports.file,
      uid: this.ports.uid,
      warnings,
      clock: this.ports.clock,
    });
  }

  /** Proof — not a claim — that this daemon is outside the slice it caps. */
  private async daemonWarnings(): Promise<readonly string[]> {
    if (this.ports.host.platform !== 'linux' || !this.ports.host.unifiedHierarchy) return [];
    const slice = this.ports.slice ?? FLEET_SLICE;
    try {
      const placement = await this.ports.placements.placement(this.ports.daemonPid);
      return placedUnderSlice(placement, slice)
        ? [`this daemon is itself inside ${slice}; restart it outside the slice so a full fleet cannot slow it`]
        : [];
    } catch (error) {
      return [`could not prove this daemon is outside ${slice}: ${failureText(error)}`];
    }
  }
}

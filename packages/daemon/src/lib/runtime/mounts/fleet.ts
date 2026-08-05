import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FleetApplyPlan,
  type FleetApplyResult,
  type FleetConfig,
  type FleetLayout,
  type FleetManifest,
  FleetManifestSchema,
  FleetPlan,
  FleetUsageCollector,
  type FleetUsageProbe,
  type FleetUsageProbeResult,
  type FleetUsageSnapshot,
} from '@ferretry/fleet';
import { FileFleetConfigSource, FileFleetProvisioner } from '@ferretry/fleet/adapters';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { FoundationPaths } from '../../paths.ts';

/**
 * The daemon front door over the shared fleet library.
 *
 * There is deliberately no account editor or asset editor here. The declared YAML remains an
 * operator-owned local document; these routes expose validated evidence, the pure shared plan, the
 * last manifest that apply published, and the shared provisioner that can make that plan real.
 */

export interface FleetSubsystem {
  /** The complete last-published manifest, not a wrapper-directory reconstruction. */
  accounts(): Promise<FleetManifest>;
  config(): Promise<FleetConfig>;
  plan(): Promise<FleetApplyPlan>;
  usage(): Promise<FleetUsageSnapshot>;
  apply(): Promise<FleetApplyResult>;
}

interface FleetRouteClock {
  now(): number;
}

export interface DaemonFleetOptions {
  readonly paths: FoundationPaths;
  readonly userHome: string;
  readonly clock: FleetRouteClock;
  readonly usageProbe?: FleetUsageProbe;
}

type FleetRefusalCode =
  | 'fleet_config_missing'
  | 'fleet_config_invalid'
  | 'fleet_not_applied'
  | 'fleet_manifest_invalid'
  | 'fleet_plan_refused'
  | 'fleet_apply_refused';

/** An expected, operator-actionable refusal rather than an internal daemon defect. */
class FleetRefusal extends Error {
  constructor(
    readonly code: FleetRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FleetRefusal';
  }
}

class UnprovisionedFleetUsageProbe implements FleetUsageProbe {
  probe(): Promise<FleetUsageProbeResult> {
    return Promise.resolve({
      usageBased: false,
      ok: false,
      unavailable: true,
      unavailableReason: 'no provider quota probe is provisioned on this daemon',
    });
  }
}

function fleetLayout(paths: FoundationPaths, userHome: string): FleetLayout {
  return {
    stateHome: paths.home,
    userHome,
    fleetDirectory: paths.fleet,
    binDirectory: join(paths.fleet, 'bin'),
    homesDirectory: join(paths.fleet, 'homes'),
    assetsDirectory: join(paths.fleet, 'assets'),
    manifestPath: paths.fleetManifest,
    defaultHomeDirectories: { claude: join(userHome, '.claude'), codex: join(userHome, '.codex') },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function missingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

class MountedFleet implements FleetSubsystem {
  private readonly configPath: string;
  private readonly layout: FleetLayout;
  private readonly configSource: FileFleetConfigSource;
  private readonly planner = new FleetPlan();
  private readonly provisioner: FileFleetProvisioner;
  private readonly usageCollector: FleetUsageCollector;

  constructor(private readonly options: DaemonFleetOptions) {
    this.layout = fleetLayout(options.paths, options.userHome);
    this.configPath = join(options.paths.fleet, 'config.yaml');
    this.configSource = new FileFleetConfigSource(this.configPath);
    // FleetPlan may target both FY_HOME (the generated fleet) and explicit/default harness homes
    // under the user home. Those are the only two roots this daemon declares writable; an absolute
    // account home elsewhere remains visible in GET /plan and is refused by the shared adapter.
    this.provisioner = new FileFleetProvisioner([options.paths.home, options.userHome]);
    this.usageCollector = new FleetUsageCollector(
      options.usageProbe ?? new UnprovisionedFleetUsageProbe(),
      options.clock,
    );
  }

  async accounts(): Promise<FleetManifest> {
    return await this.loadManifest();
  }

  async config(): Promise<FleetConfig> {
    try {
      await readFile(this.configPath);
    } catch (error) {
      if (missingFile(error)) {
        throw new FleetRefusal(
          'fleet_config_missing',
          `no fleet config at ${this.configPath}; write the declared config before applying the fleet`,
        );
      }
      throw new FleetRefusal('fleet_config_invalid', `fleet config at ${this.configPath} is unreadable`);
    }

    try {
      return await this.configSource.load();
    } catch (error) {
      throw new FleetRefusal('fleet_config_invalid', errorMessage(error));
    }
  }

  async plan(): Promise<FleetApplyPlan> {
    const config = await this.config();
    try {
      return this.planner.build(config, this.layout, this.generatedAt());
    } catch (error) {
      throw new FleetRefusal('fleet_plan_refused', errorMessage(error));
    }
  }

  async usage(): Promise<FleetUsageSnapshot> {
    return await this.usageCollector.collect(await this.loadManifest());
  }

  async apply(): Promise<FleetApplyResult> {
    const plan = await this.plan();
    try {
      return await this.provisioner.apply(plan);
    } catch (error) {
      throw new FleetRefusal('fleet_apply_refused', errorMessage(error));
    }
  }

  private generatedAt(): string {
    const now = this.options.clock.now();
    if (!Number.isFinite(now)) throw new Error('the fleet clock did not return a finite instant');
    return new Date(Math.trunc(now)).toISOString();
  }

  private async loadManifest(): Promise<FleetManifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.options.paths.fleetManifest, 'utf8'));
    } catch (error) {
      if (missingFile(error)) {
        throw new FleetRefusal(
          'fleet_not_applied',
          `no published fleet manifest at ${this.options.paths.fleetManifest}; apply the fleet first`,
        );
      }
      throw new FleetRefusal(
        'fleet_manifest_invalid',
        `fleet manifest at ${this.options.paths.fleetManifest} is unreadable or invalid`,
      );
    }
    const parsed = FleetManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FleetRefusal(
        'fleet_manifest_invalid',
        `fleet manifest at ${this.options.paths.fleetManifest} is invalid`,
      );
    }
    return parsed.data;
  }
}

/** Build the production subsystem against exactly one daemon's FoundationPaths/FY_HOME. */
export function createDaemonFleetSubsystem(options: DaemonFleetOptions): FleetSubsystem {
  return new MountedFleet(options);
}

async function respond(work: () => Promise<unknown>) {
  try {
    return jsonResponse(await work());
  } catch (error) {
    if (error instanceof FleetRefusal) throw new ApiError(409, error.message, error.code);
    throw error;
  }
}

/**
 * All reads are admin because config, plans and manifests disclose homes, wrappers and settings.
 * Apply is also declared admin, then rejects a paired-device credential explicitly: a browser may
 * inspect its paired daemon, but possession of a device token can never provision the host.
 */
export function fleetRoutes(subsystem: FleetSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/accounts',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.accounts()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/config',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.config()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/plan',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.plan()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/usage',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.usage()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/apply',
      scope: 'admin',
      noStore: true,
      handle: async context => {
        if (context.credential?.tokenClass === 'device') {
          throw new ApiError(403, 'a paired device may inspect the fleet but may not apply it', 'forbidden');
        }
        return await respond(() => subsystem.apply());
      },
    },
  ];
}

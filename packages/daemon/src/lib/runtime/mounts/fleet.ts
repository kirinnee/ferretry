import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFleetUsageCollector,
  buildFleetHealthCollector,
  type FleetApplyPlan,
  type FleetApplyResult,
  type FleetConfig,
  FleetConfigSchema,
  type FleetLayout,
  type FleetManifest,
  FleetManifestSchema,
  FleetPlan,
  type FleetUsageProbe,
  type FleetUsageSnapshot,
  type FleetHealthProbe,
  type FleetHealthSnapshot,
} from '@ferretry/fleet';
import {
  AnthropicUsageProbe,
  FileFleetConfigSource,
  FileFleetProvisioner,
  fetchQuota,
  PlatformFleetCredentialStore,
  SpawnCredentialCommand,
  ProcessFleetHealthProbe,
  runFleetHealthProcess,
} from '@ferretry/fleet/adapters';
import { z } from 'zod';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { FoundationPaths } from '../../paths.ts';
import type { FileSystemPort } from '../../ports.ts';

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
  /** The deliberately narrow, remotely-safe profile environment editor. */
  environment(): Promise<FleetEnvironmentView>;
  updateEnvironment(request: FleetEnvironmentUpdate): Promise<FleetEnvironmentView>;
  plan(): Promise<FleetApplyPlan>;
  usage(): Promise<FleetUsageSnapshot>;
  /** Explicit liveness evidence, keyed to this daemon's FY_HOME. */
  health(): Promise<FleetHealthSnapshot>;
  apply(): Promise<FleetApplyResult>;
}

interface FleetRouteClock {
  now(): number;
}

export interface DaemonFleetOptions {
  readonly paths: FoundationPaths;
  readonly userHome: string;
  readonly clock: FleetRouteClock;
  /** The state filesystem owns the durable, atomic replacement of config.yaml. */
  readonly files: Pick<FileSystemPort, 'writeTextAtomic'>;
  readonly usageProbe?: FleetUsageProbe;
  readonly healthProbe?: FleetHealthProbe;
  /**
   * This host's platform, spelled the way the Node runtime spells it, and the keychain `acct` attribute the
   * credential store falls back to on macOS. Both are supplied rather than read: the composition root
   * is the only place allowed to touch the environment, and injecting them is what lets a test drive
   * the macOS credential path on a host that is not macOS.
   */
  readonly platform: string;
  readonly keychainAccount?: string;
}

const EnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string());
const FleetEnvironmentUpdateSchema = z
  .strictObject({
    profile: z.string().trim().min(1),
    environment: EnvironmentSchema,
    mode: z.enum(['merge', 'replace']),
  })
  .readonly();

type FleetEnvironmentUpdate = z.output<typeof FleetEnvironmentUpdateSchema>;

interface FleetEnvironmentView {
  readonly profiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:api[_-]?key|credential|password|secret|token|auth)/iu;
const MACHINE_ENVIRONMENT_NAME = /(?:^|_)(?:address|host(?:name)?|home|path|port)(?:$|_)/iu;
const MACHINE_ENVIRONMENT_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/~]|[A-Za-z]:[\\/])/iu;

/** Environment values are configuration only when they can travel safely. Credentials, local
 * paths, addresses and ports must stay on the machine that owns them. Refusing the entire profile
 * is intentional: presenting a redacted value as a copyable one invites an accidental deletion. */
function portableEnvironment(environment: Readonly<Record<string, string>>, profile: string): Record<string, string> {
  for (const [name, value] of Object.entries(environment)) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(name))
      throw new FleetRefusal(
        'fleet_environment_refused',
        `profile ${profile} contains credential-like ${name}; it is not remotely editable or copyable`,
      );
    if (MACHINE_ENVIRONMENT_NAME.test(name) || MACHINE_ENVIRONMENT_VALUE.test(value))
      throw new FleetRefusal(
        'fleet_environment_refused',
        `profile ${profile} contains machine-bound ${name}; it is not remotely editable or copyable`,
      );
  }
  return { ...environment };
}

type FleetRefusalCode =
  | 'fleet_config_missing'
  | 'fleet_config_invalid'
  | 'fleet_not_applied'
  | 'fleet_manifest_invalid'
  | 'fleet_plan_refused'
  | 'fleet_apply_refused'
  | 'fleet_environment_refused';

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

  constructor(private readonly options: DaemonFleetOptions) {
    this.layout = fleetLayout(options.paths, options.userHome);
    this.configPath = join(options.paths.fleet, 'config.yaml');
    this.configSource = new FileFleetConfigSource(this.configPath);
    // FleetPlan may target both FY_HOME (the generated fleet) and explicit/default harness homes
    // under the user home. Those are the only two roots this daemon declares writable; an absolute
    // account home elsewhere remains visible in GET /plan and is refused by the shared adapter.
    this.provisioner = new FileFleetProvisioner([options.paths.home, options.userHome]);
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

  async environment(): Promise<FleetEnvironmentView> {
    const config = await this.config();
    const profiles: Record<string, Record<string, string>> = {};
    for (const [name, profile] of Object.entries(config.profiles)) {
      profiles[name] = portableEnvironment(profile.env ?? {}, name);
    }
    return { profiles };
  }

  async updateEnvironment(request: FleetEnvironmentUpdate): Promise<FleetEnvironmentView> {
    const current = await this.config();
    const profile = current.profiles[request.profile];
    if (profile === undefined)
      throw new FleetRefusal('fleet_environment_refused', `profile ${request.profile} does not exist on this daemon`);
    const existing = portableEnvironment(profile.env ?? {}, request.profile);
    const incoming = portableEnvironment(request.environment, request.profile);
    const environment = request.mode === 'merge' ? { ...existing, ...incoming } : incoming;
    const next = FleetConfigSchema.parse({
      ...current,
      profiles: { ...current.profiles, [request.profile]: { ...profile, env: environment } },
    });
    // The state filesystem writes a new, synced file then renames it into place. A failed write
    // therefore leaves the last validated fleet configuration intact rather than half-replacing it.
    await this.options.files.writeTextAtomic(this.configPath, Bun.YAML.stringify(next));
    return await this.environment();
  }

  async plan(): Promise<FleetApplyPlan> {
    const config = await this.config();
    try {
      return this.planner.build(config, this.layout, this.generatedAt());
    } catch (error) {
      throw new FleetRefusal('fleet_plan_refused', errorMessage(error));
    }
  }

  /**
   * Quota, collected through the same factory and the same probe the CLI uses.
   *
   * Built per request rather than once at mount, because the thresholds, the concurrency and the
   * per-credential grouping are all configuration: a collector assembled before the configuration was
   * read could only ever use the defaults. Two call sites each assembling their own is how this route
   * and `fy fleet usage` would come to disagree about whether an account has quota left.
   */
  async usage(): Promise<FleetUsageSnapshot> {
    const [config, manifest] = [await this.config(), await this.loadManifest()];
    return await buildFleetUsageCollector(
      config,
      this.options.usageProbe ?? this.probe(config.usage.timeout),
      this.options.clock,
    ).collect(manifest);
  }

  async health(): Promise<FleetHealthSnapshot> {
    const [config, manifest] = [await this.config(), await this.loadManifest()];
    return await buildFleetHealthCollector(
      config,
      this.options.healthProbe ?? this.healthProbe(),
      this.options.clock,
    ).collect(manifest);
  }

  /**
   * This host's provider probe. Shared with the CLI so neither can drift from the other.
   *
   * The declared `usage.timeout` is passed IN, because it reached neither composition root: the probe
   * landed after the plan-time refusal list was written, so a configuration that bounded its provider
   * calls was parsed and silently dropped, and every probe ran on the adapter's own default instead.
   * That matters more now than it did — the daemon's whole quota feed collects through here, so one
   * hung provider call stalls the refresh every session, the advisor and every scraper is waiting on.
   */
  private probe(timeoutSeconds: number): FleetUsageProbe {
    return new AnthropicUsageProbe({
      fetch: fetchQuota,
      timeoutMs: timeoutSeconds * 1_000,
      credentials: new PlatformFleetCredentialStore({
        platform: this.options.platform,
        command: new SpawnCredentialCommand(),
        now: () => this.options.clock.now(),
        keychainAccount: this.options.keychainAccount ?? '',
      }),
    });
  }

  private healthProbe(): FleetHealthProbe {
    return new ProcessFleetHealthProbe({
      process: runFleetHealthProcess,
      // This is under the mounted daemon's state home: one daemon cannot reuse another's success.
      cachePath: join(this.options.paths.fleet, 'health-successes.json'),
      now: () => this.options.clock.now(),
    });
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
      path: '/v1/fleet/environment',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.environment()),
    },
    {
      method: 'PUT',
      path: '/v1/fleet/environment',
      scope: 'admin',
      noStore: true,
      handle: async context => {
        if (context.credential?.tokenClass === 'device')
          throw new ApiError(403, 'a paired device may inspect fleet environment but may not change it', 'forbidden');
        return await respond(
          async () => await subsystem.updateEnvironment(await parseBody(context.request, FleetEnvironmentUpdateSchema)),
        );
      },
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
      method: 'GET',
      path: '/v1/fleet/health',
      scope: 'admin',
      noStore: true,
      handle: async () => await respond(() => subsystem.health()),
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

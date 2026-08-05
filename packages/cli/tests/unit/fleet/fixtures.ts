import type {
  FleetApplyPlan,
  FleetApplyResult,
  FleetConfig,
  FleetLoginResult,
  FleetManifest,
  FleetManifestAccount,
  FleetScaffoldResult,
  FleetUsage,
  FleetUsageSnapshot,
} from '@ferretry/fleet';
import type {
  IFleetApplier,
  IFleetClock,
  IFleetConfigSource,
  IFleetLoginService,
  IFleetLoginServiceFactory,
  IFleetManifestSource,
  IFleetOutput,
  IFleetPlanner,
  IFleetScaffolder,
  IFleetUsageCollector,
  IFleetUsageCollectorFactory,
  IRecommendationGateway,
} from '../../../src/lib/fleet/ports';
import type { RecommendationRequest, TeamRecommendation } from '../../../src/lib/fleet/wire';

export const ACCOUNT_ID = '00000000-0000-4000-8000-00000000c1a0';
export const GENERATED_AT = '2026-07-31T09:00:00.000Z';

/** Captures what a controller printed, keeping stdout and warnings apart. */
export class CapturingOutput implements IFleetOutput {
  readonly lines: string[] = [];
  readonly warnings: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export function account(overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount {
  return {
    id: ACCOUNT_ID,
    kind: 'claude',
    mode: 'auto',
    wrapper: 'fy-claude-work',
    home: '/state/fleet/homes/work',
    displayName: 'Claude (work)',
    defaultModel: 'opus',
    models: [{ id: 'opus', available: true }],
    available: true,
    unavailableReason: null,
    ...overrides,
  } as FleetManifestAccount;
}

export function manifest(accounts: readonly FleetManifestAccount[] = [account()]): FleetManifest {
  return { version: 1, generatedAt: GENERATED_AT, accounts } as FleetManifest;
}

export function plan(overrides: Partial<FleetApplyPlan> = {}): FleetApplyPlan {
  return {
    manifest: manifest(),
    manifestPath: '/state/fleet/manifest.json',
    operations: [
      { kind: 'directory', path: '/state/fleet/bin', mode: 0o700 },
      { kind: 'file', path: '/state/fleet/bin/fy-claude-work', content: '#!/bin/sh\n', mode: 0o755 },
    ],
    ...overrides,
  };
}

export function applyResult(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    accountCount: 1,
    operationCount: 2,
    manifestPath: '/state/fleet/manifest.json',
    prunedWrappers: [],
    ...overrides,
  };
}

export function usageRow(overrides: Partial<FleetUsage> = {}): FleetUsage {
  return {
    accountId: ACCOUNT_ID,
    kind: 'claude',
    usageBased: true,
    ok: true,
    unavailable: false,
    shortWindow: { usedPercent: 42 },
    longWindow: { usedPercent: 11 },
    atLimit: false,
    ...overrides,
  } as FleetUsage;
}

export function usageSnapshot(accounts: readonly FleetUsage[] = [usageRow()]): FleetUsageSnapshot {
  return { at: 1_785_000_000_000, accounts } as FleetUsageSnapshot;
}

export function recommendation(overrides: Partial<TeamRecommendation> = {}): TeamRecommendation {
  return {
    task: 'port the remaining CLI command groups',
    classification: 'implementation',
    reasoning: 'a long, many-checkpoint port benefits from a high-context implementer',
    roles: [
      {
        role: 'implementer',
        why: 'the work is mostly writing modules with tests',
        primary: {
          agent: 'sol',
          accountId: ACCOUNT_ID,
          model: 'gpt-5.6',
          tradeoff: 'expensive, but holds the whole unit',
          score: 0.91,
        },
        alternatives: [
          { agent: 'terra', accountId: ACCOUNT_ID, model: 'gpt-5.6', tradeoff: 'cheaper, shorter context', score: 0.7 },
        ],
      },
    ],
    exclusions: [],
    warnings: [],
    ...overrides,
  };
}

/** A config source answering with a fixed configuration; the CLI never parses YAML itself. */
export class StubConfigSource implements IFleetConfigSource {
  constructor(private readonly config: FleetConfig = { accounts: [] } as unknown as FleetConfig) {}

  load(): Promise<FleetConfig> {
    return Promise.resolve(this.config);
  }
}

/** A manifest source; `null` models a host that has never applied. */
export class StubManifestSource implements IFleetManifestSource {
  constructor(private readonly value: FleetManifest | null = manifest()) {}

  load(): Promise<FleetManifest | undefined> {
    return Promise.resolve(this.value ?? undefined);
  }
}

/** A planner recording the instant it stamped, so `--dry-run` and apply can be shown to share one. */
export class RecordingPlanner implements IFleetPlanner {
  readonly stamps: string[] = [];

  constructor(private readonly value: FleetApplyPlan = plan()) {}

  build(_config: FleetConfig, generatedAt: string): FleetApplyPlan {
    this.stamps.push(generatedAt);
    return this.value;
  }
}

/** An applier recording every plan it was handed. */
export class RecordingApplier implements IFleetApplier {
  readonly applied: FleetApplyPlan[] = [];

  constructor(private readonly result: FleetApplyResult = applyResult()) {}

  apply(plan: FleetApplyPlan): Promise<FleetApplyResult> {
    this.applied.push(plan);
    return Promise.resolve(this.result);
  }
}

/**
 * A collector recording the manifest it was asked about, and the configuration it was built from.
 *
 * It is its own factory: the controller builds a collector per invocation so `usage.concurrency` and
 * `usage.atLimitPercent` are honoured, and `configs` is how a test proves the configuration reached
 * it rather than being parsed and dropped.
 */
export class RecordingUsageCollector implements IFleetUsageCollector, IFleetUsageCollectorFactory {
  readonly collected: FleetManifest[] = [];
  readonly configs: FleetConfig[] = [];

  constructor(private readonly snapshot: FleetUsageSnapshot = usageSnapshot()) {}

  forConfig(config: FleetConfig): IFleetUsageCollector {
    this.configs.push(config);
    return this;
  }

  collect(manifest: FleetManifest): Promise<FleetUsageSnapshot> {
    this.collected.push(manifest);
    return Promise.resolve(this.snapshot);
  }
}

/** A login service recording the manifest and the selection it was handed. */
export class RecordingLoginService implements IFleetLoginService, IFleetLoginServiceFactory {
  readonly configs: FleetConfig[] = [];
  readonly requests: Array<{ manifest: FleetManifest; accountIds: readonly string[] | undefined }> = [];

  constructor(
    private readonly results: readonly FleetLoginResult[] = [{ accountId: ACCOUNT_ID, status: 'logged-in' }],
  ) {}

  forConfig(config: FleetConfig): IFleetLoginService {
    this.configs.push(config);
    return this;
  }

  login(manifest: FleetManifest, accountIds?: readonly string[]): Promise<readonly FleetLoginResult[]> {
    this.requests.push({ manifest, accountIds });
    return Promise.resolve(this.results);
  }
}

/** A scaffolder recording that it ran, and answering with a fixed result. */
export class RecordingScaffolder implements IFleetScaffolder {
  calls = 0;

  constructor(private readonly result: FleetScaffoldResult = scaffoldResult()) {}

  scaffold(): Promise<FleetScaffoldResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

export function scaffoldResult(overrides: Partial<FleetScaffoldResult> = {}): FleetScaffoldResult {
  return {
    created: ['/state/fleet/config.yaml'],
    kept: [],
    directories: ['/state/fleet', '/state/fleet/bin', '/state/fleet/homes', '/state/fleet/assets'],
    pathEntry: 'export PATH="/state/fleet/bin:$PATH"',
    ...overrides,
  };
}

/** A clock frozen at the fixture instant. */
export class FrozenClock implements IFleetClock {
  constructor(private readonly instant = GENERATED_AT) {}

  now(): string {
    return this.instant;
  }
}

/** A recommender recording what it was asked. */
export class RecordingRecommendationGateway implements IRecommendationGateway {
  readonly requests: RecommendationRequest[] = [];

  constructor(private readonly value: TeamRecommendation = recommendation()) {}

  recommend(request: RecommendationRequest): Promise<TeamRecommendation> {
    this.requests.push(request);
    return Promise.resolve(this.value);
  }
}

import type {
  FleetApplyCommittedState,
  FleetApplyFailure,
  FleetApplyPlan,
  FleetApplyPreview,
  FleetApplyResult,
  FleetConfig,
  FleetAccountHealth,
  FleetHealthSnapshot,
  FleetIdentity,
  FleetIdentityStatus,
  FleetLoginRequest,
  FleetLoginResult,
  FleetManifest,
  FleetManifestAccount,
  FleetScaffoldResult,
  FleetUsage,
  FleetUsageSnapshot,
} from '@ferretry/fleet';
import { FleetApplyFailureError } from '@ferretry/fleet';
import type { FleetAccountSharing, FleetSharing } from '@ferretry/protocol';
import type {
  FleetScaffoldOptions,
  IFleetApplier,
  IFleetClock,
  IFleetConfigSource,
  IFleetHealthCollectorFactory,
  IFleetIdentitySource,
  IFleetLoginService,
  IFleetManifestSource,
  IFleetOutput,
  IFleetPlanner,
  IFleetScaffolder,
  IFleetSharingGateway,
  IFleetUsageCollector,
  IFleetUsageCollectorFactory,
  IRecommendationGateway,
} from '../../../src/lib/fleet/ports';
import type { RecommendationRequest, TeamRecommendation } from '../../../src/lib/fleet/wire';

export const ACCOUNT_ID = '00000000-0000-4000-8000-00000000c1a0';
export const IDENTITY_KEY = 'claude:Claude (work)';
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

export function plan(overrides: Partial<FleetApplyPreview> = {}): FleetApplyPreview {
  return {
    manifest: manifest(),
    manifestPath: '/state/fleet/manifest.json',
    operations: [
      { kind: 'directory', path: '/state/fleet/bin', mode: 0o700 },
      { kind: 'file', path: '/state/fleet/bin/fy-claude-work', content: '#!/bin/sh\n', mode: 0o755 },
    ],
    sharedHistoryRequests: [],
    sharedHistory: [],
    ...overrides,
  };
}

export function applyResult(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    accountCount: 1,
    operationCount: 2,
    manifestPath: '/state/fleet/manifest.json',
    prunedWrappers: [],
    sharedHistory: [],
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

function healthRow(overrides: Partial<FleetAccountHealth> = {}): FleetAccountHealth {
  return {
    accountId: ACCOUNT_ID,
    kind: 'claude',
    verdict: 'healthy',
    reason: 'provider_accepted',
    evidence: 'anthropic_usage',
    lastCheckedAt: 1_785_000_000_000,
    verdictAt: 1_785_000_000_000,
    lastCheckInconclusive: false,
    ...overrides,
  } as FleetAccountHealth;
}

function healthSnapshot(accounts: readonly FleetAccountHealth[] = [healthRow()]): FleetHealthSnapshot {
  return { at: 1_785_000_000_000, accounts } as FleetHealthSnapshot;
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
  readonly previewed: FleetApplyPlan[] = [];

  constructor(private readonly result: FleetApplyResult = applyResult()) {}

  preview(plan: FleetApplyPlan): Promise<FleetApplyPreview> {
    this.previewed.push(plan);
    return Promise.resolve({ ...plan, sharedHistory: [] });
  }

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

/** The health twin of the usage fixture, including the per-configuration construction boundary. */
export class RecordingHealthCollector implements IFleetHealthCollectorFactory {
  readonly collected: FleetManifest[] = [];
  readonly configs: FleetConfig[] = [];

  constructor(private readonly snapshot: FleetHealthSnapshot = healthSnapshot()) {}

  forConfig(config: FleetConfig) {
    this.configs.push(config);
    return this;
  }

  collect(manifest: FleetManifest): Promise<FleetHealthSnapshot> {
    this.collected.push(manifest);
    return Promise.resolve(this.snapshot);
  }
}

/** A login service recording the request it was handed. */
export class RecordingLoginService implements IFleetLoginService {
  readonly requests: FleetLoginRequest[] = [];

  constructor(
    private readonly results: readonly FleetLoginResult[] = [
      { accountId: ACCOUNT_ID, identity: IDENTITY_KEY, status: 'logged-in' },
    ],
  ) {}

  login(request: FleetLoginRequest): Promise<readonly FleetLoginResult[]> {
    this.requests.push(request);
    return Promise.resolve(this.results);
  }
}

/**
 * An identity source recording what it was asked, answering with one declared identity per account.
 *
 * The join it stands in for is the real one: the configuration says which accounts share a login, the
 * manifest says where they live. A fake that grouped by name would hide the very mistake the real
 * implementation exists to avoid.
 */
export class RecordingIdentitySource implements IFleetIdentitySource {
  readonly joins: Array<{ config: FleetConfig; manifest: FleetManifest }> = [];
  readonly surveyed: Array<readonly FleetIdentity[]> = [];

  constructor(private readonly statuses?: readonly FleetIdentityStatus[]) {}

  identities(config: FleetConfig, manifest: FleetManifest): readonly FleetIdentity[] {
    this.joins.push({ config, manifest });
    return manifest.accounts.map(account => ({
      key: `${account.kind}:${account.displayName}`,
      kind: account.kind,
      identity: account.displayName,
      auth: 'oauth' as const,
      declared: true,
      members: [
        {
          accountId: account.id,
          wrapper: account.wrapper,
          home: account.home,
          displayName: account.displayName,
          mode: account.mode,
          available: account.available,
          unavailableReason: account.unavailableReason,
        },
      ],
    }));
  }

  survey(identities: readonly FleetIdentity[]): Promise<readonly FleetIdentityStatus[]> {
    this.surveyed.push(identities);
    return Promise.resolve(
      this.statuses ??
        identities.map(identity => ({
          identity,
          members: identity.members.map(member => ({ member, reading: { state: 'valid' as const } })),
          unavailable: [],
          verdict: { kind: 'complete' as const },
          targets: [],
          refused: [],
        })),
    );
  }
}

/** A scaffolder recording that it ran, and answering with a fixed result. */
export class RecordingScaffolder implements IFleetScaffolder {
  calls = 0;
  readonly options: FleetScaffoldOptions[] = [];

  constructor(private readonly result: FleetScaffoldResult = scaffoldResult()) {}

  scaffold(options: FleetScaffoldOptions): Promise<FleetScaffoldResult> {
    this.calls += 1;
    this.options.push(options);
    return Promise.resolve(this.result);
  }
}

export function scaffoldResult(overrides: Partial<FleetScaffoldResult> = {}): FleetScaffoldResult {
  return {
    created: ['/state/fleet/config.yaml'],
    kept: [],
    updated: [],
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

/** One account in a sharing report, with every field spelled out so an override changes one thing. */
export function sharingAccount(overrides: Partial<FleetAccountSharing> = {}): FleetAccountSharing {
  return {
    accountId: ACCOUNT_ID,
    kind: 'claude',
    wrapper: 'claude-primary',
    displayName: 'Claude (primary)',
    fields: {
      memory: {
        state: 'shared',
        name: 'default',
        path: './CLAUDE.md',
        origin: { kind: 'base-profile', name: 'base' },
        referrers: 1,
      },
      skills: { state: 'absent' },
      hooks: { state: 'absent' },
      hooksDir: { state: 'absent' },
      mcp: { state: 'absent' },
    },
    settings: [],
    linkable: ['memory', 'skills', 'mcp'],
    ...overrides,
  };
}

/** One shared-document report a test can assert on, with every field spelled out. */
export function sharingReport(overrides: Partial<FleetSharing> = {}): FleetSharing {
  return {
    documents: [{ field: 'memory', name: 'default', path: './CLAUDE.md', accounts: [ACCOUNT_ID] }],
    accounts: [sharingAccount()],
    ...overrides,
  };
}

/** Answers the sharing read with one prepared report, or fails the way the daemon would. */
export class RecordingSharingGateway implements IFleetSharingGateway {
  calls = 0;

  constructor(private readonly value: FleetSharing | Error = sharingReport()) {}

  sharing(): Promise<FleetSharing> {
    this.calls += 1;
    return this.value instanceof Error ? Promise.reject(this.value) : Promise.resolve(this.value);
  }
}

export function committedState(overrides: Partial<FleetApplyCommittedState> = {}): FleetApplyCommittedState {
  return {
    accountCount: 1,
    operationCount: 2,
    manifestPath: '/state/fleet/manifest.json',
    manifest: manifest(),
    prunedWrappers: [],
    sharedHistory: [],
    ...overrides,
  };
}

/**
 * An applier that fails the way the provisioner does: with the exact post-state, not a message.
 *
 * `lockResidue` is a separate constructor argument because that is how the error carries it — a
 * sibling of the failure, not a member of it — so a fixture that folded it in would let a bug in the
 * lifting hide behind the fixture's own convenience.
 */
export class FailingApplier implements IFleetApplier {
  readonly applied: FleetApplyPlan[] = [];

  constructor(
    private readonly failure: FleetApplyFailure,
    private readonly lockResidue?: string,
  ) {}

  preview(plan: FleetApplyPlan): Promise<FleetApplyPreview> {
    return Promise.resolve({ ...plan, sharedHistory: [] });
  }

  apply(plan: FleetApplyPlan): Promise<FleetApplyResult> {
    this.applied.push(plan);
    return Promise.reject(new FleetApplyFailureError(this.failure, this.lockResidue));
  }
}

export const LOCK_RESIDUE = '/state/fleet/.apply-lock';

/** Rollback that also left somebody else's file renamed — displaced is not the same as unrestored. */
export const ROLLBACK_WITH_DISPLACED: FleetApplyFailure = {
  kind: 'rollback-incomplete',
  failedOperation: 'copy /state/fleet/homes/work/CLAUDE.md',
  reason: 'read-only file system',
  unrestored: [{ path: '/state/fleet/homes/work/CLAUDE.md', reason: 'rename refused' }],
  displaced: [
    { path: '/state/fleet/homes/work/AGENTS.md', movedTo: '/state/fleet/.bak/AGENTS.md' },
    { path: '/state/fleet/homes/work/skills', movedTo: '/state/fleet/.bak/skills' },
  ],
};

export const ROLLED_BACK: FleetApplyFailure = {
  kind: 'rolled-back',
  failedOperation: 'file /state/fleet/bin/fy-claude-work',
  reason: 'permission denied',
};

export const ROLLBACK_INCOMPLETE: FleetApplyFailure = {
  kind: 'rollback-incomplete',
  failedOperation: 'settings /state/fleet/homes/work/settings.json',
  reason: 'disk full',
  unrestored: [
    {
      path: '/state/fleet/homes/work/settings.json',
      reason: 'rename refused',
      backup: '/state/fleet/.bak/settings.json',
    },
    { path: '/state/fleet/bin/fy-claude-work', reason: 'still held open' },
  ],
};

export const HISTORY_FAILED: FleetApplyFailure = {
  kind: 'history-failed-after-commit',
  failedHarness: 'claude',
  reason: 'pool directory vanished mid-migration',
  committed: committedState({ prunedWrappers: ['fy-claude-old'], backupResidue: ['/state/fleet/.bak/CLAUDE.md'] }),
};

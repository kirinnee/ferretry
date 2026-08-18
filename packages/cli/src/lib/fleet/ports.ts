import type {
  FleetApplyPlan,
  FleetApplyPreview,
  FleetApplyResult,
  FleetConfig,
  FleetHealthSnapshot,
  FleetIdentity,
  FleetIdentityStatus,
  FleetLoginRequest,
  FleetLoginResult,
  FleetManifest,
  FleetScaffoldResult,
  FleetUsageSnapshot,
  HarnessKind,
} from '@ferretry/fleet';
import type { FleetApprovalMint, FleetSharing, IFyApiClient } from '@ferretry/protocol';
import type { RecommendationRequest, TeamRecommendation } from './wire.ts';

/**
 * Presentation port for the fleet commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface IFleetOutput {
  success(message: string): void;
  warn(message: string): void;
}

/** Reading the declared fleet configuration. Satisfied by `@ferretry/fleet`'s file source. */
export interface IFleetConfigSource {
  load(): Promise<FleetConfig>;
}

/** Reading the manifest provisioning last published. */
export interface IFleetManifestSource {
  /** The manifest, or nothing when the fleet has never been applied on this host. */
  load(): Promise<FleetManifest | undefined>;
}

/** Turning a configuration into the complete set of writes that would realize it. */
export interface IFleetPlanner {
  build(config: FleetConfig, generatedAt: string): FleetApplyPlan;
}

/** Performing a plan's writes. Satisfied by `@ferretry/fleet`'s file provisioner. */
export interface IFleetApplier {
  preview(plan: FleetApplyPlan): Promise<FleetApplyPreview>;
  apply(plan: FleetApplyPlan): Promise<FleetApplyResult>;
}

/**
 * Probing every account's quota.
 *
 * Built per invocation from the loaded configuration rather than once at composition time: the
 * collector's thresholds are configuration (`usage.concurrency`, `usage.atLimitPercent`), and a
 * collector constructed before the configuration was read could only ever use the defaults — which
 * is exactly what it did, so a declared `atLimitPercent: 90` silently behaved as 100.
 */
export interface IFleetUsageCollectorFactory {
  forConfig(config: FleetConfig): IFleetUsageCollector;
}

export interface IFleetUsageCollector {
  collect(manifest: FleetManifest): Promise<FleetUsageSnapshot>;
}

export interface IFleetHealthCollectorFactory {
  forConfig(config: FleetConfig): IFleetHealthCollector;
}
interface IFleetHealthCollector {
  collect(manifest: FleetManifest): Promise<FleetHealthSnapshot>;
}

/**
 * Grouping the fleet into provider logins and reading what each home holds.
 *
 * Both halves come from a different place and neither is guessed: the configuration declares which
 * accounts share a login (`identity`) and how they authenticate (`auth`), while the manifest publishes
 * where each account's home actually is. Joining them is what turns thirty browser approvals into one
 * per provider account.
 */
export interface IFleetIdentitySource {
  identities(config: FleetConfig, manifest: FleetManifest): readonly FleetIdentity[];
  survey(identities: readonly FleetIdentity[]): Promise<readonly FleetIdentityStatus[]>;
}

/**
 * Logging the fleet in. Satisfied by `@ferretry/fleet`'s login service.
 *
 * Takes identities rather than a manifest because a credential belongs to an identity, not to an
 * account: syncing is what makes the login cheap, and syncing is only definable across the accounts
 * that share one.
 */
export interface IFleetLoginService {
  login(request: FleetLoginRequest): Promise<readonly FleetLoginResult[]>;
}

/**
 * Preparing a host that has never had a fleet: the directories, a starter configuration, and the
 * asset space. Creates only what is absent, so it is safe on a host that already has one.
 */
export interface IFleetScaffolder {
  scaffold(options: FleetScaffoldOptions): Promise<FleetScaffoldResult>;
}

/** How `init` should seed a configuration that does not exist yet. */
export interface FleetScaffoldOptions {
  /** Select a named harness, or ask the host to choose from positive launch evidence. */
  readonly firstAccount?: HarnessKind | 'detected';
}

/** Reading the wall clock, injected so a plan's `generatedAt` is deterministic in a test. */
export interface IFleetClock {
  /** The current instant, ISO-8601. */
  now(): string;
}

/** Asking the daemon which agents should do a piece of work. */
export interface IRecommendationGateway {
  recommend(request: RecommendationRequest): Promise<TeamRecommendation>;
}

/**
 * Approving one change a paired browser has proposed.
 *
 * Separate from the recommender because the two have nothing in common but a client: one asks the
 * daemon a question, the other exercises this host's authority over a pending write. The port takes
 * only the proposal id — a non-secret handle — and answers with the mint, because the code must be
 * something this process prints and then forgets, never something it is handed to pass on.
 */
export interface IFleetAuthorizationGateway {
  authorize(proposalId: string): Promise<FleetApprovalMint>;
}

/**
 * Reading which documents this fleet shares and who uses one.
 *
 * Read from the daemon rather than derived here, even though this process could load the same
 * configuration: the daemon owns the resolution the browser and this terminal both have to agree on,
 * and a second derivation on this side is exactly the pair of descriptions that eventually disagrees
 * about whether an account is sharing something.
 */
export interface IFleetSharingGateway {
  sharing(): Promise<FleetSharing>;
}

/** The only client capability either fleet gateway consumes. */
export type FleetApiClient = Pick<IFyApiClient, 'request'>;

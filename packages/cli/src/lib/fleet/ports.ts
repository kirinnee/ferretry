import type { FleetApplyPlan, FleetApplyResult, FleetConfig, FleetManifest, FleetUsageSnapshot } from '@ferretry/fleet';
import type { IFyApiClient } from '@ferretry/protocol';
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
  apply(plan: FleetApplyPlan): Promise<FleetApplyResult>;
}

/** Probing every account's quota. Satisfied by `@ferretry/fleet`'s usage collector. */
export interface IFleetUsageCollector {
  collect(manifest: FleetManifest): Promise<FleetUsageSnapshot>;
}

/** Reading the wall clock, injected so a plan's `generatedAt` is deterministic in a test. */
export interface IFleetClock {
  /** The current instant, ISO-8601. */
  now(): string;
}

/** The one daemon call the fleet group makes: which agents should do a piece of work. */
export interface IRecommendationGateway {
  recommend(request: RecommendationRequest): Promise<TeamRecommendation>;
}

/** The only client capability the recommendation gateway consumes. */
export type FleetApiClient = Pick<IFyApiClient, 'request'>;

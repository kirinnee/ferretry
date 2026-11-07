import type { IFyApiClient } from '@ferretry/protocol';
import type { RecommendationRequest, TeamRecommendation } from './wire.ts';

/**
 * Presentation port for the fleet commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface IFleetOutput {
  success(message: string): void;
}

/** Asking the daemon which agents should do a piece of work. */
export interface IRecommendationGateway {
  recommend(request: RecommendationRequest): Promise<TeamRecommendation>;
}

/** The only client capability the fleet gateways consume. */
export type FleetApiClient = Pick<IFyApiClient, 'request'>;

import type { ApiRoute } from '../../api/route.ts';

// Account-model seed, created by U0 and filled by U15 (docs/design/account-model.md §13.2). The field on
// `MountedSubsystems`, the construction in the composition root and the registration in the route
// table already reach it, so filling it touches no shared file.

/** First-run scan, tool install and the clone export. Empty until U15 fills it. */
export type FleetSetupSubsystem = Readonly<Record<never, never>>;

/** This subsystem's route table: none until U15 fills it. */
export function fleetSetupRoutes(_subsystem: FleetSetupSubsystem): readonly ApiRoute[] {
  return [];
}

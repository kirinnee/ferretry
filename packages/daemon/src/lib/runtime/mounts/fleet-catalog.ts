import type { ApiRoute } from '../../api/route.ts';

// Account-model seed, created by U0 and filled by U14 (docs/design/account-model.md §13.2). The field on
// `MountedSubsystems`, the construction in the composition root and the registration in the route
// table already reach it, so filling it touches no shared file.

/** The machine, its components, profiles and runtimes. Empty until U14 fills it. */
export type FleetCatalogSubsystem = Readonly<Record<never, never>>;

/** This subsystem's route table: none until U14 fills it. */
export function fleetCatalogRoutes(_subsystem: FleetCatalogSubsystem): readonly ApiRoute[] {
  return [];
}

/** Builds the catalog subsystem the composition root mounts. */
export function createFleetCatalogSubsystem(): FleetCatalogSubsystem {
  return {};
}

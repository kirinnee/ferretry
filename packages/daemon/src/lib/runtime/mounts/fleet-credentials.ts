import type { ApiRoute } from '../../api/route.ts';

// Account-model seed, created by U0 and filled by U13 (docs/design/account-model.md §13.2). The field on
// `MountedSubsystems`, the construction in the composition root and the registration in the route
// table already reach it, so filling it touches no shared file.

/** Credentials: status, usage, Check now and sign-in by credential id. Empty until U13 fills it. */
export type FleetCredentialsSubsystem = Readonly<Record<never, never>>;

/** This subsystem's route table: none until U13 fills it. */
export function fleetCredentialRoutes(_subsystem: FleetCredentialsSubsystem): readonly ApiRoute[] {
  return [];
}

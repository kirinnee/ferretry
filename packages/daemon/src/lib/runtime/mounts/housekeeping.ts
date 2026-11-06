import { DAEMON_FEATURES } from '@ferretry/protocol';
import type { AuditedRouteRule } from '../../audit/routes.ts';
import type { ModuleContribution } from '../modules.ts';
import { type ScratchGcSubsystem, scratchGcRoutes } from './scratch-gc.ts';
import { type SpeedupsSubsystem, speedupRoutes } from './speedups.ts';
import { type TidySubsystem, tidyRoutes } from './tidy.ts';

/**
 * The security log's rule for the one housekeeping act that spends something: a speed-up Test spends one provider
 * key on the operator's account; the secret's NAME is the subject. The scratch sweep reaches nobody and the tidy
 * plan is a read, so neither has a rule (see the module's route contract for why).
 */
const HOUSEKEEPING_AUDIT_RULES: readonly AuditedRouteRule[] = [
  {
    method: 'POST',
    path: '/v1/speedups/:provider/test',
    event: 'secrets.used',
    responseNames: 'secretName',
    detail: { action: 'speedup-test' },
  },
];

/** What the housekeeping module's three subsystems serve. */
export interface HousekeepingSubsystems {
  readonly scratchGc: ScratchGcSubsystem;
  readonly tidy: TidySubsystem;
  readonly speedups: SpeedupsSubsystem;
}

/**
 * What the housekeeping module adds to the daemon: the explicit scratch collector (`/v1/gc`), one ferret's tidy plan
 * (`/v1/tidy/plan`) and the speed-ups status and Test (`/v1/speedups`), the Test's audit rule and the `tidy` protocol
 * feature.
 *
 * Every path is a fixed literal that no other subsystem uses (`/v1/gc`, `/v1/tidy/plan`, and `/v1/speedups` with one
 * pattern beneath it), so none can shadow or be shadowed.
 */
export function housekeepingContribution(subsystems: HousekeepingSubsystems): ModuleContribution {
  return {
    routes: [
      ...scratchGcRoutes(subsystems.scratchGc),
      ...tidyRoutes(subsystems.tidy),
      ...speedupRoutes(subsystems.speedups),
    ],
    audit: { routes: HOUSEKEEPING_AUDIT_RULES },
    features: [DAEMON_FEATURES.tidy],
  };
}

import { mountedAuditRules } from './surface-mounted.ts';
import { subsystems } from './surface-world.ts';

/**
 * EVERY AUDIT RULE THE DAEMON'S COMPOSED MODULES CONTRIBUTE: the legacy inventory plus each extracted module's
 * `contributes.audit`, read from the same fixture the mounted-surface tests compose (`../../modules/fixtures.ts`).
 *
 * The audit tests that drive "every audited route" (the flood, the on-disk secret-leak probe, the decorator tables)
 * take their rules from here and pass them to `auditedRoutes` / `auditedSocketRoutes` as the explicit `rules`
 * argument. They must NOT read `AUDITED_ROUTES` / `AUDITED_SOCKET_ROUTES`: those constants are only what the
 * `legacy` module contributes, so each extraction shrinks them, and a probe built on them silently stops covering
 * the moved rules. Registering a module's builder in `../../modules/fixtures.ts` is all a new extraction does here.
 */
export const composedAuditRules = () => mountedAuditRules(subsystems());

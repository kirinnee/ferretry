import type { DaemonApiDependencies } from '../../../../src/lib/api/server.ts';
import type { ApiRoute } from '../../../../src/lib/api/route.ts';
import type { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { ApiSocketDispatcher, SocketRoute } from '../../../../src/lib/api/socket.ts';
import type { MountedSubsystems } from '../../../../src/lib/runtime/index.ts';
import type { BuiltModule } from '../../../../src/lib/runtime/modules.ts';
import * as mounted from '../../../../src/lib/runtime/mounts/index.ts';
import { builtModules } from '../../modules/fixtures.ts';

/**
 * The mounted-surface readers and dispatcher factories, with the extracted modules supplied.
 *
 * The signatures are the two-argument ones the surface tests were written against; each wrapper forwards the
 * modules the fixture builds (`../../modules/fixtures.ts`: the real `build` of every extracted module) as the
 * explicit `modules` argument production's factories take. Production's types carry no test-only field.
 */
export const mountedDaemonRoutes = (base: DaemonApiDependencies, subsystems: MountedSubsystems): readonly ApiRoute[] =>
  mounted.mountedDaemonRoutes(base, subsystems, builtModules());

export const mountedSocketRoutes = (subsystems: MountedSubsystems): readonly SocketRoute[] =>
  mounted.mountedSocketRoutes(subsystems, builtModules());

export const mountedAuditRules = (subsystems: MountedSubsystems) =>
  mounted.mountedAuditRules(subsystems, builtModules());

export const createMountedDispatcher = (
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
  replacements: readonly BuiltModule<unknown, object>[] = [],
): ApiDispatcher => mounted.createMountedDispatcher(base, subsystems, builtModules(replacements));

export const createMountedSocketDispatcher = (
  base: DaemonApiDependencies,
  subsystems: MountedSubsystems,
  carriers: readonly SocketRoute[] = [],
  replacements: readonly BuiltModule<unknown, object>[] = [],
): ApiSocketDispatcher => mounted.createMountedSocketDispatcher(base, subsystems, carriers, builtModules(replacements));

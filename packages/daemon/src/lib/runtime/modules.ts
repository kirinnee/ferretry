import type { DaemonFeature } from '@ferretry/protocol';
import type { CapabilityGuard, StepUpWitness } from '../api/capability.ts';
import type { ResponseCompressor } from '../api/compression.ts';
import type { AgentControlPolicy } from '../fleet/agent-control.ts';
import type { PerformanceProbe } from '../performance/recorder.ts';
import type { MillisecondClockPort } from './boot.ts';
import type { ApiCredentials } from '../api/authentication.ts';
import { ApiDispatcher } from '../api/dispatcher.ts';
import type { ApiRoute, RoutePattern } from '../api/route.ts';
import { ApiRouter } from '../api/router.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../api/socket.ts';
import {
  auditedRoutes,
  auditedSocketRoutes,
  type AuditedRouteRule,
  type AuditedSocketRule,
  type AuditedRoutesSubsystem,
} from '../audit/routes.ts';
import { configAnnouncedRoutes, type ConfigChangeSink } from '../config-files/index.ts';
import { observedRoutes } from '../performance/observed-routes.ts';
import { agentControlledRoutes, agentControlledSockets } from './mounts/agent-control.ts';
import {
  sessionAddressedRoutes,
  sessionAddressedSockets,
  type SessionAddressBook,
} from './mounts/session-addressing.ts';

/** Releases register at acquisition time; the kernel keeps its existing forward cleanup order. */
export interface ModuleLifecycle {
  readonly onRelease: (
    label: string,
    release: () => void | Promise<void>,
    options?: { readonly first?: boolean },
  ) => void;
  readonly releasing: () => boolean;
}

export interface ModuleContribution {
  readonly routes?: readonly ApiRoute[];
  readonly sockets?: readonly SocketRoute[];
  readonly audit?: {
    readonly routes?: readonly AuditedRouteRule[];
    readonly sockets?: readonly AuditedSocketRule[];
  };
  readonly features?: readonly DaemonFeature[];
}

/** Jobs keep their own signatures, including synchronous versus asynchronous arming. */
export interface BuiltModule<Provides, Jobs extends object = Record<never, never>> {
  readonly id: string;
  readonly provides: Provides;
  readonly jobs: Jobs;
  readonly contributes: ModuleContribution;
}

/**
 * `build` is SYNCHRONOUS on purpose. Construction inside `createSubsystems` is synchronous today, and an
 * `await` between module builds would be a real yield in the middle of construction: work started earlier
 * (the agenda waker's first tick, the member sweeps) would run its continuation mid-construction instead of
 * after `createSubsystems` returns. A module that ever needs asynchronous set-up does it in a job armed by
 * `start()`, never in `build`.
 */
export interface DaemonModule<Seams, Needs, Provides, Jobs extends object = Record<never, never>> {
  readonly id: string;
  readonly build: (needs: Needs, seams: Seams, lifecycle: ModuleLifecycle) => BuiltModule<Provides, Jobs>;
}

/** Filled once by the composition root; each consumer preserves its own early-read behaviour. */
export interface LateBound<T> {
  readonly current: () => T | undefined;
  readonly bind: (value: T) => void;
}

interface ModuleRouteDependencies {
  readonly sessionAddresses: SessionAddressBook;
  readonly audit: AuditedRoutesSubsystem;
  readonly agentControl: AgentControlPolicy;
}
interface ModuleDependencies extends ModuleRouteDependencies {
  readonly credentials: ApiCredentials;
  readonly grants: CapabilityGuard;
  readonly stepUp: StepUpWitness;
  readonly compressor?: ResponseCompressor;
  readonly configChanges: ConfigChangeSink;
  readonly performance: {
    readonly probe: PerformanceProbe;
    readonly clock: MillisecondClockPort;
  };
}

interface ModuleInventory {
  /** Decorated inventories preserve module and registration order. */
  readonly routes: readonly ApiRoute[];
  readonly sockets: readonly SocketRoute[];
  /** The union of every module's `contributes.audit`, as the audit layers receive it. */
  readonly audit: {
    readonly routes: readonly AuditedRouteRule[];
    readonly sockets: readonly AuditedSocketRule[];
  };
}
interface ComposedModules extends ModuleInventory {
  readonly dispatcher: ApiDispatcher;
  readonly socketDispatcher: (carriers?: readonly SocketRoute[]) => ApiSocketDispatcher;
}

function segments(path: string): readonly string[] {
  const parts = path.split('/');
  if (parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Explicit precedence first, then literal > parameter > catch-all at the first differing segment. */
export function compareRouteSpecificity(left: RoutePattern, right: RoutePattern): number {
  const precedence = (right.precedence ?? 0) - (left.precedence ?? 0);
  if (precedence !== 0) return precedence;
  const a = segments(left.path);
  const b = segments(right.path);
  // An exact endpoint beats a catch-all that can capture an empty suffix.
  const rank = (part: string | undefined): number =>
    part === undefined ? 4 : part.startsWith('*') ? 1 : part.startsWith(':') ? 2 : 3;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = rank(b[index]) - rank(a[index]);
    if (difference !== 0) return difference;
    // The router ignores anything after a catch-all, so its suffix has no specificity.
    if (a[index]?.startsWith('*') && b[index]?.startsWith('*')) return 0;
  }
  return 0;
}

/** A sorted copy; the stable sort retains duplicates and their available() fallthrough order. */
export function orderRoutesBySpecificity<T extends RoutePattern>(routes: readonly T[]): readonly T[] {
  return [...routes].sort(compareRouteSpecificity);
}

// Inventory readers need only the three decoration ports, with no invented HTTP credentials.
export function composeModules(
  base: ModuleDependencies,
  modules: readonly BuiltModule<unknown, object>[],
): ComposedModules;
export function composeModules(
  base: ModuleRouteDependencies,
  modules: readonly BuiltModule<unknown, object>[],
): ModuleInventory;
export function composeModules(
  base: ModuleRouteDependencies | ModuleDependencies,
  modules: readonly BuiltModule<unknown, object>[],
): ModuleInventory | ComposedModules {
  const routeRules = modules.flatMap(module => module.contributes.audit?.routes ?? []);
  const socketRules = modules.flatMap(module => module.contributes.audit?.sockets ?? []);
  const routes = sessionAddressedRoutes(
    base.sessionAddresses,
    auditedRoutes(
      base.audit,
      agentControlledRoutes(
        base.agentControl,
        modules.flatMap(module => module.contributes.routes ?? []),
      ),
      routeRules,
    ),
  );
  const sockets = sessionAddressedSockets(
    base.sessionAddresses,
    auditedSocketRoutes(
      base.audit,
      agentControlledSockets(
        base.agentControl,
        modules.flatMap(module => module.contributes.sockets ?? []),
      ),
      socketRules,
    ),
  );
  const audit = { routes: routeRules, sockets: socketRules };
  if (!('credentials' in base)) return { routes, sockets, audit };
  return {
    routes,
    sockets,
    audit,
    dispatcher: new ApiDispatcher(
      new ApiRouter(
        orderRoutesBySpecificity(
          observedRoutes(
            configAnnouncedRoutes(base.configChanges, routes),
            base.performance.probe,
            base.performance.clock,
          ),
        ),
      ),
      base.credentials,
      base.grants,
      undefined,
      base.stepUp,
      base.compressor,
    ),
    socketDispatcher: (carriers = []) =>
      new ApiSocketDispatcher(
        new ApiRouter([...orderRoutesBySpecificity(sockets), ...carriers]),
        base.credentials,
        base.grants,
        undefined,
        base.stepUp,
      ),
  };
}

/**
 * A {@link LateBound} that is empty until the composition root binds it, and binds exactly once.
 *
 * It has no throwing getter on purpose: every port that reads it keeps TODAY'S answer for "not bound
 * yet", and those answers differ, so the port says which one it keeps (see {@link LateBound}).
 */
export function lateBound<T>(): LateBound<T> {
  let bound: { readonly value: T } | undefined;
  return {
    current: () => bound?.value,
    bind: value => {
      if (bound !== undefined) throw new Error('this late-bound value is already bound');
      bound = { value };
    },
  };
}

import type { ApiRoute as KernelRoute, RouteHandler } from '@ferretry/kernel/contract';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import type manifest from '../manifest.ts';
import { type SessionForkNeeds, sessionForkModule } from './modules/session-fork.ts';
import {
  type SessionHandoverNeeds,
  type SessionHandoverProvides,
  sessionHandoverModule,
} from './modules/session-handover.ts';
import { type SessionMoveNeeds, type SessionMoveProvides, sessionMoveModule } from './modules/session-move.ts';
import { transferPorts } from './modules/transfer.ts';

/**
 * Moves and forks (ferrets-c): the bodies of today's `session-fork`, `session-handover` and `session-migrate` modules
 * (refactor/finish), built once inside Ferrets' `build(ctx)`, in today's order: the fork, then the handover, then the
 * move. Every constructor is pure; the one timer (the handover reconcile loop) runs on the kernel clock and is armed by
 * {@link BuiltMoves.arm}, never by the build.
 *
 * The owners each module borrows (session storage, lifecycle, launch, accounts, planner, transcripts, attachments) are
 * ferrets-a's and the Conversation port's code; they arrive here as `deps`, the very typed needs today's modules
 * declare, so this file adds no second owner of any of them.
 */

/** The seven routes this unit serves, exactly as `manifest.ts` declares them. */
export const MOVE_ROUTE_KEYS = [
  'POST /v1/ferrets/:ferretId/fork',
  'POST /v1/ferrets/:ferretId/handover',
  'GET /v1/ferrets/:ferretId/handover',
  'POST /v1/ferrets/:ferretId/handover/cancel',
  'GET /v1/ferrets/:ferretId/relaunch-settings',
  'POST /v1/ferrets/:ferretId/conversion-preview',
  'POST /v1/ferrets/:ferretId/move',
  'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
] as const;
export type MoveRouteKey = (typeof MOVE_ROUTE_KEYS)[number];

/** What `buildMoves` is built from: each module's needs, less what this file composes itself. */
export interface MovesDeps {
  /** The fork's needs; `transferPorts` is this unit's own factory and is filled here. */
  readonly fork: Omit<SessionForkNeeds, 'transferPorts'>;
  /** The handover's needs; `every` is the kernel clock's and is filled here. */
  readonly handover: Omit<SessionHandoverNeeds, 'every'>;
  readonly move: SessionMoveNeeds;
}

export interface BuiltMoves {
  /** One handler per route key, for Ferrets' `routes` section. */
  readonly routes: { readonly [K in MoveRouteKey]: RouteHandler };
  /** The mover: the restart service and the Warden's auto-move take it (today's `sessionMigrate.provides`). */
  readonly move: SessionMoveProvides;
  /** The handover service and its reconcile loop. */
  readonly handover: SessionHandoverProvides;
  /** Arms the handover reconcile loop (today: `start()` arms it beside the warden sweep). Returns its disarm. */
  readonly arm: () => () => void;
}

/** Today's mounted routes, keyed the way the manifest names them; a missing or extra route is a wiring fault. */
function keyed(routes: readonly { readonly method: string; readonly path: string; readonly handle: unknown }[]): {
  readonly [K in MoveRouteKey]: RouteHandler;
} {
  const out = new Map<string, RouteHandler>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (!(MOVE_ROUTE_KEYS as readonly string[]).includes(key)) throw new Error(`moves: undeclared route ${key}`);
    if (out.has(key)) throw new Error(`moves: route ${key} built twice`);
    // Today's handler takes today's `RouteContext`, which Gate's `CallStanding` merges into the kernel's `CallContext`
    // field for field (spine D7), so it is the kernel's handler without a wrapper.
    out.set(key, (route as KernelRoute).handle);
  }
  for (const key of MOVE_ROUTE_KEYS) if (!out.has(key)) throw new Error(`moves: route ${key} was not built`);
  return Object.fromEntries(out) as { readonly [K in MoveRouteKey]: RouteHandler };
}

export function buildMoves(ctx: DaemonContext<typeof manifest>, deps: MovesDeps): BuiltMoves {
  // Today's module lifecycle, over the kernel's: a release runs when the daemon stops. None of the three modules
  // registers one today; it is handed on so a module that does keeps today's shape.
  const lifecycle: Parameters<(typeof sessionForkModule)['build']>[2] = {
    onRelease: (_label: string, release: () => void | Promise<void>) => ctx.kernel.lifecycle.onStop(release),
    releasing: () => ctx.kernel.lifecycle.stopping(),
  };
  const fork = sessionForkModule.build({ ...deps.fork, transferPorts }, undefined, lifecycle);
  const handover = sessionHandoverModule.build(
    {
      ...deps.handover,
      every: (intervalMs: number, tick: () => void) => ctx.kernel.clock.every(milliseconds(intervalMs), tick),
    },
    undefined,
    lifecycle,
  );
  const move = sessionMoveModule.build(deps.move, undefined, lifecycle);
  return {
    routes: keyed([
      ...(fork.contributes.routes ?? []),
      ...(handover.contributes.routes ?? []),
      ...(move.contributes.routes ?? []),
    ]),
    move: move.provides,
    handover: handover.provides,
    arm: () => handover.jobs.arm(),
  };
}

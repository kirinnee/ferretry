import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../contract/act.ts';

/**
 * What the kernel knows about the call a handler is running for, carried across its awaits so `kernel.act` can stamp
 * the actor itself (§4.7): a plugin never chooses who it acts as. Outside a call (a job), the actor is `ferret`, the
 * most restricted one, so an act a job makes is held exactly as a ferret's would be.
 */
export interface CallScope {
  readonly actor: Actor;
}

const scope = new AsyncLocalStorage<CallScope>();

export const DEFAULT_ACTOR: Actor = 'ferret';

export function runInCall<T>(call: CallScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(call, fn);
}

export function currentActor(): Actor {
  return scope.getStore()?.actor ?? DEFAULT_ACTOR;
}

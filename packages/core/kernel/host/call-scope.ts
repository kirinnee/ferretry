import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../contract/act.ts';
import type { CallStanding } from '../contract/route.ts';

/**
 * What the kernel knows about the call a handler is running for, carried across its awaits so `kernel.act` can stamp
 * the actor itself (§4.7): a plugin never chooses who it acts as. Outside a call (a job), the actor is `ferret`, the
 * most restricted one, so an act a job makes is held exactly as a ferret's would be.
 *
 * `standing` is what admission put on the call (the same object the handler reads), carried so Gate's judge of a
 * loosening config write can see who the caller is. It is absent for a member call and outside a call.
 */
export interface CallScope {
  readonly actor: Actor;
  readonly standing?: CallStanding;
}

const scope = new AsyncLocalStorage<CallScope>();

export const DEFAULT_ACTOR: Actor = 'ferret';

export function runInCall<T>(call: CallScope, fn: () => Promise<T>): Promise<T> {
  return scope.run(call, fn);
}

export function currentActor(): Actor {
  return scope.getStore()?.actor ?? DEFAULT_ACTOR;
}

/** The standing admission put on the call in progress; `undefined` outside a call (a job) and on a member call. */
export function currentStanding(): CallStanding | undefined {
  return scope.getStore()?.standing;
}

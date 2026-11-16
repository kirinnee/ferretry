/**
 * The narrow slice of the per-daemon client (`PluginClient`, §9.6) the kernel's app half uses. Everything here reaches a
 * daemon through `call(routeKey, init)`; no code in this half holds a base URL, a token or a fetch. The shell hands the
 * real client to `implementApp`'s `build`, and a test hands a scripted one.
 */
import type { PluginClient } from '../../manifest/index.ts';

/** A screen that re-reads on a change talks through `call`, and `subscribe` when the shell hands one. */
export type KernelClient = Pick<PluginClient, 'call'> & Partial<Pick<PluginClient, 'subscribe'>>;

/** The failure fields a shell client puts on what it throws (`DaemonCallError`): read structurally, never by class. */
interface CallFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

export const callFailure = (failure: unknown): CallFailure | null =>
  typeof failure === 'object' && failure !== null ? (failure as CallFailure) : null;

/** What an error says, as one sentence — or that the machine did not answer. */
export const reasonOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

import type { PluginClient } from '@ferretry/kernel/manifest';

/** The generated per-daemon client, narrowed to what Projects' views use: calls (the guard is the client's own). */
export type ProjectsClient = Pick<PluginClient, 'call'>;

/**
 * A refusal the daemon (or the client's guard) sent back: a status, the daemon's sentence and its code. The shell's
 * `DaemonCallError` has this shape; it is read structurally so this half imports no shell class.
 */
export interface Refusal {
  readonly status: number;
  readonly code?: string;
  readonly message: string;
}

/** The sentence a thrown thing says; a refusal is shown as the daemon worded it, never paraphrased. */
export const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Whether a thrown thing is a refusal with this status (a route the daemon does not serve is a 404). */
export const refusedWithStatus = (cause: unknown, status: number): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { readonly status?: unknown }).status === status;

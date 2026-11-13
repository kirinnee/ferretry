import type { PluginClient } from '@ferretry/kernel/manifest';

/** The generated per-daemon client, narrowed to what Projects' views use: calls (the guard is the client's own). */
export type ProjectsClient = Pick<PluginClient, 'call'>;

/** The sentence a thrown thing says; a refusal is shown as the daemon worded it, never paraphrased. */
export const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

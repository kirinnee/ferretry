import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * Whether this daemon's fixed loopback ports are fenced off from other local users, judged against the
 * marker the root script leaves (`LoopbackFirewallMarkerSchema`).
 *
 * - `applied` — the marker names this daemon's uid with exactly the ports it will use.
 * - `missing` — there is no marker, or it cannot be read as one.
 * - `stale` — the marker exists but does not list this uid, or lists other ports for it.
 */
export const LOOPBACK_FIREWALL_STATES = ['applied', 'missing', 'stale'] as const;
export const LoopbackFirewallStateSchema = z.strictObject({
  state: z.enum(LOOPBACK_FIREWALL_STATES),
  appliedAt: InstantSchema.optional(),
  /** One sentence for a person; for `missing` and `stale` it is the remedy. */
  detail: z.string().min(1).max(600),
});
export type LoopbackFirewallState = z.infer<typeof LoopbackFirewallStateSchema>;

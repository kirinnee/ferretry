import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * Whether this daemon's fixed loopback ports are fenced off from other local users, judged against the
 * marker the root script leaves (`LoopbackFirewallMarkerSchema`). Precedence when several hold:
 * `failed` > `missing` > `stale` > `unverified` > `applied`.
 *
 * - `applied` — the marker names this daemon's uid with exactly the ports it will use, and a recent check agrees.
 * - `missing` — there is no marker, it cannot be read as one, or the last check did not find this uid's rule.
 * - `stale` — the marker exists but does not list this uid, or lists other ports for it.
 * - `unverified` — the marker lists this uid but no check has run for 15 minutes (or ever): the 5-minute check is not running.
 * - `failed` — the last check let an unprivileged probe into one of this uid's ports.
 */
export const LOOPBACK_FIREWALL_STATES = ['applied', 'missing', 'stale', 'unverified', 'failed'] as const;
export const LoopbackFirewallStateSchema = z.strictObject({
  state: z.enum(LOOPBACK_FIREWALL_STATES),
  appliedAt: InstantSchema.optional(),
  /** One sentence for a person; for every state but `applied` it is the remedy. */
  detail: z.string().min(1).max(600),
});
export type LoopbackFirewallState = z.infer<typeof LoopbackFirewallStateSchema>;

/**
 * `machine.yaml` `browserFirewallFailure`: what the daemon does when its own account's firewall check FAILED.
 * `warn` (the default) only says so; `refuse` also declines to START the browser on a fixed port (a browser
 * already running is left alone).
 */
export const BROWSER_FIREWALL_FAILURE_POLICIES = ['warn', 'refuse'] as const;
export const BrowserFirewallFailureSchema = z.enum(BROWSER_FIREWALL_FAILURE_POLICIES);
export type BrowserFirewallFailure = z.infer<typeof BrowserFirewallFailureSchema>;

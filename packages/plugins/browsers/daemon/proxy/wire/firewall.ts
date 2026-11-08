import { z } from 'zod';
import type { LoopbackFirewallStateSchema } from '../../../contract/index.ts';

/**
 * Whether this daemon's fixed loopback ports are fenced off from other local users (the schema is the contract's,
 * `LoopbackFirewallStateSchema`). Precedence when several hold: `failed` > `missing` > `stale` > `unverified` >
 * `applied`.
 */
export type LoopbackFirewallState = z.infer<typeof LoopbackFirewallStateSchema>;

/**
 * What the daemon does when its own account's firewall check FAILED. `warn` (the default) only says so; `refuse` also
 * declines to START the browser on a fixed port (a browser already running is left alone).
 */
const BROWSER_FIREWALL_FAILURE_POLICIES = ['warn', 'refuse'] as const;
const BrowserFirewallFailureSchema = z.enum(BROWSER_FIREWALL_FAILURE_POLICIES);
export type BrowserFirewallFailure = z.infer<typeof BrowserFirewallFailureSchema>;

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
/** @pending browsers: GAP(daemon): daemon/holds/site.ts, daemon/stream/socket-downstream.ts, daemon/proxy/firewall/marker-reader.ts, daemon/proxy/firewall/state.ts and daemon/proxy/wire/firewall.ts are ported and tested but no daemon composition consumes them yet (the holds site key, the viewer socket transport and the loopback firewall status) (the file's OUTSIDE_THE_KERNEL exemption is permanent, #20; only its consumer is pending) */
export const BROWSER_FIREWALL_FAILURE_POLICIES = ['warn', 'refuse'] as const;
/** @pending browsers: GAP(daemon): daemon/holds/site.ts, daemon/stream/socket-downstream.ts, daemon/proxy/firewall/marker-reader.ts, daemon/proxy/firewall/state.ts and daemon/proxy/wire/firewall.ts are ported and tested but no daemon composition consumes them yet (the holds site key, the viewer socket transport and the loopback firewall status) (the file's OUTSIDE_THE_KERNEL exemption is permanent, #20; only its consumer is pending) */
export const BrowserFirewallFailureSchema = z.enum(BROWSER_FIREWALL_FAILURE_POLICIES);
export type BrowserFirewallFailure = z.infer<typeof BrowserFirewallFailureSchema>;

/**
 * WHETHER THIS DAEMON RUNS A CLOUDFLARE TUNNEL, AND THE SWITCH THAT DECIDES IT — `docs/relay-protocol.md`
 * §15 "The daemon end".
 *
 * THE TUNNEL IS OPT-IN. A daemon whose `carriers` list names no tunnel runs none: the implied entry is
 * `{ kind: 'tunnel', source: 'discovery', enabled: false }`. Turning it on is a decision somebody makes
 * for one machine — at the machine with `fy daemon tunnel on`, or from a paired device through
 * `PUT /v1/tunnel` — and it applies without a restart. Turning it off releases the tunnel back to the
 * hosted pool at once.
 *
 * `GET` needs only a paired credential, like `GET /v1/carriers`: whether a machine has a tunnel is not a
 * secret, and a device deciding whether to offer "Tunnel only" needs it. `PUT` is `pairing.configure`
 * (`docs/grants.md`): a tunnel changes how other devices reach this host, which is the subject that
 * capability already governs.
 */

import { z } from 'zod';

export const TUNNEL_PATH = '/v1/tunnel';

/**
 * Where the tunnel carrier is, as one word.
 *
 * - `off` — the entry is switched off, or implied off: the opt-in default.
 * - `unavailable` — on, but it cannot run: no `cloudflared`, the hosted service is not set up, or the
 *   service refused this daemon. The view's sentence says which.
 * - `provisioning` — on, asking the hosted service for a tunnel (including a retry's backoff).
 * - `connecting` — provisioned, and `cloudflared` has no registered edge connection right now.
 * - `up` — published in this daemon's carrier set.
 */
export const TunnelStateSchema = z.enum(['off', 'unavailable', 'provisioning', 'connecting', 'up']);
export type TunnelState = z.infer<typeof TunnelStateSchema>;

/** What `GET /v1/tunnel` answers, and what `PUT /v1/tunnel` answers once the change is applied. */
export const TunnelStatusViewSchema = z.strictObject({
  /** The effective entry: whether this daemon is asked to run a tunnel at all. */
  enabled: z.boolean(),
  /** Whether the configuration names a tunnel entry, rather than the opt-in default implying one. */
  explicit: z.boolean(),
  state: TunnelStateSchema,
  /** The provisioned `https:` origin when known, else `null`. Known before it is `up`. */
  tunnelUrl: z.string().nullable(),
  /** One line a person reads, e.g. {@link TUNNEL_OFF_SENTENCE}. */
  sentence: z.string(),
});
export type TunnelStatusView = z.infer<typeof TunnelStatusViewSchema>;

/** The body of `PUT /v1/tunnel`: switch the tunnel on or off for this machine. */
export const TunnelChangeSchema = z.strictObject({ enabled: z.boolean() });
export type TunnelChange = z.infer<typeof TunnelChangeSchema>;

/** The sentence for a tunnel that is off, naming both ways to turn it on. */
export const TUNNEL_OFF_SENTENCE = 'Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection';

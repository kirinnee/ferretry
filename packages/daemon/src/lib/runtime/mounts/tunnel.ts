/**
 * THE TUNNEL SWITCH (`docs/relay-protocol.md` §15 "The daemon end"): read whether this machine runs a
 * Cloudflare tunnel, and turn it on or off without a restart.
 *
 * ## THE READ IS `authenticated` AND UNGOVERNED, LIKE `GET /v1/carriers`
 *
 * Whether a machine has a tunnel, and its hostname, is not a secret: the hostname is already in the
 * carrier set every paired device refreshes. A device deciding whether "Tunnel only" can work is the
 * reader, and a capability demand would strand it for a reason unrelated to the question.
 *
 * ## THE CHANGE IS `pairing.configure`
 *
 * A tunnel changes how OTHER devices reach this host — a public hostname on Cloudflare's edge in front
 * of it — and how this host may be reached is the subject `pairing` already governs: minting codes,
 * the paired devices, and `PATCH /v1/security`. So a governed caller needs that grant AND a current
 * step-up, the rule for every `configure` demand (`docs/grants.md`). A caller at the machine — the
 * admin token on loopback, which is what `fy daemon tunnel` is — is ungoverned. Turning it on reaches
 * nobody who was not already paired: every session through it is still the §6 handshake against the
 * pinned identity, and pairing itself is refused on the tunnel listener.
 *
 * This is not the re-pointing `GET /v1/carriers` forbids a device: nothing here names an address. The
 * one fact a device may change is on or off, and the daemon decides everything else.
 */

import { TunnelChangeSchema, TunnelStatusViewSchema } from '@ferretry/protocol';
import { type ApiRoute, jsonResponse, parseBody } from '../../api/index.ts';
import type { TunnelSwitchPort } from '../../tunnel/index.ts';

export function tunnelRoutes(tunnel: TunnelSwitchPort): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/tunnel',
      minimum: 'authenticated',
      // The answer is live state — provisioning, connecting, up — and a cached copy is a wrong one.
      noStore: true,
      handle: async () => jsonResponse(TunnelStatusViewSchema.parse(tunnel.view())),
    },
    {
      method: 'PUT',
      path: '/v1/tunnel',
      minimum: 'operator',
      noStore: true,
      capability: { capability: 'pairing', axis: 'configure' },
      handle: async context => {
        const change = await parseBody(context.request, TunnelChangeSchema);
        return jsonResponse(TunnelStatusViewSchema.parse(await tunnel.change(change.enabled)));
      },
    },
  ];
}

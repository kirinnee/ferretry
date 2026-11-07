import { z } from 'zod';
import { SocketEndpointSchema } from '../relay/endpoint.ts';
export const DaemonRelayConfigSchema = z
  .object({
    /** The rendezvous origin, as `SocketEndpointSchema` spells one: secure everywhere, insecure
     *  only on localhost or 127.0.0.1, and no query or fragment. */
    url: SocketEndpointSchema,
    /** Whether to dial at all. A configured address the operator has switched off stays readable
     *  rather than having to be deleted and retyped. */
    enabled: z.boolean().default(true),
    /** The CEILING of the redial backoff, in seconds, clamped to 1–10 when used. The first redial after a
     *  socket ends is immediate and each failed one waits longer (jittered, doubling from half a second)
     *  up to this. A rendezvous holds a dead incumbent's slot until it is swept — at most 45 seconds — so
     *  a redial faster than the sweep is refused with `4409` and is simply tried again later. */
    reconnectSeconds: z.number().int().positive().max(3_600).default(5),
  })
  .strict();

export type DaemonRelayConfig = z.output<typeof DaemonRelayConfigSchema>;
const ReconnectSecondsSchema = z.number().int().positive().max(3_600).default(5);

/** Whether to dial or listen at all. A configured carrier switched off stays readable rather than
 *  having to be deleted and retyped, and switching one off is a decision rather than an omission. */
const EnabledSchema = z.boolean().default(true);

/** The hosted carrier as an ordinary entry: an address read at runtime rather than written down. */
export const DiscoveredRelayCarrierSchema = z.strictObject({
  kind: z.literal('relay'),
  source: z.literal('discovery'),
  enabled: EnabledSchema,
  reconnectSeconds: ReconnectSecondsSchema,
});

/**
 * A rendezvous whose address the operator supplied.
 *
 * `url` IS PART OF THE SIGNATURE. The claim transcript covers the host the daemon believes it is
 * talking to, so this string has to be the one the rendezvous serves itself as; a daemon refuses to
 * sign a host it did not configure.
 */
export const ConfiguredRelayCarrierSchema = z.strictObject({
  kind: z.literal('relay'),
  url: SocketEndpointSchema,
  enabled: EnabledSchema,
  reconnectSeconds: ReconnectSecondsSchema,
});

export const DaemonRelayCarrierSchema = z.union([DiscoveredRelayCarrierSchema, ConfiguredRelayCarrierSchema]);
export type DaemonRelayCarrierEntry = z.output<typeof DaemonRelayCarrierSchema>;

/**
 * What a document that declares no rendezvous at all means: ask the directory.
 *
 * THIS IS THE HOSTED FALLBACK, AND IT IS NOW AN ENTRY RATHER THAN A BRANCH. The behaviour is exactly
 * what it already was — a fresh install with nothing configured reads Ferretry's runtime advertisement,
 * because a daemon that dialled nowhere was reachable from nothing but its own host. What changes is
 * that "when is the directory asked" stopped being a rule somewhere and became a member of a list.
 *
 * Saying "no relay, and I mean it" is therefore `{ kind: 'relay', source: 'discovery', enabled: false }`
 * — an explicit decision, which is the one thing an omission can never be.
 */
export const DISCOVERED_RELAY_CARRIER: DaemonRelayCarrierEntry = Object.freeze(
  DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery' }),
);

/** Whether this entry's address is written down, as opposed to read from the directory at runtime. */
export function relayCarrierIsConfigured(
  relay: DaemonRelayCarrierEntry,
): relay is z.output<typeof ConfiguredRelayCarrierSchema> {
  return 'url' in relay;
}

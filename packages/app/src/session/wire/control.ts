/**
 * Hop-by-hop control between the browser and a rendezvous, the CLIENT half (copied from today's
 * `packages/relay/src/lib/control.ts`, narrowed to the three messages a client can receive).
 *
 * These messages exist only on a relayed carrier. A direct socket has no rendezvous to talk to, so it never
 * sends one: the end-to-end layer above is identical either way. Every message is parsed, never merely
 * checked; a shape outside the union is a protocol error.
 */

import { z } from 'zod';
import { utf8Text } from './binary.ts';
import {
  CREDIT_WINDOW_FRAMES,
  HEARTBEAT_SECONDS,
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_RENDEZVOUS,
  RELAY_PROTOCOL_ID,
} from './constants.ts';

const ProtocolIdSchema = z.literal(RELAY_PROTOCOL_ID);

/** Limits a rendezvous publishes so an endpoint never has to guess what it will refuse. */
const RelayLimitsSchema = z.strictObject({
  maxFrameBytes: z.literal(MAX_FRAME_BYTES),
  creditWindowFrames: z.literal(CREDIT_WINDOW_FRAMES),
  maxSessions: z.literal(MAX_SESSIONS_PER_RENDEZVOUS),
  heartbeatSeconds: z.literal(HEARTBEAT_SECONDS),
});
export type RelayLimits = z.infer<typeof RelayLimitsSchema>;

const ClientControlMessageSchema = z.discriminatedUnion('t', [
  /** Rendezvous → client: a session identifier was assigned and the daemon is present. */
  z.strictObject({ t: z.literal('ready'), protocol: ProtocolIdSchema, limits: RelayLimitsSchema }),
  /** Rendezvous → either endpoint: this session has ended, and why. */
  z.strictObject({ t: z.literal('closed'), code: z.number().int().min(4000).max(4999), reason: z.string().max(200) }),
  /** Rendezvous → either endpoint: a refusal, sent immediately before the socket closes. */
  z.strictObject({ t: z.literal('error'), code: z.number().int().min(4000).max(4999), reason: z.string().max(200) }),
]);
export type ClientControlMessage = z.infer<typeof ClientControlMessageSchema>;

/** Decode a control payload. Null covers bad UTF-8, bad JSON and any shape outside the union. */
export function decodeControlMessage(payload: Uint8Array): ClientControlMessage | null {
  const text = utf8Text(payload);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ClientControlMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

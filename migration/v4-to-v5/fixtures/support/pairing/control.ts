/**
 * Hop-by-hop control between an endpoint and a rendezvous.
 *
 * These messages exist only on a relayed carrier. A direct socket has no rendezvous to talk to, so
 * it never sends one — which is the point: the end-to-end layer above is identical either way, and
 * removing the relay removes exactly these messages and nothing else.
 *
 * Every message is parsed, never merely checked. A rendezvous that acted on a shape it had not
 * proved would be deciding who owns a slot from a value it never validated.
 */

import { z } from 'zod';
import { utf8Bytes, utf8Text } from './binary.ts';
import {
  CREDIT_WINDOW_FRAMES,
  ED25519_SIGNATURE_BYTES,
  ED25519_SPKI_BYTES,
  HANDOVER_TOKEN_BYTES,
  HEARTBEAT_SECONDS,
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_RENDEZVOUS,
  NONCE_BYTES,
  RELAY_FEATURES,
  RELAY_FEATURES_PARAM,
  RELAY_PROTOCOL_ID,
  type RelayFeature,
} from './constants.ts';

/** base64url of a known byte length, which is how every binary field travels inside JSON. */
function base64UrlOfBytes(byteLength: number): z.ZodString {
  const characters = Math.ceil((byteLength * 4) / 3);
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, 'not base64url')
    .length(characters, 'wrong encoded length');
}

const ProtocolIdSchema = z.literal(RELAY_PROTOCOL_ID);

/** Limits a rendezvous publishes so an endpoint never has to guess what it will refuse. */
export const RelayLimitsSchema = z.strictObject({
  maxFrameBytes: z.literal(MAX_FRAME_BYTES),
  creditWindowFrames: z.literal(CREDIT_WINDOW_FRAMES),
  maxSessions: z.literal(MAX_SESSIONS_PER_RENDEZVOUS),
  heartbeatSeconds: z.literal(HEARTBEAT_SECONDS),
});
export type RelayLimits = z.infer<typeof RelayLimitsSchema>;

export const RELAY_LIMITS: RelayLimits = {
  maxFrameBytes: MAX_FRAME_BYTES,
  creditWindowFrames: CREDIT_WINDOW_FRAMES,
  maxSessions: MAX_SESSIONS_PER_RENDEZVOUS,
  heartbeatSeconds: HEARTBEAT_SECONDS,
};

export const ControlMessageSchema = z.discriminatedUnion('t', [
  /** Rendezvous → daemon, once, on connect. */
  z.strictObject({
    t: z.literal('challenge'),
    protocol: ProtocolIdSchema,
    nonce: base64UrlOfBytes(NONCE_BYTES),
    /** The host the daemon must have signed, so a mismatch is visible rather than mysterious. */
    host: z.string().min(1).max(255),
    deadlineSeconds: z.number().int().positive().max(60),
  }),
  /** Daemon → rendezvous, answering the challenge. */
  z.strictObject({
    t: z.literal('claim'),
    protocol: ProtocolIdSchema,
    publicKey: base64UrlOfBytes(ED25519_SPKI_BYTES),
    signature: base64UrlOfBytes(ED25519_SIGNATURE_BYTES),
    /**
     * `claim-handover` only: the token the last `claimed` on this rendezvous carried, offered when that
     * socket has ended. A verified claim naming the holder's token supersedes the holder; see §9.
     */
    replaces: base64UrlOfBytes(HANDOVER_TOKEN_BYTES).optional(),
  }),
  /**
   * Rendezvous → daemon: the slot is held, these are the limits. `features` echoes the ones the daemon
   * asked for that this rendezvous speaks, and is absent — never empty — for a daemon that asked none,
   * so an older daemon's strict parse never meets a key it does not know. `handover` is the same: sent
   * only to a daemon that asked for `claim-handover`.
   */
  z.strictObject({
    t: z.literal('claimed'),
    protocol: ProtocolIdSchema,
    limits: RelayLimitsSchema,
    features: z.array(z.enum(RELAY_FEATURES)).min(1).max(RELAY_FEATURES.length).readonly().optional(),
    handover: base64UrlOfBytes(HANDOVER_TOKEN_BYTES).optional(),
  }),
  /** Daemon → rendezvous (`claim-probe` only): does the rendezvous's own state still name this socket? */
  z.strictObject({ t: z.literal('probe') }),
  /** Rendezvous → daemon (`claim-probe` only): yes. "No" is the `4410` close, never a message. */
  z.strictObject({ t: z.literal('held') }),
  /** Rendezvous → client: a session identifier was assigned and the daemon is present. */
  z.strictObject({ t: z.literal('ready'), protocol: ProtocolIdSchema, limits: RelayLimitsSchema }),
  /** Rendezvous → daemon: a client arrived on the session this frame is addressed to. */
  z.strictObject({ t: z.literal('open') }),
  /** Rendezvous → either endpoint: this session has ended, and why. */
  z.strictObject({ t: z.literal('closed'), code: z.number().int().min(4000).max(4999), reason: z.string().max(200) }),
  /** Rendezvous → either endpoint: a refusal, sent immediately before the socket closes. */
  z.strictObject({ t: z.literal('error'), code: z.number().int().min(4000).max(4999), reason: z.string().max(200) }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/** The features a daemon asked for in its route's query, ignoring any this version does not speak. */
export function requestedRelayFeatures(search: URLSearchParams): readonly RelayFeature[] {
  const asked = (search.get(RELAY_FEATURES_PARAM) ?? '').split(',');
  return RELAY_FEATURES.filter(feature => asked.includes(feature));
}

export function encodeControlMessage(message: ControlMessage): Uint8Array {
  return utf8Bytes(JSON.stringify(message));
}

/** Decode a control payload. Null covers bad UTF-8, bad JSON and any shape outside the union. */
export function decodeControlMessage(payload: Uint8Array): ControlMessage | null {
  const text = utf8Text(payload);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ControlMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

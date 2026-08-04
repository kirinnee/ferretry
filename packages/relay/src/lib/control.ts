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
  HEARTBEAT_SECONDS,
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_RENDEZVOUS,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
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
  }),
  /** Rendezvous → daemon: the slot is held, these are the limits. */
  z.strictObject({ t: z.literal('claimed'), protocol: ProtocolIdSchema, limits: RelayLimitsSchema }),
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

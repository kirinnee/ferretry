import { z } from 'zod';

/**
 * PAYLOADS WHOSE SCHEMA ANOTHER SUBSYSTEM OWNS, carried through the sealed session unopened.
 *
 * Today's client parsed the pairing answer, the member-join answer, a join challenge and a passkey assertion with
 * the protocol package's schemas. In 5.0 those are Access's and Catalogs' contracts (they provide the `pair`,
 * `device` and `member` session modes, §4.13), and the shell may import neither. So the session client checks only
 * that such a payload is a bounded JSON value, and hands it to the owner's app half, which parses it with its own
 * strict schema before believing a field. The record AROUND the payload stays strict here.
 */
const MAX_OWNER_PAYLOAD_CHARS = 64 * 1024;

export type OwnerPayload = z.infer<ReturnType<typeof z.json>>;

export const OwnerPayloadSchema = z
  .json()
  .refine(value => JSON.stringify(value).length <= MAX_OWNER_PAYLOAD_CHARS, 'payload too large');

/** The daemon's fingerprint id, the session layer's trust anchor (today's `DaemonIdSchema`, copied). */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');

/** A member label as the session record bounds it; Catalogs' contract says what one may BE. */
export const MemberLabelSchema = z.string().min(1).max(200);

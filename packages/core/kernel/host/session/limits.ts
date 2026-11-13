/**
 * The session layer's own numbers: the pre-auth limits it keeps around every mode, the lease, and the stream
 * policies. Copied from today's `link.ts`; the reasoning for each is kept with it.
 */

import { toBase64Url } from './wire/binary.ts';
import { ACCESS_LEASE_SECONDS, ACCESS_RENEW_LEAD_SECONDS, MAX_SESSION_SECONDS } from './wire/vocabulary.ts';

/**
 * How long one holder proof authorises a session, how far ahead of its end the renewal is asked, and the most
 * one session may live. Injected so a suite can drive a lease end and the cap; production is
 * {@link DEFAULT_ACCESS_LEASE_POLICY}.
 */
export interface AccessLeasePolicy {
  readonly leaseMs: number;
  readonly renewLeadMs: number;
  readonly maxSessionMs: number;
}

/** Fifteen minutes, asked again two minutes ahead, twelve hours at most. */
export const DEFAULT_ACCESS_LEASE_POLICY: AccessLeasePolicy = Object.freeze({
  leaseMs: ACCESS_LEASE_SECONDS * 1_000,
  renewLeadMs: ACCESS_RENEW_LEAD_SECONDS * 1_000,
  maxSessionMs: MAX_SESSION_SECONDS * 1_000,
});

/**
 * How long a session may sit without presenting a credential, counted from the moment it OPENED (R232).
 *
 * That window is the one an internet stranger can hold open against a fingerprint that is public by design. It
 * is armed by the open, not by the handshake: otherwise `awaiting-hello` had no deadline and a peer could hold
 * pre-auth capacity forever by answering heartbeats.
 */
export const SESSION_CREDENTIAL_DEADLINE_MS = 10_000;

/**
 * Sessions per carrier that may be pre-credential at once, before a further arrival is refused `4429` (R232).
 *
 * SIX: an ordinary tab opens a request session, an event stream and a terminal stream, and two devices arriving
 * together ask for six. With the deadline armed from the open, holding every slot costs one fresh arrival per
 * slot per ten seconds (36 a minute), above the rendezvous's 30-per-minute admission, so full occupancy is not
 * sustainable.
 */
export const MAX_PRE_CREDENTIAL_SESSIONS = 6;

/**
 * The most un-sent stream backlog one session may hold before its overflow policy decides. Above the
 * one-mebibyte policy every stream applies itself, for the handler that has no rule of its own.
 */
export const SESSION_STREAM_MAX_BUFFERED_BYTES = 2 * 1_024 * 1_024;

/**
 * What the layer's own overflow policies close a stream with: WebSocket codes from the stream taxonomy, sealed
 * inside the channel because why a viewer left is content (R556).
 */
export const SESSION_STREAM_CLOSES = {
  /** One frame is larger than a record can carry, and its stream may neither drop nor split it. */
  oversize: { code: 1009, reason: 'a stream frame exceeds one relay record' },
  /** The viewer stopped keeping up and the stream may not lose what it would have to drop. */
  slowReader: { code: 1013, reason: 'stream reader fell behind' },
  /** The grant this stream was opened under no longer allows it. */
  notAllowed: { code: 1008, reason: 'this stream is no longer allowed' },
} as const;

/** The one public reason a lapsed lease ends a session with; it says nothing about the holder. */
export const ACCESS_LEASE_ENDED_REASON = 'the access lease ended';

/** How many request bodies one session may be assembling at once (R529). */
export const MAX_INCOMING_BODIES = 4;

/**
 * How many requests one session runs at once (R535). A request beyond it waits, in arrival order, and keeps the
 * credit for its own record while it waits. Sixteen: the burst a cold app fires at once.
 */
export const MAX_CONCURRENT_REQUESTS = 16;

/**
 * A valid Ed25519 public key whose private half NOBODY holds, as SPKI. Verified against when a credential names
 * an unknown holder, so an unknown id and a known one cost the same; the result is still thrown away.
 */
export const UNKNOWN_HOLDER_KEY = toBase64Url(
  Uint8Array.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, 0x4c, 0xd5, 0xc3, 0xf6, 0xb1, 0xe2, 0x0d,
    0xa3, 0x74, 0x38, 0x2a, 0xe4, 0x21, 0x2d, 0x78, 0x49, 0x11, 0x34, 0xee, 0xb4, 0xfa, 0xd9, 0xac, 0x64, 0x0f, 0xa8,
    0xc2, 0x97, 0xb1, 0x4b, 0x4f, 0xd0,
  ]),
);

/**
 * THE WEBRTC CARRIER'S WIRE, shared by the two ends that have to agree on it (`docs/relay-protocol.md` §16).
 *
 * A browser and a daemon reach each other peer-to-peer by exchanging ONE offer and ONE answer inside a
 * session the device key already opened, then opening one data channel per session on the path ICE
 * found. Everything on that channel is the session §3–§14 already define; what is new, and lives here,
 * is the introduction: the route the offer crosses, the bounds both ends hold an SDP to, the label a
 * session's channel carries, and the clock each side's gathering and the browser's attempt run on.
 *
 * ONE OWNER FOR NUMBERS TWO PROGRAMS MUST SHARE. The browser's 8-second deadline and the daemon's
 * idle close are stated together so neither end can be tuned into a contradiction of the other.
 */

import { z } from 'zod';

/**
 * The label of a data channel that carries one session.
 *
 * Any other label is closed by the daemon on arrival: a channel is a session or nothing, and an
 * unlabelled extra channel is a stream of bytes nothing on this side would ever read.
 */
export const WEBRTC_SESSION_CHANNEL_LABEL = 'fy-session';

/**
 * The largest SDP either end accepts.
 *
 * An offer for a data-channel-only connection is a few kilobytes even with every candidate a machine
 * with many interfaces gathers. The bound exists because the daemon parses what a device sends and
 * hands it to a native library: an unbounded string is an unbounded allocation in code this daemon
 * did not write.
 */
export const MAX_WEBRTC_SDP_BYTES = 32 * 1024;

/** After the first server-reflexive candidate, how long a side keeps gathering before it signals. */
export const WEBRTC_GATHER_REFLEXIVE_GRACE_MS = 250;

/**
 * The longest a side gathers before it signals whatever it has.
 *
 * Chrome holds its gathering state short of `complete` for about forty seconds against a public STUN
 * server (measured, §16), until every request on every interface has timed out, so "complete" alone
 * would put that wait in front of every attempt.
 */
export const WEBRTC_GATHER_CAP_MS = 3_000;

/**
 * How long the browser waits, from sending its offer, for an open data channel before it stops trying
 * and carries on over the relay.
 */
export const WEBRTC_CONNECT_DEADLINE_MS = 8_000;

/**
 * The STUN servers each end asks for its own public address, unless the daemon's operator names others.
 *
 * Cloudflare states its STUN service "is free and unlimited" and it takes no credential. It learns
 * each end's public address and when it asked — never the daemon fingerprint or anything in a session.
 * There is NO TURN server, deliberately (§16): a path that needs one falls back to the relay.
 */
export const DEFAULT_WEBRTC_ICE_SERVERS: readonly string[] = ['stun:stun.cloudflare.com:3478'];

const SdpSchema = z
  .string()
  .min(1)
  .refine(sdp => new TextEncoder().encode(sdp).byteLength <= MAX_WEBRTC_SDP_BYTES, {
    message: `an SDP is at most ${MAX_WEBRTC_SDP_BYTES} bytes`,
  });

/** What the browser posts: its offer, every candidate it gathered within the bounds above included. */
export const WebRtcOfferRequestSchema = z.strictObject({ sdp: SdpSchema });
export type WebRtcOfferRequest = z.infer<typeof WebRtcOfferRequestSchema>;

/** What the daemon answers: its answer, likewise complete. */
export const WebRtcOfferAnswerSchema = z.strictObject({ sdp: SdpSchema });
export type WebRtcOfferAnswer = z.infer<typeof WebRtcOfferAnswerSchema>;

/**
 * The machine reasons a refused offer carries, so a browser can say which one rather than "it failed".
 *
 * - `webrtc_disabled` — the operator switched the carrier off in this daemon's configuration (503);
 * - `webrtc_unavailable` — this daemon's engine did not load or did not pass its self-test (503);
 * - `webrtc_busy` — this daemon already holds as many peer connections as it carries (429);
 * - `webrtc_offer_invalid` — the engine refused the offer itself (400).
 *
 * A daemon older than this carrier answers `404`, which a browser reads as "not offered yet".
 */
export const WEBRTC_REFUSAL_CODES = [
  'webrtc_disabled',
  'webrtc_unavailable',
  'webrtc_busy',
  'webrtc_offer_invalid',
] as const;
export type WebRtcRefusalCode = (typeof WEBRTC_REFUSAL_CODES)[number];

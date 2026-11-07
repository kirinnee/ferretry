import { isSessionEnd, type CarrierKey, type SessionLayer } from '@ferretry/kernel/contract';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  SESSION_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  SESSION_ID_BYTES,
  type SessionId,
  sessionIdFromBytes,
} from '@ferretry/kernel/wire';
import { encodeControlMessage, RELAY_LIMITS } from '../relay/control.ts';
import type { RelayLinkScheduler, WebRtcSessionFactory } from './carrier.ts';

/** A source of unguessable bytes — WebCrypto in production. */
export type RandomBytes = (length: number) => Uint8Array;

/**
 * Adapt the copied channel lifecycle to the kernel's sealed-frame pull. No session is opened here.
 *
 * The channel is the carrier, so — as today's direct socket does — it mints the session's identifier and
 * announces it with `ready` before any kernel traffic: the browser starts its handshake only on `ready`, and
 * the kernel session waits for that handshake, so a channel that only pumped would deadlock both ends.
 */
export function sealedWebRtcSessions(
  layer: SessionLayer,
  scheduler: RelayLinkScheduler,
  randomBytes: RandomBytes,
): WebRtcSessionFactory {
  return (arrival, downstream, release) => {
    const minted: SessionId | null = sessionIdFromBytes(randomBytes(SESSION_ID_BYTES));
    if (minted === null || minted.bytes.every(byte => byte === 0))
      throw new Error('the session identifier generator produced an unusable identifier');
    const sessionId: SessionId = minted;
    const link = layer.open('webrtc' as CarrierKey, { address: arrival.address });
    let stopped = false;
    let pumping = false;
    let unsubscribe: (() => void) | undefined;
    let drain: { cancel(): void } | undefined;
    const close = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      drain?.cancel();
      link.closed('the peer-to-peer channel closed');
      release();
    };
    const pump = () => {
      if (stopped || pumping) return;
      pumping = true;
      try {
        while (!stopped) {
          // Check the channel before asking the kernel's final permit. Nothing awaits between pull and send.
          if (downstream.bufferedBytes() > 64 * 1024) {
            drain ??= scheduler.after(10, () => {
              drain = undefined;
              pump();
            });
            return;
          }
          const frame = link.outbound.next();
          if (frame === undefined) return;
          if (isSessionEnd(frame)) {
            downstream.close(frame.code, frame.reason);
            close();
            return;
          }
          if (downstream.send(frame.bytes) === -1) {
            close();
            return;
          }
        }
      } finally {
        pumping = false;
      }
    };
    return {
      get sessionId() {
        return sessionId;
      },
      /** Announce the session to the client, then carry the kernel's traffic — the order a rendezvous uses. */
      open: async () => {
        if (stopped) return;
        downstream.send(
          encodeFrame({
            kind: FRAME_KINDS.control,
            sessionId,
            sequence: 0,
            payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
          }),
        );
        unsubscribe = link.outbound.onReady(pump);
        pump();
      },
      fromClient: frame => {
        if (stopped) return;
        if (typeof frame === 'string') {
          if (frame === 'fy-ping') downstream.send('fy-pong');
          else {
            downstream.close(4400, 'unexpected text on a session');
            close();
          }
          return;
        }
        const bytes =
          frame instanceof ArrayBuffer
            ? new Uint8Array(frame)
            : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) {
          downstream.close(decoded.code, decoded.reason);
          close();
          return;
        }
        // As on a direct socket, the channel serves only the session it announced in ready.
        if (decoded.frame.sessionId.text !== sessionId.text) {
          downstream.close(SESSION_CLOSE_CODES.protocolError, 'a frame named no live session');
          close();
          return;
        }
        link.inbound(bytes);
      },
      close,
    };
  };
}

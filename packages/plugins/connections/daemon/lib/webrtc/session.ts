import { isSessionEnd, type CarrierKey, type SessionLayer } from '@ferretry/kernel/contract';
import { decodeFrame, RENDEZVOUS_SESSION_ID } from '../../../worker/src/lib/index.ts';
import type { RelayLinkScheduler, WebRtcSessionFactory } from './carrier.ts';

/** Adapt the copied channel lifecycle to the kernel's sealed-frame pull. No session is opened here. */
export function sealedWebRtcSessions(layer: SessionLayer, scheduler: RelayLinkScheduler): WebRtcSessionFactory {
  return (arrival, downstream, release) => {
    const link = layer.open('webrtc' as CarrierKey, { address: arrival.address });
    let sessionId = RENDEZVOUS_SESSION_ID;
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
          // The public frame header supplies the id for the channel's eventual unsealed `closed` control.
          const header = decodeFrame(frame.bytes);
          if (header.ok) sessionId = header.frame.sessionId;
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
      open: async () => {
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
        link.inbound(
          frame instanceof ArrayBuffer
            ? new Uint8Array(frame)
            : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
        );
      },
      close,
    };
  };
}

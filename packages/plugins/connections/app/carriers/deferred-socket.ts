/**
 * A SOCKET WHOSE CHANNEL IS STILL BEING NEGOTIATED, as the walk's leg takes it (`WalkLeg.open` answers a socket at once).
 *
 * A WebRTC dial is a promise: it signals an offer through an introducer, gathers, and waits for a data channel. The
 * walk wants the socket now, to install its handlers, so this hands one back that adopts the channel when the dial
 * resolves and ends the way a refused socket does when it rejects — with the sentence the dial gave, which the walk
 * shows beside the carrier it fell back to.
 *
 * Closing it BEFORE the channel exists abandons the negotiation (the leg's deadline, an unpair, a new preference), and
 * only then: once there is a channel, closing ends that channel and never the peer connection under it, which other
 * sessions to the same machine are using.
 */
import type { RelayCarrierSocket } from '../adapters/browser-relay-dial.ts';

/** The code a socket that never opened is reported with: it ended abnormally, as a refused connection does. */
const ABNORMAL_CLOSURE = 1006;

export function deferredSocket(dial: Promise<RelayCarrierSocket>, abandon: () => void): RelayCarrierSocket {
  let inner: RelayCarrierSocket | undefined;
  let ended = false;
  const socket: RelayCarrierSocket = {
    onOpen: null,
    onText: null,
    onBinary: null,
    onClose: null,
    send: bytes => inner?.send(bytes),
    sendText: text => inner?.sendText(text),
    close: (code, reason) => {
      if (ended) return;
      ended = true;
      if (inner === undefined) abandon();
      else inner.close(code, reason);
    },
  };
  dial.then(
    channel => {
      // The walk gave up on this leg while the channel was opening: nothing will use it.
      if (ended) {
        channel.close();
        return;
      }
      inner = channel;
      channel.onOpen = () => socket.onOpen?.();
      channel.onText = text => socket.onText?.(text);
      channel.onBinary = bytes => socket.onBinary?.(bytes);
      channel.onClose = (code, reason) => {
        ended = true;
        socket.onClose?.(code, reason);
      };
    },
    (error: unknown) => {
      if (ended) return;
      ended = true;
      socket.onClose?.(ABNORMAL_CLOSURE, error instanceof Error ? error.message : String(error));
    },
  );
  return socket;
}

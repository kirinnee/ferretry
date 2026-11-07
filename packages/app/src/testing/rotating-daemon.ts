/**
 * A scripted daemon that holds a device key and can be told to swap it. Copied from today's PWA
 * `tests/support/rotating-daemon.ts`, onto the shell's {@link CarrierDial}.
 *
 * A plain scripted daemon answers every credential the same way; rotation needs a daemon whose ACCEPTED KEYS change
 * between sessions — the old key is refused once the daemon has swapped — and one that can say what the rotation
 * proof in an unlock or step-up was worth against the transcript of the session that carried it.
 */

import type { CarrierDial, CarrierSocketEvents, CarrierWalkSocket } from '../session/session-transport.ts';
import {
  type DaemonIdentity,
  decodeFrame,
  FRAME_KINDS,
  RELAY_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
} from '../session/wire/index.ts';
import { controlFrame, LEASE_ENDS, readyFrame, ScriptedDaemon, testSessionId } from './relay.ts';

export interface RotatingRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
}

export interface RotatingDaemonOptions {
  /** The public keys the daemon accepts RIGHT NOW. Read per credential, so a swap takes effect at once. */
  readonly accepts: () => readonly string[];
  /** What `authenticated` and `stream-opened` carry as `rotateBy`. */
  readonly rotateBy?: () => string | undefined;
  /**
   * The answer to one request; `'drop'` closes the socket instead, like a carrier that died under it.
   * `daemon` and `deviceId` let the handler judge a rotation proof against its own session.
   */
  readonly respond: (
    request: RotatingRequest,
    session: { readonly daemon: ScriptedDaemon; readonly deviceId: string },
  ) => Promise<{ readonly status: number; readonly body: unknown } | 'drop'>;
  /** Dials from this count on fail as an unreachable carrier does (a socket that closes before `ready`). */
  readonly failFrom?: () => number | undefined;
}

export interface RotatingDial {
  readonly dial: CarrierDial;
  /** Every credential record that arrived, with whether any accepted key proved it. */
  readonly credentials: readonly { readonly t: string; readonly accepted: boolean }[];
  /** How many sockets were dialled. */
  readonly dialled: () => number;
}

export function rotatingDial(identity: DaemonIdentity, options: RotatingDaemonOptions): RotatingDial {
  let sockets = 0;
  const credentials: { readonly t: string; readonly accepted: boolean }[] = [];
  const dial = (events: CarrierSocketEvents): CarrierWalkSocket => {
    sockets += 1;
    const failFrom = options.failFrom?.();
    if (failFrom !== undefined && sockets > failFrom) {
      queueMicrotask(() => events.onClose(1006, 'the address did not answer'));
      return { send() {}, sendText() {}, close() {} };
    }
    const sessionId = testSessionId(sockets);
    const daemon = new ScriptedDaemon(identity, sessionId);
    let queue: Promise<void> = Promise.resolve();
    let deviceId = '';
    let closed = false;
    const deliver = (bytes: Uint8Array): void => {
      if (!closed) events.onBinary(bytes);
    };
    const accepted = async (message: Readonly<Record<string, unknown>>): Promise<boolean> => {
      for (const key of options.accepts()) if (await daemon.proves(message, key)) return true;
      return false;
    };
    const send = (bytes: Uint8Array): void => {
      const copy = Uint8Array.from(bytes);
      queue = queue.then(async () => {
        if (closed) return;
        const decoded = decodeFrame(copy);
        if (!decoded.ok) return;
        if (decoded.frame.kind === FRAME_KINDS.handshake) {
          deliver(await daemon.answer(copy));
          return;
        }
        if (decoded.frame.kind !== FRAME_KINDS.data) return;
        const message = (await daemon.receive(copy)) as Record<string, unknown> & { t: string; id?: number };
        if (message.t === 'auth' || message.t === 'stream') {
          const ok = await accepted(message);
          credentials.push({ t: message.t, accepted: ok });
          if (!ok) {
            deliver(
              controlFrame(sessionId, {
                t: 'closed',
                code: RELAY_CLOSE_CODES.authRejected,
                reason: 'unknown device credential',
              }),
            );
            return;
          }
          deviceId = String(message.deviceId);
          const rotateBy = options.rotateBy?.();
          deliver(
            await daemon.record({
              t: message.t === 'auth' ? 'authenticated' : 'stream-opened',
              protocol: SESSION_PROTOCOL_ID,
              accessExpiresAt: LEASE_ENDS,
              ...(rotateBy === undefined ? {} : { rotateBy }),
            }),
          );
          return;
        }
        if (message.t !== 'req') return;
        const answer = await options.respond(
          {
            method: String(message.method),
            path: String(message.path),
            body: typeof message.body === 'string' ? message.body : undefined,
          },
          { daemon, deviceId },
        );
        if (answer === 'drop') {
          closed = true;
          events.onClose(1006, 'the carrier died under the request');
          return;
        }
        deliver(
          await daemon.record({
            t: 'res',
            id: message.id ?? 1,
            status: answer.status,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(answer.body),
          }),
        );
      });
    };
    queueMicrotask(() => deliver(readyFrame(sessionId)));
    return {
      send,
      sendText() {},
      close() {
        closed = true;
      },
    };
  };
  return { dial, credentials, dialled: () => sockets };
}

/**
 * A scripted daemon that holds a device key and can be told to swap it.
 *
 * `autoDial` answers every credential the same way; rotation needs a daemon whose ACCEPTED KEYS change
 * between sessions — the old key is refused once the daemon has swapped — and one that can say what the
 * rotation proof in a step-up was worth against the transcript of the session that carried it.
 */

import { type DaemonIdentity, decodeFrame, FRAME_KINDS, RELAY_CLOSE_CODES, SESSION_PROTOCOL_ID } from '@ferretry/relay';
import { controlFrame, LEASE_ENDS, readyFrame, ScriptedDaemon, ScriptedSocket, testSessionId } from './relay.ts';

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
}

export const rotatingDial = (identity: DaemonIdentity, options: RotatingDaemonOptions) => {
  const sockets: ScriptedSocket[] = [];
  /** Every credential record that arrived, with whether any accepted key proved it. */
  const credentials: { readonly t: string; readonly accepted: boolean }[] = [];
  const dial = (): ScriptedSocket => {
    const sessionId = testSessionId(sockets.length + 1);
    const daemon = new ScriptedDaemon(identity, sessionId);
    const socket = new ScriptedSocket();
    let queue: Promise<void> = Promise.resolve();
    let deviceId = '';
    const original = socket.send.bind(socket);
    const accepted = async (message: Readonly<Record<string, unknown>>): Promise<boolean> => {
      for (const key of options.accepts()) if (await daemon.proves(message, key)) return true;
      return false;
    };
    socket.send = (bytes: Uint8Array): void => {
      original(bytes);
      queue = queue.then(async () => {
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) return;
        if (decoded.frame.kind === FRAME_KINDS.handshake) {
          socket.onBinary?.(await daemon.answer(bytes));
          return;
        }
        if (decoded.frame.kind !== FRAME_KINDS.data) return;
        const message = (await daemon.receive(bytes)) as Record<string, unknown> & { t: string; id?: number };
        if (message.t === 'auth' || message.t === 'stream') {
          const ok = await accepted(message);
          credentials.push({ t: message.t, accepted: ok });
          if (!ok) {
            socket.onBinary?.(
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
          socket.onBinary?.(
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
          socket.onClose?.(1006, 'the carrier died under the request');
          return;
        }
        socket.onBinary?.(
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
    sockets.push(socket);
    queue = queue.then(async () => {
      await Promise.resolve();
      socket.onOpen?.();
      socket.onBinary?.(readyFrame(sessionId));
    });
    return socket;
  };
  return { dial, sockets, credentials };
};

import { type FyEventStreamFrame, FyEventStreamFrameSchema } from '../../../contract/index.ts';
import type { PluginClient, PluginSocket } from '@ferretry/kernel/manifest';
import { SessionCommandError } from '../session/errors.ts';
import type { IEventStream, StreamScope } from './ports.ts';

/** The socket's manifest key. */
export const EVENTS_SOCKET = 'GET /v1/events';

const decoder = new TextDecoder();

/** The text of one frame, which arrives as a string or as UTF-8 bytes. */
const textOf = (frame: string | Uint8Array): string => (typeof frame === 'string' ? frame : decoder.decode(frame));

/**
 * The journal socket over the shell's guarded client (no socket opened outside it). Today's transport rules: a
 * caller who leaves closes the socket with 1000 "event stream cancelled" and the follow ends quietly; a socket that
 * closes before that is an error naming the daemon's reason and code; a frame the schema refuses ends it too.
 */
export class ClientEventStream implements IEventStream {
  constructor(private readonly client: PluginClient) {}

  async follow(scope: StreamScope, onFrame: (frame: FyEventStreamFrame) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const open = this.client.socket?.bind(this.client);
    if (open === undefined) throw new SessionCommandError('this fy has no event socket to follow', 1);
    const query = {
      after: String(scope.after),
      ...(scope.ferretId === undefined ? {} : { sessionId: scope.ferretId }),
    };
    await new Promise<void>((resolve, reject) => {
      let socket: PluginSocket | undefined;
      let settled = false;
      const finish = (end: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        end();
      };
      const fail = (error: Error): void => {
        finish(() => {
          socket?.close();
          reject(error);
        });
      };
      const cancel = (): void => {
        finish(() => {
          socket?.close(1000, 'event stream cancelled');
          resolve();
        });
      };
      socket = open(
        EVENTS_SOCKET,
        {},
        {
          onFrame: frame => {
            if (settled) return;
            try {
              onFrame(FyEventStreamFrameSchema.parse(JSON.parse(textOf(frame))));
            } catch (error) {
              fail(error instanceof Error ? error : new Error('WebSocket stream failed'));
            }
          },
          onClose: (reason, code) => {
            if (code === undefined) {
              fail(new Error(reason === '' ? 'WebSocket stream failed' : `WebSocket stream failed: ${reason}`));
              return;
            }
            const detail = reason === '' ? `code ${code}` : `${reason} (code ${code})`;
            finish(() => reject(new Error(`WebSocket stream closed unexpectedly: ${detail}`)));
          },
        },
        query,
      );
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
}

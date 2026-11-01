/**
 * The live line from one composer to its session's shared draft on the daemon.
 *
 * One §14 stream session per open composer, on whichever carrier reaches the daemon — direct or relayed,
 * the same either way. Every frame down is parsed before anything trusts it; a frame that does not parse
 * ends the stream, because guessing at a draft is how words get lost.
 *
 * A composer that had a stream before passes where its copy stood (`position`), and the daemon sends only
 * what it missed. Without one, it gets the whole draft.
 */
import {
  type SharedDraftClientFrame,
  type SharedDraftServerFrame,
  SharedDraftServerFrameSchema,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import type { DaemonStreamOpener } from './event-transport.ts';
import type { SharedDraftPosition } from './shared-draft-sync.ts';

export const sharedDraftStreamPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/shared-draft/stream`;

export interface SharedDraftStreamHandlers {
  readonly onFrame: (frame: SharedDraftServerFrame) => void;
  /** The stream ended, for whatever reason: the daemon's code, or ours. Called once. */
  readonly onClosed: (code: number, reason: string) => void;
}

export interface SharedDraftStreamLink {
  send(frame: SharedDraftClientFrame): void;
  /** A deliberate leave, said on the wire as one. */
  close(): void;
}

export const openSharedDraftStream = async (
  open: DaemonStreamOpener,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  position: SharedDraftPosition | undefined,
  handlers: SharedDraftStreamHandlers,
): Promise<SharedDraftStreamLink> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('draft scope must belong to the requested daemon');
  let ended = false;
  const end = (code: number, reason: string): void => {
    if (ended) return;
    ended = true;
    handlers.onClosed(code, reason);
  };
  // A frame can arrive before the session promise below settles, so a damaged one is remembered and the
  // stream is refused the moment there is a session to refuse.
  let damaged = false;
  let refuse: (() => void) | undefined;
  /**
   * A draft too big for one frame, being put back together: its `snapshot` holds the first part and how
   * many `snapshot-text` parts follow. Nothing else may arrive in between, and the composer only ever
   * sees the whole draft.
   */
  let assembling:
    | { frame: Extract<SharedDraftServerFrame, { kind: 'snapshot' }>; text: string; left: number }
    | undefined;
  const assemble = (frame: SharedDraftServerFrame): SharedDraftServerFrame | 'wait' | undefined => {
    if (assembling !== undefined) {
      if (frame.kind !== 'snapshot-text') return undefined;
      assembling.text += frame.text;
      assembling.left -= 1;
      if (assembling.left > 0) return 'wait';
      const { frame: first, text } = assembling;
      assembling = undefined;
      return { kind: 'snapshot', snapshot: { ...first.snapshot, text } };
    }
    if (frame.kind === 'snapshot-text') return undefined;
    if (frame.kind === 'snapshot' && frame.more !== undefined) {
      assembling = { frame, text: frame.snapshot.text, left: frame.more };
      return 'wait';
    }
    return frame;
  };
  const session = await open(daemon, {
    path: sharedDraftStreamPath(scope),
    ...(position === undefined
      ? {}
      : {
          query: [
            ['generation', position.generation],
            ['epoch', String(position.epoch)],
            ['rev', String(position.rev)],
          ] as const,
        }),
    onData: data => {
      if (ended || damaged) return;
      let parsed: SharedDraftServerFrame | undefined;
      if (data.kind === 'text') {
        try {
          const result = SharedDraftServerFrameSchema.safeParse(JSON.parse(data.text));
          parsed = result.success ? result.data : undefined;
        } catch {
          parsed = undefined;
        }
      }
      const whole = parsed === undefined ? undefined : assemble(parsed);
      if (whole === undefined) {
        damaged = true;
        refuse?.();
        return;
      }
      if (whole !== 'wait') handlers.onFrame(whole);
    },
  });
  refuse = () => {
    session.closeStream(1003, 'the composer could not read this stream');
    end(1003, 'the daemon sent a frame this composer could not read');
  };
  session.onStreamClosed(closed => end(closed.code, closed.reason));
  if (damaged) refuse();
  return {
    send: frame => {
      if (!ended) session.sendStream({ kind: 'text', text: JSON.stringify(frame) });
    },
    close: () => {
      if (ended) return;
      session.closeStream(1000, 'the composer left this stream');
      end(1000, 'the composer left this stream');
    },
  };
};

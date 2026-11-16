/**
 * The live line from one composer to its ferret's shared draft on the daemon.
 *
 * One stream per open composer, through the half's own client — direct or relayed, the same either way.
 * Every frame down is parsed before anything trusts it; a frame that does not parse ends the stream,
 * because guessing at a draft is how words get lost.
 *
 * The stream carries the same raw text as the two owner-only shared-draft routes (`OWN_DRAFT`); nothing
 * here masks or copies it.
 *
 * GAP(app-shell), see `./seam-drafts.ts`: the client's socket carries no query, so the stream opens for the
 * ferret's chat draft only and always starts from the whole draft; `position` is accepted and not sent.
 */
import { type DraftClientFrame, type DraftServerFrame, DraftServerFrameSchema } from '../../contract/index.ts';
import type { DraftPosition } from './shared-draft-sync.ts';
import type { DaemonFerretScope } from './seam.ts';
import { closeCodeOf, type DraftStreamClient } from './seam-drafts.ts';

export const SHARED_DRAFT_STREAM_ROUTE = 'GET /v1/ferrets/:ferretId/shared-draft/stream';

export interface SharedDraftStreamHandlers {
  readonly onFrame: (frame: DraftServerFrame) => void;
  /** The stream ended, for whatever reason: the daemon's code, or ours. Called once. */
  readonly onClosed: (code: number, reason: string) => void;
}

export interface SharedDraftStreamLink {
  send(frame: DraftClientFrame): void;
  /** A deliberate leave, said on the wire as one. */
  close(): void;
}

export const openSharedDraftStream = async (
  client: Pick<DraftStreamClient, 'socket'>,
  scope: DaemonFerretScope,
  _position: DraftPosition | undefined,
  handlers: SharedDraftStreamHandlers,
): Promise<SharedDraftStreamLink> => {
  if (client.socket === undefined) throw new Error('this client opens no live stream');
  // An item's own draft is named only in the query, which the client's socket cannot carry: opening the bare
  // route would stream the CHAT's draft into an item's composer. Refused, never guessed.
  if (scope.item !== undefined) throw new Error('an item draft has no live stream yet');
  let ended = false;
  const end = (code: number, reason: string): void => {
    if (ended) return;
    ended = true;
    handlers.onClosed(code, reason);
  };
  // A frame can arrive before the socket handle below is assigned, so a damaged one is remembered and the
  // stream is refused the moment there is a socket to refuse.
  let damaged = false;
  let refuse: (() => void) | undefined;
  /**
   * A draft too big for one frame, being put back together: its `snapshot` holds the first part and how
   * many `snapshot-text` parts follow. Nothing else may arrive in between, and the composer only ever
   * sees the whole draft.
   */
  let assembling: { frame: Extract<DraftServerFrame, { kind: 'snapshot' }>; text: string; left: number } | undefined;
  const assemble = (frame: DraftServerFrame): DraftServerFrame | 'wait' | undefined => {
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
  const socket = client.socket(
    SHARED_DRAFT_STREAM_ROUTE,
    { ferretId: scope.ferretId },
    {
      onFrame: data => {
        if (ended || damaged) return;
        let parsed: DraftServerFrame | undefined;
        if (typeof data === 'string') {
          try {
            const result = DraftServerFrameSchema.safeParse(JSON.parse(data));
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
      onClose: reason => end(closeCodeOf(reason), reason),
    },
  );
  refuse = () => {
    socket.close();
    end(1003, 'the daemon sent a frame this composer could not read');
  };
  if (damaged) refuse();
  return {
    send: frame => {
      if (!ended) socket.send(JSON.stringify(frame));
    },
    close: () => {
      if (ended) return;
      socket.close();
      end(1000, 'the composer left this stream');
    },
  };
};

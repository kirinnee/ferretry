import { useCallback, useRef, useState } from 'react';
import type { PostedAnswer } from '../../../contract/index.ts';
import { failureOf, isSecretStop, type PostPayload, type PullAddress, type PullsClient, sendPost } from './api.ts';

/** What the person is told after a tap. One phase at a time: the screen draws exactly this. */
export type PostPhase =
  | { readonly status: 'idle' }
  | { readonly status: 'posting' }
  | { readonly status: 'posted'; readonly answer: PostedAnswer }
  /** The call may have reached GitHub and no answer came back: the thread is read again to see. */
  | { readonly status: 'unknown' }
  | { readonly status: 'secret'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string };

/** One id per tap's worth of text, minted when there is none: a repeat of the same tap carries the same one. */
function mintRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .slice(0, 40)
    .padEnd(16, '0');
}

/**
 * Posting as a state machine, so a double tap cannot post twice:
 * - `posting` blocks a second call here (a ref, so it holds before React draws the disabled button), and the daemon's
 *   ledger answers a repeat of the same request id with the first result;
 * - the request id is kept for as long as the text and the place are the same, so a retry after a lost answer is a repeat
 *   and not a second post; it is dropped after a success (the same words typed again are a new comment) and when the
 *   person chooses "Post again" after an unknown.
 */
export function usePost(
  client: PullsClient,
  address: PullAddress,
  payload: PostPayload,
  onChanged: () => void,
  onPosted?: () => void,
) {
  const [phase, setPhase] = useState<PostPhase>({ status: 'idle' });
  const busy = useRef(false);
  const held = useRef<{ readonly key: string; readonly id: string } | undefined>(undefined);

  const post = useCallback(
    async (body: string, postAnyway = false): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setPhase({ status: 'posting' });
      const key = JSON.stringify([address, payload, body]);
      if (held.current?.key !== key) held.current = { key, id: mintRequestId() };
      try {
        const answer = await sendPost(client, address, payload, {
          requestId: held.current.id,
          body,
          ...(postAnyway ? { postAnyway: true as const } : {}),
        });
        if (answer.kind === 'posted') {
          held.current = undefined;
          setPhase({ status: 'posted', answer });
          onPosted?.();
        } else setPhase({ status: 'unknown' });
        onChanged();
      } catch (cause) {
        const failure = failureOf(cause);
        if (isSecretStop(failure)) setPhase({ status: 'secret', message: failure.message });
        // A call that died on the carrier may have reached the daemon: it is not "failed", it is "not known".
        else if (failure.carrier) {
          setPhase({ status: 'unknown' });
          onChanged();
        } else setPhase({ status: 'failed', message: failure.message });
      } finally {
        busy.current = false;
      }
    },
    [client, address, payload, onChanged, onPosted],
  );

  /** "Post again" after an unknown: the person has looked and it is not there, so this is a new post. */
  const postAgain = useCallback(() => {
    held.current = undefined;
    setPhase({ status: 'idle' });
  }, []);
  const clear = useCallback(() => setPhase({ status: 'idle' }), []);
  return { phase, post, postAgain, clear };
}

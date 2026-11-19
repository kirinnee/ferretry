import { useCallback, useRef, useState } from 'react';
import type { ExpectedAccount, PostedAnswer } from '../../../contract/index.ts';
import { readPullPage } from '../../lib/client.ts';
import { fetchThreads } from '../threads/api.ts';
import {
  failureOf,
  isAccountChanged,
  isSecretStop,
  type PostPayload,
  type PullAddress,
  type PullsClient,
  sendPost,
} from './api.ts';

/**
 * What the person is told after a tap. One phase at a time: the screen draws exactly this.
 *
 * `unknown` carries what the follow-up read found: `reading` (the thread is being read again, so "post again" is not
 * offered yet), `read` (it was read, and the person can now look and decide), `unread` (the read failed: the person is
 * told to look on GitHub, and may read again).
 */
export type PostPhase =
  | { readonly status: 'idle' }
  | { readonly status: 'posting' }
  | { readonly status: 'posted'; readonly answer: PostedAnswer }
  | { readonly status: 'unknown'; readonly check: 'reading' | 'read' | 'unread' }
  | { readonly status: 'secret'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string };

/** What a post tells the page around it. */
export interface PostHooks {
  /** The PR page reads itself again (a post changed it, or may have). */
  readonly onChanged: () => void;
  /** The review threads are read again (the post may be in one). */
  readonly onThreadsChanged: () => void;
  /** The daemon says the account this project posts as is not the one that was shown: read it again. */
  readonly onAccountChanged: () => void;
  readonly onPosted?: () => void;
}

/** One id per tap's worth of text, minted when there is none: a repeat of the same tap carries the same one. */
function mintRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .slice(0, 40)
    .padEnd(16, '0');
}

/**
 * Reads the place a post would be (the actual thread for a reply or a line comment, the page for a PR comment), fresh,
 * and says whether it could be read. It is what stands between "not sure it was posted" and "post again".
 */
async function readWhereItWouldBe(client: PullsClient, address: PullAddress, payload: PostPayload): Promise<boolean> {
  try {
    if (payload.kind === 'comment') await readPullPage(client, address);
    else await fetchThreads(client, address.project, address.owner, address.name, address.number);
    return true;
  } catch {
    return false;
  }
}

/**
 * Posting as a state machine, so a double tap cannot post twice:
 * - `posting` blocks a second call here (a ref, so it holds before React draws the disabled button), and the daemon's
 *   ledger answers a repeat of the same request id with the first result;
 * - the request id is kept for as long as the text, the place and the account are the same, so a retry after a lost
 *   answer is a repeat and not a second post; it is dropped after a success (the same words typed again are a new
 *   comment) and when the person chooses "Post again" after an unknown;
 * - after an unknown the actual thread is read again first, and "post again" is offered only once it has been read.
 */
export function usePost(
  client: PullsClient,
  address: PullAddress,
  payload: PostPayload,
  account: ExpectedAccount | null | undefined,
  hooks: PostHooks,
) {
  const [phase, setPhase] = useState<PostPhase>({ status: 'idle' });
  const busy = useRef(false);
  const held = useRef<{ readonly key: string; readonly id: string } | undefined>(undefined);
  const { onChanged, onThreadsChanged, onAccountChanged, onPosted } = hooks;

  /** The follow-up after an unknown: both places are read again, and the phase says whether the thread could be read. */
  const check = useCallback(async (): Promise<void> => {
    setPhase({ status: 'unknown', check: 'reading' });
    onChanged();
    onThreadsChanged();
    const read = await readWhereItWouldBe(client, address, payload);
    setPhase({ status: 'unknown', check: read ? 'read' : 'unread' });
  }, [client, address, payload, onChanged, onThreadsChanged]);

  const post = useCallback(
    async (body: string, postAnyway = false): Promise<void> => {
      if (busy.current || account === undefined || account === null) return;
      busy.current = true;
      setPhase({ status: 'posting' });
      const key = JSON.stringify([address, payload, account.id, body]);
      if (held.current?.key !== key) held.current = { key, id: mintRequestId() };
      try {
        const answer = await sendPost(client, address, payload, {
          requestId: held.current.id,
          body,
          account,
          ...(postAnyway ? { postAnyway: true as const } : {}),
        });
        if (answer.kind === 'posted') {
          held.current = undefined;
          setPhase({ status: 'posted', answer });
          onPosted?.();
          onChanged();
          onThreadsChanged();
        } else await check();
      } catch (cause) {
        const failure = failureOf(cause);
        if (isSecretStop(failure)) setPhase({ status: 'secret', message: failure.message });
        else if (isAccountChanged(failure)) {
          // Nothing was sent: the daemon's sentence says who it would post as now, and the button is re-labelled.
          onAccountChanged();
          setPhase({ status: 'failed', message: failure.message });
        }
        // A call that died on the carrier may have reached the daemon: it is not "failed", it is "not known".
        else if (failure.carrier) await check();
        else setPhase({ status: 'failed', message: failure.message });
      } finally {
        busy.current = false;
      }
    },
    [client, address, payload, account, onChanged, onThreadsChanged, onAccountChanged, onPosted, check],
  );

  /** "Post again" after an unknown: the person has looked and it is not there, so this is a new post. */
  const postAgain = useCallback(() => {
    held.current = undefined;
    setPhase({ status: 'idle' });
  }, []);
  const clear = useCallback(() => setPhase({ status: 'idle' }), []);
  return { phase, post, postAgain, check, clear };
}

import { useEffect, useState } from 'react';
import type { ReviewThreadsAnswer } from '../../../contract/index.ts';
import { fetchThreads, type PullsClient } from './api.ts';

export type ThreadsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly answer: ReviewThreadsAnswer; readonly refreshing: boolean }
  | { readonly status: 'failed'; readonly message: string; readonly answer?: ReviewThreadsAnswer };

export interface ThreadsTarget {
  readonly project: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  /** The PR's `updatedAt`: a change reads the threads again. */
  readonly updatedAt: string;
  /** Moves when something other than the PR needs the threads read again (a post that may have gone out). */
  readonly reload?: number;
}

/** What was read, and for which client and PR: an answer is only ever shown for the PR it was read for. */
interface Held {
  readonly client: PullsClient;
  readonly pr: string;
  readonly state: ThreadsState;
}

const LOADING: ThreadsState = { status: 'loading' };

/**
 * Reads the threads when the PR page opens and when the PR changes. A re-read of the SAME pull request (its `updatedAt`
 * moved) keeps what is on screen until the new answer lands (one draw per state, no empty frame between), and a failed
 * re-read keeps the last answer with the reason. Another PR (or another client) starts over: its first frame is
 * `loading`, and a failed read of it shows no thread of the PR before.
 */
export function useThreads(client: PullsClient, target: ThreadsTarget): ThreadsState {
  const { project, owner, name, number, updatedAt, reload } = target;
  const pr = JSON.stringify([project, owner, name, number]);
  const [held, setHeld] = useState<Held>({ client, pr, state: LOADING });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `updatedAt` and `reload` are read nowhere inside, on purpose: a PR that changed, or a post that may have gone out, reads its threads again.
  useEffect(() => {
    let live = true;
    setHeld(before =>
      before.client !== client || before.pr !== pr
        ? { client, pr, state: LOADING }
        : before.state.status === 'ready'
          ? { ...before, state: { ...before.state, refreshing: true } }
          : before,
    );
    fetchThreads(client, project, owner, name, number).then(
      answer => live && setHeld({ client, pr, state: { status: 'ready', answer, refreshing: false } }),
      (cause: unknown) =>
        live &&
        setHeld(before => ({
          client,
          pr,
          state: {
            status: 'failed',
            message: cause instanceof Error ? cause.message : 'The threads could not be read',
            ...(before.state.status === 'loading' || before.state.answer === undefined
              ? {}
              : { answer: before.state.answer }),
          },
        })),
    );
    return () => {
      live = false;
    };
  }, [client, pr, project, owner, name, number, updatedAt, reload]);
  return held.client === client && held.pr === pr ? held.state : LOADING;
}

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
}

/**
 * Reads the threads when the PR page opens and when the PR changes. A re-read keeps what is on screen until the new
 * answer lands (one draw per state, no empty frame between), and a failed re-read keeps the last answer with the reason.
 */
export function useThreads(client: PullsClient, target: ThreadsTarget): ThreadsState {
  const [state, setState] = useState<ThreadsState>({ status: 'loading' });
  const { project, owner, name, number, updatedAt } = target;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `updatedAt` is read nowhere inside, on purpose: a PR that changed reads its threads again.
  useEffect(() => {
    let live = true;
    setState(before => (before.status === 'ready' ? { ...before, refreshing: true } : before));
    fetchThreads(client, project, owner, name, number).then(
      answer => live && setState({ status: 'ready', answer, refreshing: false }),
      (cause: unknown) =>
        live &&
        setState(before => ({
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'The threads could not be read',
          ...(before.status === 'loading' || before.answer === undefined ? {} : { answer: before.answer }),
        })),
    );
    return () => {
      live = false;
    };
  }, [client, project, owner, name, number, updatedAt]);
  return state;
}

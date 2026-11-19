import type { PluginClient } from '@ferretry/kernel/manifest';
import { readPress } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { budgetSentence, PullFilesAnswerSchema, type PullFilesAnswer, type RepoRef } from '../../../contract/index.ts';
import { repoSegment } from '../../../contract/repo-segment.ts';

const FILES_ROUTE = 'GET /v1/pulls/:project/:repo/:number/files';

/** The generated per-daemon client, narrowed to what this view uses. */
export type PullsClient = Pick<PluginClient, 'call'>;

type FilesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly answer: PullFilesAnswer }
  | { readonly status: 'failed'; readonly message: string };

/** A read's answer, tagged with the PR it is for, so a different PR never shows the last one's files. */
type Held = { readonly key: string; readonly state: FilesState };

/** What a refusal says to the person: GitHub's pause in the one sentence every screen uses, anything else as worded. */
export function describeFailure(cause: unknown, formatTime: (ms: number) => string): string {
  const failure = cause as { code?: unknown; body?: { pausedUntilMs?: unknown }; message?: unknown } | null;
  if (failure?.code === 'pulls_paused') {
    const until = failure.body?.pausedUntilMs;
    return budgetSentence(typeof until === 'number' ? formatTime(until) : 'the limit resets');
  }
  return typeof failure?.message === 'string' && failure.message !== ''
    ? failure.message
    : 'The files could not be loaded.';
}

const localTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Loads a PR's files. A change of PR starts over; `reload` reads again (a `304` costs GitHub nothing). */
export function usePullFiles(
  client: PullsClient,
  project: string,
  { owner, name }: Pick<RepoRef, 'owner' | 'name'>,
  number: number,
) {
  const [held, setHeld] = useState<Held>({ key: '', state: { status: 'loading' } });
  const [round, setRound] = useState(0);
  // Set by Try again, spent by the very next read: only that one is the person's press.
  const pressed = useRef(false);
  const segment = repoSegment({ owner, name });
  const key = `${project}/${segment}/${number}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the reload trigger; the effect does not read it
  useEffect(() => {
    let live = true;
    const press = readPress(pressed.current);
    pressed.current = false;
    client
      .call(FILES_ROUTE, { params: { project, repo: segment, number: String(number) }, ...press })
      .then(raw => {
        if (live) setHeld({ key, state: { status: 'ready', answer: PullFilesAnswerSchema.parse(raw) } });
      })
      .catch((cause: unknown) => {
        if (live) setHeld({ key, state: { status: 'failed', message: describeFailure(cause, localTime) } });
      });
    return () => {
      live = false;
    };
  }, [client, key, project, segment, number, round]);
  const reload = useCallback(() => {
    pressed.current = true;
    setRound(value => value + 1);
  }, []);
  const state: FilesState = held.key === key ? held.state : { status: 'loading' };
  return { state, reload } as const;
}

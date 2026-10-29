/**
 * The two reads behind the Processes tab: the LIST of what runs under a ferret, and the OUTPUT of one
 * process followed as it grows.
 *
 * Both poll with one request in flight at a time (the next is scheduled when the last one settles, so a
 * slow carrier never stacks reads), skip a read while the page is hidden, take one at once when it is
 * shown again, and discard an answer that arrives after the daemon, session or process changed under
 * them. A failed read after a good one keeps the good one and marks it stale; it never turns a list into
 * an all-clear.
 */

import type { SessionProcessList, SessionProcessOutput } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  isForbidden,
  listSessionProcesses,
  processErrorText,
  readSessionProcessOutput,
} from '../../lib/session-processes.ts';
import { useDaemonFetch } from '../../lib/store.tsx';

/** How often the list is read while the tab is on screen. */
const PROCESS_LIST_POLL_MS = 2_000;
/** How often it is read while another tab is on screen — enough to keep the count on the tab honest. */
const PROCESS_LIST_BACKGROUND_POLL_MS = 15_000;
/** How often an open row's output is read. */
const PROCESS_OUTPUT_POLL_MS = 1_000;
/** The most output text held for one process; older text is dropped, and the pane says so. */
export const PROCESS_OUTPUT_HELD_MAX = 2 * 1024 * 1024;

type ProcessListReader = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal: AbortSignal,
) => Promise<SessionProcessList>;

export type ProcessOutputReader = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  processId: string,
  after: number | undefined,
  signal: AbortSignal,
) => Promise<SessionProcessOutput>;

export type ProcessListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly list: SessionProcessList }
  | { readonly status: 'stale'; readonly list: SessionProcessList; readonly reason: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error'; readonly reason: string };

export const processListOf = (state: ProcessListState): SessionProcessList | null =>
  state.status === 'ready' || state.status === 'stale' ? state.list : null;

const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

export interface SessionProcessesOptions {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** The Processes tab is the one on screen: read quickly. Otherwise only often enough to keep the count. */
  readonly visible: boolean;
  readonly reader?: ProcessListReader;
  readonly pollMs?: number;
  readonly backgroundPollMs?: number;
  readonly isHidden?: () => boolean;
}

interface Keyed<T> {
  readonly key: string;
  readonly value: T;
}

/** Polls the process list for one session. Changing daemon or session starts again from `loading`. */
export function useSessionProcesses({
  connection,
  scope,
  visible,
  reader,
  pollMs = PROCESS_LIST_POLL_MS,
  backgroundPollMs = PROCESS_LIST_BACKGROUND_POLL_MS,
  isHidden = documentHidden,
}: SessionProcessesOptions): { readonly state: ProcessListState; readonly refresh: () => void } {
  const fetcher = useDaemonFetch();
  const key = `${connection.daemonId}\u0000${scope.sessionId}`;
  const [held, setHeld] = useState<Keyed<ProcessListState>>({ key, value: { status: 'loading' } });
  const [revision, setRevision] = useState(0);
  const reading: ProcessListReader =
    reader ?? ((daemon, at, signal) => listSessionProcesses(daemon, at, fetcher, signal));
  const read = useRef(reading);
  read.current = reading;
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the deliberate "read again now" trigger
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let busy = false;
    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      let forbidden = false;
      if (!isHidden()) {
        try {
          const list = await read.current(connection, scope, controller.signal);
          if (cancelled) return;
          setHeld({ key, value: { status: 'ready', list } });
        } catch (cause) {
          if (cancelled) return;
          forbidden = isForbidden(cause);
          const reason = processErrorText(cause);
          setHeld(current => {
            const prior = current.key === key ? processListOf(current.value) : null;
            if (forbidden) return { key, value: { status: 'forbidden' } };
            return {
              key,
              value: prior === null ? { status: 'error', reason } : { status: 'stale', list: prior, reason },
            };
          });
        }
      }
      busy = false;
      if (cancelled) return;
      timer = setTimeout(() => void poll(), forbidden || !visible ? backgroundPollMs : pollMs);
    };
    const onVisible = (): void => {
      if (isHidden()) return;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connection, scope, key, visible, pollMs, backgroundPollMs, isHidden, revision]);

  return { state: held.key === key ? held.value : { status: 'loading' }, refresh };
}

/* ---------- following one process's output ---------- */

export interface HeldOutput {
  /** Everything held, ANSI escapes kept. */
  readonly text: string;
  /** The byte the next read asks after: the last answer's `end`. Absent before the first answer. */
  readonly end: number | undefined;
  /** Text before what is held exists and is not shown. */
  readonly skipped: boolean;
  readonly source: SessionProcessOutput['source'] | undefined;
  readonly reason: string | undefined;
  /** Nothing more will be written. */
  readonly complete: boolean;
}

export const EMPTY_OUTPUT: HeldOutput = {
  text: '',
  end: undefined,
  skipped: false,
  source: undefined,
  reason: undefined,
  complete: false,
};

/**
 * Folds one answer into what is held — the whole of the follow bookkeeping, kept pure so it is tested
 * without a clock:
 *
 *  - the first answer (no `end` held) is the tail, and says whether earlier text exists;
 *  - `reset` means the file was replaced or truncated: what is held is dropped and the answer stands alone;
 *  - `skipped` after the first read means the gap was larger than one read: what is held no longer
 *    touches the new text, so it is dropped and the pane says "earlier output not shown";
 *  - otherwise the answer continues what is held, which is capped at {@link PROCESS_OUTPUT_HELD_MAX}.
 */
export const applyOutput = (held: HeldOutput, answer: SessionProcessOutput): HeldOutput => {
  const base = { end: answer.end, source: answer.source, reason: answer.reason, complete: answer.complete };
  if (held.end === undefined || answer.reset || answer.skipped) {
    return { ...base, text: answer.text, skipped: answer.skipped };
  }
  const joined = held.text + answer.text;
  if (joined.length <= PROCESS_OUTPUT_HELD_MAX) return { ...base, text: joined, skipped: held.skipped };
  return { ...base, text: joined.slice(joined.length - PROCESS_OUTPUT_HELD_MAX), skipped: true };
};

export type ProcessOutputState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly output: HeldOutput }
  | { readonly status: 'stale'; readonly output: HeldOutput; readonly reason: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error'; readonly reason: string };

export interface ProcessOutputOptions {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly processId: string;
  /** Changes when the list learns the output is now somewhere else to read (a process that exited). */
  readonly sourceKey?: string;
  readonly reader?: ProcessOutputReader;
  readonly pollMs?: number;
  readonly isHidden?: () => boolean;
}

/** Follows one process's output: the tail first, then everything after the last answer's `end`. */
export function useProcessOutput({
  connection,
  scope,
  processId,
  sourceKey = '',
  reader,
  pollMs = PROCESS_OUTPUT_POLL_MS,
  isHidden = documentHidden,
}: ProcessOutputOptions): ProcessOutputState {
  const fetcher = useDaemonFetch();
  const key = `${connection.daemonId}\u0000${scope.sessionId}\u0000${processId}\u0000${sourceKey}`;
  const [held, setHeld] = useState<Keyed<ProcessOutputState>>({ key, value: { status: 'loading' } });
  const reading: ProcessOutputReader =
    reader ?? ((daemon, at, id, after, signal) => readSessionProcessOutput(daemon, at, id, after, fetcher, signal));
  const read = useRef(reading);
  read.current = reading;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output = EMPTY_OUTPUT;
    const controller = new AbortController();
    let busy = false;
    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      let done = false;
      if (!isHidden()) {
        try {
          const answer = await read.current(connection, scope, processId, output.end, controller.signal);
          if (cancelled) return;
          output = applyOutput(output, answer);
          done = output.complete || output.source === 'none';
          setHeld({ key, value: { status: 'ready', output } });
        } catch (cause) {
          if (cancelled) return;
          const reason = processErrorText(cause);
          if (isForbidden(cause)) {
            done = true;
            setHeld({ key, value: { status: 'forbidden' } });
          } else {
            setHeld({
              key,
              value: output.end === undefined ? { status: 'error', reason } : { status: 'stale', output, reason },
            });
          }
        }
      }
      busy = false;
      if (!done && !cancelled) timer = setTimeout(() => void poll(), pollMs);
    };
    const onVisible = (): void => {
      if (isHidden()) return;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connection, scope, processId, key, pollMs, isHidden]);

  return held.key === key ? held.value : { status: 'loading' };
}

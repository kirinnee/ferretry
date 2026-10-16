import type { IFyApiClient, SendRecord, SessionView } from '@ferretry/protocol';

import type { TranscriptEntry } from '../lib/session-screens.ts';
import type { ToolResultData, ToolUseData } from '../lib/tool-extract.ts';
import { fieldHash } from './session-chat-model.ts';

const LOG_HEADER = /^(?:\[(\d{2}:\d{2}:\d{2})\] )?(user|assistant|developer|system|tool)\/([a-z-]+):(?: (.*))?$/u;

interface LogRecord {
  readonly clock?: string;
  readonly role: 'user' | 'assistant' | 'developer' | 'system' | 'tool';
  readonly kind: string;
  readonly lines: readonly string[];
}

const title = (value: string): string =>
  value
    .split('-')
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const recordLabel = (record: LogRecord): string => {
  const speaker =
    record.role === 'user'
      ? 'You'
      : record.role === 'assistant'
        ? record.kind === 'message'
          ? 'Assistant'
          : title(record.kind)
        : record.role === 'tool'
          ? `Tool · ${title(record.kind)}`
          : title(record.role);
  return record.clock === undefined ? speaker : `${speaker} · ${record.clock}`;
};

const recordKind = (record: LogRecord): TranscriptEntry['kind'] => {
  if (record.role === 'user' && record.kind === 'message') return 'user';
  if (record.role === 'assistant' && record.kind === 'message') return 'assistant';
  return 'notice';
};

/**
 * WHICH MACHINE RECORDS ARE BOOKKEEPING. Reasoning, token usage, turn markers, settings echoes and
 * attachment stubs are evidence a reader occasionally wants and never reads first, so they are kept
 * — behind "Show details" — rather than dropped. An `error` is never bookkeeping: a failure that hid
 * behind a toggle would be a bug, not tidiness.
 */
const isDetailRecord = (record: LogRecord): boolean => record.kind !== 'error' && recordKind(record) === 'notice';

const entryFor = (record: LogRecord, index: number): TranscriptEntry => {
  const text = record.lines.join('\n');
  const signature = `${record.clock ?? ''}|${record.role}|${record.kind}|${text}`;
  return {
    id: `log:${index}:${fieldHash(signature)}`,
    kind: recordKind(record),
    text: text || title(record.kind),
    label: recordLabel(record),
    ...(isDetailRecord(record) ? { detail: true } : {}),
    ...(record.kind === 'error' ? { alert: true } : {}),
  };
};

/** `Read({"path":"src/App.tsx"})` — the daemon's rendering of one tool call. */
const TOOL_CALL = /^([^\s(]+)\(([\s\S]*)\)$/u;

const toolUse = (text: string): ToolUseData => {
  const match = TOOL_CALL.exec(text.trim());
  if (match === null) return { name: text.trim() || 'tool' };
  const raw = match[2] as string;
  try {
    return { name: match[1] as string, input: JSON.parse(raw) as unknown };
  } catch {
    return { name: match[1] as string, input: raw };
  }
};

/** The daemon prefixes a failed result with `error `; there is no other marker on this wire. */
const toolResult = (text: string): ToolResultData =>
  text.startsWith('error ') ? { text: text.slice('error '.length), isError: true } : { text };

interface ToolRun {
  readonly index: number;
  readonly calls: { key: string; use: ToolUseData; result?: ToolResultData; orphanResult?: boolean }[];
}

/**
 * A run of consecutive tool calls and their results, as ONE row — the transcript's own collapsed
 * tool group, which reads as `4 tools · Read, Edit ×2, Bash` and opens to each call's input and
 * output. Results pair with the oldest call in the run still waiting for one; a result with no call
 * to pair with is kept as an orphan rather than dropped, because a row that silently vanished would
 * read as a tool that never ran.
 */
const toolEntry = (run: ToolRun): TranscriptEntry => ({
  id: `log:${run.index}:${fieldHash(run.calls.map(call => call.key).join('|'))}`,
  kind: 'tool',
  text: run.calls.length === 1 ? 'ran a tool' : `ran ${run.calls.length} tools`,
  tools: run.calls,
});

const projectRecords = (records: readonly LogRecord[]): readonly TranscriptEntry[] => {
  const entries: TranscriptEntry[] = [];
  let run: ToolRun | null = null;
  records.forEach((record, index) => {
    const text = record.lines.join('\n');
    if (record.kind === 'tool-call' || record.kind === 'tool-result') {
      run ??= { index, calls: [] };
      const key = `log:${index}:${fieldHash(`${record.kind}|${text}`)}`;
      if (record.kind === 'tool-call') {
        run.calls.push({ key, use: toolUse(text) });
        return;
      }
      const waiting = run.calls.find(call => call.result === undefined && call.orphanResult !== true);
      if (waiting === undefined)
        run.calls.push({ key, use: { name: 'result' }, result: toolResult(text), orphanResult: true });
      else waiting.result = toolResult(text);
      return;
    }
    if (run !== null) entries.push(toolEntry(run));
    run = null;
    entries.push(entryFor(record, index));
  });
  if (run !== null) entries.push(toolEntry(run));
  return entries;
};

/**
 * Projects the daemon's proved, normalized `logs` tail into the already-ported
 * transcript component. The wire format is deliberately parsed rather than
 * guessed from harness JSON: `OperatorReadService.renderTranscript` is the
 * compatibility contract this first workspace slice consumes. The daemon's
 * paged event route is mounted, but structured history/live-event projection
 * remains an explicit integration gap.
 */
export const transcriptEntriesFromLog = (text: string): readonly TranscriptEntry[] => {
  if (text.trim() === '') return [];
  const records: LogRecord[] = [];
  const preamble: string[] = [];
  let current: { clock?: string; role: LogRecord['role']; kind: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    records.push(current);
    current = null;
  };

  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const match = LOG_HEADER.exec(line);
    if (match !== null) {
      flush();
      current = {
        ...(match[1] === undefined ? {} : { clock: match[1] }),
        role: match[2] as LogRecord['role'],
        kind: match[3] ?? 'message',
        lines: [match[4] ?? ''],
      };
    } else if (current !== null) {
      current.lines.push(line.startsWith('    ') ? line.slice(4) : line);
    } else if (line !== '') {
      preamble.push(line);
    }
  }
  flush();

  const entries = projectRecords(records);
  if (preamble.length === 0) return entries;
  const raw = preamble.join('\n');
  return [
    {
      id: `log:preamble:${fieldHash(raw)}`,
      kind: 'notice',
      text: raw,
      label: 'Transcript',
    },
    ...entries,
  ];
};

type SessionWorkspaceReadApi = Pick<IFyApiClient, 'get' | 'logs'> & {
  /** The session's send ledger. Optional: a reader that does not show sends never asks. */
  readonly sends?: (id: string) => Promise<readonly SendRecord[]>;
};

export interface SessionWorkspaceRefreshEnvironment {
  readonly visible: () => boolean;
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly onVisibility: (callback: () => void) => () => void;
}

export interface SessionWorkspaceRefreshInput {
  readonly api: SessionWorkspaceReadApi;
  readonly sessionId: string;
  readonly intervalMs?: number;
  readonly environment: SessionWorkspaceRefreshEnvironment;
  readonly onTranscript: (entries: readonly TranscriptEntry[]) => void;
  readonly onSession: (view: SessionView) => void;
  /** Every refresh's send ledger, when the api reads one. A failed read keeps the previous rows. */
  readonly onSends?: (sends: readonly SendRecord[]) => void;
  readonly onError: (message: string | null) => void;
}

export interface SessionWorkspaceRefreshControl {
  readonly initial: Promise<void>;
  /** `afterCurrent` is for a write that needs evidence newer than any poll
   * already in flight. Timer/visibility reads leave it false and still
   * coalesce onto the current request. */
  readonly refresh: (afterCurrent?: boolean) => Promise<void>;
  readonly stop: () => void;
}

const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * Keeps one daemon/session workspace fresh without a watch loop in React.
 * Reads are skipped while the document is hidden, coalesced while in flight,
 * and fenced after teardown so a re-pair or route change cannot paint a late
 * answer into the next workspace.
 */
export const startSessionWorkspaceRefresh = (input: SessionWorkspaceRefreshInput): SessionWorkspaceRefreshControl => {
  let stopped = false;
  let inflight: Promise<void> | null = null;

  const refresh = (afterCurrent = false): Promise<void> => {
    if (stopped || !input.environment.visible()) return Promise.resolve();
    if (inflight !== null) return afterCurrent ? inflight.then(() => refresh()) : inflight;

    inflight = Promise.allSettled([
      input.api.logs(input.sessionId),
      input.api.get(input.sessionId),
      // A daemon that cannot answer the ledger still shows its transcript: the sends are an overlay.
      input.api.sends?.(input.sessionId) ?? Promise.resolve(undefined),
    ])
      .then(([logs, session, sends]) => {
        if (stopped) return;
        if (sends.status === 'fulfilled' && sends.value !== undefined) input.onSends?.(sends.value);
        const errors: string[] = [];
        if (logs.status === 'fulfilled') input.onTranscript(transcriptEntriesFromLog(logs.value));
        else errors.push(`Transcript: ${errorMessage(logs.reason)}`);

        if (session.status === 'fulfilled') {
          if (session.value.config.id === input.sessionId) input.onSession(session.value);
          else errors.push('Session: daemon returned another session');
        } else errors.push(`Session: ${errorMessage(session.reason)}`);
        input.onError(errors.length === 0 ? null : errors.join(' · '));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const interval = input.environment.setInterval(() => void refresh(), Math.max(1_000, input.intervalMs ?? 3_000));
  const stopVisibility = input.environment.onVisibility(() => void refresh());
  const initial = refresh();

  return {
    initial,
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      input.environment.clearInterval(interval);
      stopVisibility();
    },
  };
};

/**
 * A ledger row's Retry, bound to one session: re-sends under the send's ORIGINAL id — which the daemon
 * types again only when it proved the message absent, or when the reader chose "send again anyway"
 * on an unconfirmed one — then asks for fresh evidence so the row moves at once.
 */
export const sendRetrier =
  (
    client: Pick<IFyApiClient, 'retrySend'> | null,
    sessionId: string,
    refresh: () => void,
  ): ((record: { readonly sendId: string }, force: boolean) => Promise<boolean>) =>
  async (record, force) => {
    if (client === null) return false;
    await client.retrySend(sessionId, record.sendId, force);
    refresh();
    return true;
  };

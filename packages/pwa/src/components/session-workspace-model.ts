import type { IFyApiClient, SessionView } from '@ferretry/protocol';

import type { TranscriptEntry } from '../lib/session-screens.ts';
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

const entryFor = (record: LogRecord, index: number): TranscriptEntry => {
  const text = record.lines.join('\n');
  const signature = `${record.clock ?? ''}|${record.role}|${record.kind}|${text}`;
  return {
    id: `log:${index}:${fieldHash(signature)}`,
    kind: recordKind(record),
    text: text || title(record.kind),
    label: recordLabel(record),
  };
};

/**
 * Projects the daemon's proved, normalized `logs` tail into the already-ported
 * transcript component. The wire format is deliberately parsed rather than
 * guessed from harness JSON: `OperatorReadService.renderTranscript` is the
 * daemon-owned compatibility contract available today while the structured
 * chat-history route remains unported.
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

  const entries = records.map(entryFor);
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

type SessionWorkspaceReadApi = Pick<IFyApiClient, 'get' | 'logs'>;

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
  readonly onError: (message: string | null) => void;
}

export interface SessionWorkspaceRefreshControl {
  readonly initial: Promise<void>;
  readonly refresh: () => Promise<void>;
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

  const refresh = (): Promise<void> => {
    if (stopped || !input.environment.visible()) return Promise.resolve();
    if (inflight !== null) return inflight;

    inflight = Promise.allSettled([input.api.logs(input.sessionId), input.api.get(input.sessionId)])
      .then(([logs, session]) => {
        if (stopped) return;
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

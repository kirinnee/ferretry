import type { IFyApiClient, SendRecord, SessionView } from '@ferretry/protocol';

import type { TranscriptEntry } from '../lib/session-screens.ts';
import { parseSlashCommandText, type SlashCommand, withCommandOutput } from '../lib/slash-commands.ts';
import { readUserMessage } from '../lib/user-message.ts';
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

/** A tool call or its result — grouped into a run, never shown or hidden on its own. */
const isToolRecord = (record: LogRecord): boolean => record.kind === 'tool-call' || record.kind === 'tool-result';

/**
 * WHICH MACHINE RECORDS THE CONVERSATION LEAVES OUT. Reasoning, token usage, turn markers, settings
 * echoes and attachment stubs are bookkeeping, and the transcript shows none of them — there is no
 * "Show details" fold any more. An `error` is never bookkeeping: a failure that vanished would be a
 * bug, not tidiness.
 *
 * Dropping them HERE, before tool runs are grouped, is what keeps a run whole. Claude writes a usage
 * record after every assistant record, so a call and its result were always separated by one; a run
 * split there read as `2 tools · Bash, Edit` followed by `2 tools · result ×2`.
 */
const isHiddenRecord = (record: LogRecord): boolean =>
  !isToolRecord(record) && record.kind !== 'error' && recordKind(record) === 'notice';

const entryFor = (record: LogRecord, index: number): TranscriptEntry => {
  const text = record.lines.join('\n');
  const signature = `${record.clock ?? ''}|${record.role}|${record.kind}|${text}`;
  return {
    id: `log:${index}:${fieldHash(signature)}`,
    kind: recordKind(record),
    text: text || title(record.kind),
    label: recordLabel(record),
    ...(record.kind === 'error' ? { alert: true } : {}),
  };
};

/**
 * A person's message, another agent's, or Ferretry's own notice — the user channel carries all three.
 *
 * The id is taken from the record as written, so a row keeps its identity whatever this reading of it
 * decides. A peer or notice row is not labelled "You": who sent it is the row's own chrome, so its label
 * carries only the record's clock.
 */
const userEntryFor = (record: LogRecord, index: number): TranscriptEntry => {
  const entry = entryFor(record, index);
  const message = readUserMessage(entry.text);
  if (message.kind === 'human') return { ...entry, text: message.text };
  const clock = record.clock === undefined ? {} : { label: record.clock };
  return message.kind === 'notice'
    ? { id: entry.id, kind: 'system', text: message.text, ...clock }
    : { id: entry.id, kind: 'user', text: message.body, peer: message.from, ...clock };
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

const DAY_MS = 86_400_000;

/**
 * The instant a record's `HH:MM:SS` clock names, or nothing.
 *
 * The daemon prints only the UTC wall clock, so the date is inferred: the most recent such instant
 * not after `now`. That is exact for anything under a day old — which is every tool still running —
 * and a record with no clock gets no instant rather than a made-up one, because a wrong elapsed time
 * is worse than none.
 */
const recordInstant = (clock: string | undefined, now: number): string | undefined => {
  if (clock === undefined) return undefined;
  const [hours, minutes, seconds] = clock.split(':').map(Number) as [number, number, number];
  const today = new Date(now);
  const at = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours, minutes, seconds);
  return new Date(at > now ? at - DAY_MS : at).toISOString();
};

interface ToolRun {
  readonly index: number;
  readonly calls: {
    key: string;
    use: ToolUseData;
    result?: ToolResultData;
    ts?: string;
    orphanResult?: boolean;
  }[];
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

/** A slash command as one compact row: `/model opus[1m] → Set model to …`. */
const commandEntry = (id: string, command: SlashCommand): TranscriptEntry => ({
  id,
  kind: 'command',
  text: [command.name, command.args, command.output].filter(Boolean).join(' '),
  command,
});

const projectRecords = (records: readonly LogRecord[], now: number): readonly TranscriptEntry[] => {
  const entries: TranscriptEntry[] = [];
  let run: ToolRun | null = null;
  const flush = (): void => {
    if (run !== null) entries.push(toolEntry(run));
    run = null;
  };
  records.forEach((record, index) => {
    if (isHiddenRecord(record)) return;
    const text = record.lines.join('\n');
    if (isToolRecord(record)) {
      run ??= { index, calls: [] };
      const key = `log:${index}:${fieldHash(`${record.kind}|${text}`)}`;
      if (record.kind === 'tool-call') {
        const ts = recordInstant(record.clock, now);
        run.calls.push({ key, use: toolUse(text), ...(ts === undefined ? {} : { ts }) });
        return;
      }
      const waiting = run.calls.find(call => call.result === undefined && call.orphanResult !== true);
      if (waiting === undefined)
        run.calls.push({ key, use: { name: 'result' }, result: toolResult(text), orphanResult: true });
      else waiting.result = toolResult(text);
      return;
    }
    const command = recordKind(record) === 'user' ? parseSlashCommandText(text) : null;
    // The caveat is an instruction to the model, never something anybody said, so it is dropped
    // outright — and, like bookkeeping, it does not end a tool run.
    if (command?.kind === 'caveat') return;
    flush();
    const id = `log:${index}:${fieldHash(`${record.clock ?? ''}|${record.role}|${record.kind}|${text}`)}`;
    if (command?.kind === 'command') {
      entries.push(commandEntry(id, command.command));
      return;
    }
    if (command?.kind === 'output') {
      // Claude writes a command's output as its own record straight after the command. It joins
      // that row; output whose command fell outside the loaded window still gets a row of its own.
      const last = entries.at(-1);
      if (last?.command !== undefined && last.command.output === undefined && last.command.tone === 'ok') {
        entries[entries.length - 1] = commandEntry(last.id, withCommandOutput(last.command, command));
        return;
      }
      entries.push(commandEntry(id, withCommandOutput({ name: '', tone: 'ok' }, command)));
      return;
    }
    entries.push(recordKind(record) === 'user' ? userEntryFor(record, index) : entryFor(record, index));
  });
  flush();
  return entries;
};

/**
 * Projects the daemon's proved, normalized `logs` tail into the already-ported
 * transcript component. The wire format is deliberately parsed rather than
 * guessed from harness JSON: `OperatorReadService.renderTranscript` is the
 * compatibility contract this first workspace slice consumes. The daemon's
 * paged event route is mounted, but structured history/live-event projection
 * remains an explicit integration gap.
 *
 * Text before the first record header is not a record at all; like every other piece of daemon
 * bookkeeping it is left out of the conversation. `now` dates the records' wall clocks.
 */
export const transcriptEntriesFromLog = (text: string, now: number = Date.now()): readonly TranscriptEntry[] => {
  if (text.trim() === '') return [];
  const records: LogRecord[] = [];
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
    }
  }
  flush();

  return projectRecords(records, now);
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
  /**
   * Failures somebody else already says — a lost carrier, which the connection model reports once and
   * retries on its own. A quiet failure neither sets the message nor clears it, and leaves the last good
   * transcript where it is: the screen goes stale, not blank. Absent means every failure is said here.
   */
  readonly quiet?: (reason: unknown) => boolean;
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
        const quiet = input.quiet ?? (() => false);
        let silenced = false;
        if (logs.status === 'fulfilled') input.onTranscript(transcriptEntriesFromLog(logs.value));
        else if (quiet(logs.reason)) silenced = true;
        else errors.push(`Transcript: ${errorMessage(logs.reason)}`);

        if (session.status === 'fulfilled') {
          if (session.value.config.id === input.sessionId) input.onSession(session.value);
          else errors.push('Session: daemon returned another session');
        } else if (quiet(session.reason)) silenced = true;
        else errors.push(`Session: ${errorMessage(session.reason)}`);
        // Nothing to say but an outage said elsewhere: the message stays exactly as it was.
        if (errors.length === 0 && silenced) return;
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

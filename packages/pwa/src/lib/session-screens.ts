import type { SessionStatus } from '@ferretry/protocol';
import type { LedgerBlockPlacement } from './ledger-placement.ts';
import type { LedgerSendRecord } from './send-ledger.ts';
import type { ToolResultData, ToolUseData } from './tool-extract.ts';

/**
 * One tool invocation as the transcript shows it: the use, its result when one
 * came back, and the key that keeps a live run's rows stable.
 *
 * A result whose `use` never arrived is not dropped — it is marked
 * `orphanResult` and still shown, because a run that silently loses a row reads
 * as a tool that never ran.
 */
export interface ToolCall {
  readonly key: string;
  readonly use: ToolUseData;
  readonly result?: ToolResultData;
  /** ISO instant the call started; drives the running tool's elapsed label. */
  readonly ts?: string;
  readonly orphanResult?: boolean;
}

/** A browser-safe, display-only transcript row. Content remains daemon-owned. */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'notice' | 'ledger';
  readonly text: string;
  readonly at?: number;
  readonly label?: string;
  /** Consecutive tool calls this row stands for. A `tool` row carrying calls
   *  renders as the collapsed tool group instead of a text line. */
  readonly tools?: readonly ToolCall[];
  /** The durable send attempt a `ledger` row stands for — an attempt the loaded
   *  transcript carries no proof row for, shown so it cannot go quiet. */
  readonly ledger?: LedgerSendRecord;
  /** Where that attempt sits relative to the loaded transcript. */
  readonly placement?: LedgerBlockPlacement;
  /**
   * Bookkeeping — reasoning, token usage, turn and settings records. Kept, but folded behind
   * "Show details" so the conversation reads as a conversation.
   */
  readonly detail?: boolean;
}

/** One rendered transcript item: a row, or a folded run of consecutive detail rows. */
export type TranscriptItem =
  | { readonly kind: 'entry'; readonly entry: TranscriptEntry; readonly previous?: TranscriptEntry }
  | { readonly kind: 'details'; readonly id: string; readonly entries: readonly TranscriptEntry[] };

/**
 * Folds every run of consecutive detail rows into one item, keeping order. A run is keyed by its first
 * row, so expanding one stays expanded while the tail of the transcript grows underneath it. `previous`
 * is the last VISIBLE row before an entry, which is what the transcript's rhythm reads.
 */
export const transcriptItems = (entries: readonly TranscriptEntry[]): readonly TranscriptItem[] => {
  const items: TranscriptItem[] = [];
  let previous: TranscriptEntry | undefined;
  let run: TranscriptEntry[] | null = null;
  for (const entry of entries) {
    if (entry.detail === true) {
      if (run === null) {
        run = [];
        items.push({ kind: 'details', id: `details:${entry.id}`, entries: run });
      }
      run.push(entry);
      continue;
    }
    run = null;
    items.push(previous === undefined ? { kind: 'entry', entry } : { kind: 'entry', entry, previous });
    previous = entry;
  }
  return items;
};

/** "2 system events" — the fold's own count, in words. */
export const detailsLabel = (count: number): string => `${count} system ${count === 1 ? 'event' : 'events'}`;

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'stopped';

/** A status in words, for every surface that shows one: `rate_limited` reads "rate limited". */
export const sessionStatusLabel = (status: SessionStatus | string): string => status.replaceAll('_', ' ');

export const relativeTime = (at: number | string | undefined, now = Date.now()): string => {
  if (!at) return '—';
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * An exact local timestamp, `yyyy-MM-dd HH:mm:ss`.
 *
 * A send-ledger row is evidence about when something was accepted, so it shows
 * the instant rather than a relative phrase that ages while you read it. An
 * unparseable value is shown verbatim instead of being replaced by a dash: it
 * is data the daemon sent, and hiding it would hide the skew that produced it.
 */
export const absoluteTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

export const sessionNavigation = (daemonId: string, sessionId: string): readonly [string, string] => [
  daemonId,
  sessionId,
];

export const transcriptIsFollowing = (element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean => element.scrollHeight - element.clientHeight - element.scrollTop <= 24;

export const composerUsesEnterToSend = (pointerFine: boolean, canHover: boolean): boolean => pointerFine && canHover;

export const canSubmitComposer = (draft: string, disabled: boolean, sending: boolean): boolean =>
  draft.trim().length > 0 && !disabled && !sending;

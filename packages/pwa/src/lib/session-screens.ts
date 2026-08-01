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
}

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'stopped';

export const sessionStatusLabel = (status: SessionStatus): string => status.replaceAll('_', ' ');

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

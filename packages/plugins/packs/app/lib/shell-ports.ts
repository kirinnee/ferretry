/**
 * What the packs app needs from files that live with another owner's app half, kept as the smallest local copy of each
 * (never the whole file) until that owner publishes them through a contract (PENDING.md).
 */

import type { PackCall } from './pack-calls.ts';

// ─── GAP(conversation): the transcript's row types and the tool-call shapes are Conversation's ─────────────────────

/** A tool invocation as the transcript shows it: the use, and its result when one came back. */
export interface ToolCall {
  readonly key: string;
  readonly use: { readonly toolUseId?: string; readonly name?: string; readonly input?: unknown; readonly id?: string };
  readonly result?: {
    readonly toolUseId?: string;
    readonly content?: unknown;
    readonly text?: string;
    readonly isError?: boolean;
  };
  readonly ts?: string;
  readonly orphanResult?: boolean;
}

/** One transcript row, as far as Pack mode reads or adds to it. */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system' | 'ledger';
  readonly text: string;
  readonly at?: number;
  readonly tools?: readonly ToolCall[];
  /** The send a `tool` row stands for (Conversation's); a row that is one is not a Pack card. */
  readonly sent?: unknown;
  /** The Pack command a `tool` row stands for, once `projectPackCalls` has read it. */
  readonly pack?: PackCall;
}

// ─── GAP(app-shell): small formatters the shell owns ───────────────────────────────────────────────────────────────

const pad = (value: number): string => String(value).padStart(2, '0');

/** An instant as the reader's local time, to the second; an unparseable value is shown verbatim. */
export const absoluteTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

export const formatElapsedSeconds = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}m`;
};

/** A ferret's state word in a sentence: `rate_limited` reads "rate limited". */
export const stateLabel = (state: string): string => state.replaceAll('_', ' ');

/** The reader's local clock for an instant, as a message footer shows it; `undefined` for one that does not parse. */
export interface MessageClock {
  readonly short: string;
  readonly full: string;
}
export const clockOfInstant = (at: number | string | undefined): MessageClock | undefined => {
  if (at === undefined) return undefined;
  const date = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(date.getTime())) return undefined;
  return {
    short: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date),
    full: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date),
  };
};

/** Where a ferret's own page is in the app (the shell's route for a ferret). */
export const ferretHref = (ferretId: string): string => `/ferret/${encodeURIComponent(ferretId)}`;

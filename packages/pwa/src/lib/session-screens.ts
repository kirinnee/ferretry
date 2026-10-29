import type { HandoffPointer, SessionStatus, TranscriptImageMarker } from '@ferretry/protocol';
import type { LedgerBlockPlacement } from './ledger-placement.ts';
import type { PackCall } from './pack-calls.ts';
import type { SentMessage } from './peer-delivery.ts';
import type { PeerFrom } from './peer-message.ts';
import type { LedgerSendRecord } from './send-ledger.ts';
import type { SlashCommand } from './slash-commands.ts';
import type { SystemBlockInfo } from './system-blocks.ts';
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

/**
 * How a terminal send (cancelled, or given up on) is drawn: `fresh` is the whole bubble just after it
 * settled, `slim` the one-line note it folds to, `expanded` the whole bubble because the reader opened it.
 */
export type SettledForm = 'fresh' | 'slim' | 'expanded';

/** A browser-safe, display-only transcript row. Content remains daemon-owned. */
export interface TranscriptEntry {
  readonly id: string;
  /** `system` is Ferretry speaking INTO the session (a send that did not arrive), or — with `event` — the
   *  harness's own event typed into the user channel; `notice` is daemon bookkeeping, shown only as an alert. */
  readonly kind: 'user' | 'assistant' | 'tool' | 'command' | 'notice' | 'system' | 'ledger';
  readonly text: string;
  readonly at?: number;
  readonly label?: string;
  /** Consecutive tool calls this row stands for. A `tool` row carrying calls
   *  renders as the collapsed tool group instead of a text line. */
  readonly tools?: readonly ToolCall[];
  /** The slash command a `command` row stands for: `/model opus[1m] → Set model to …`. */
  readonly command?: SlashCommand;
  /** The durable send attempt a `ledger` row stands for — an attempt the loaded
   *  transcript carries no proof row for, shown so it cannot go quiet. */
  readonly ledger?: LedgerSendRecord;
  /** Where that attempt sits relative to the loaded transcript. */
  readonly placement?: LedgerBlockPlacement;
  /** Present on a `ledger` row whose send is terminal: it sits in the timeline at its send time, not under it. */
  readonly settled?: SettledForm;
  /** The delivered send a `user` row IS, so the row can wear its chip. */
  readonly send?: LedgerSendRecord;
  /** The agent a `user` row came from, when another session sent it rather than the person. */
  readonly peer?: PeerFrom;
  /** The hand-off document a `user` row points at: the person's message is in that file, and `text`
   *  is only the pointer the agent was typed. */
  readonly handoff?: HandoffPointer;
  /** The message a ferret SENT, when this row is the `send` it ran rather than an ordinary tool group. */
  readonly sent?: SentMessage;
  /** The Pack command (`new`, `wait`, `recommend`) a ferret ran, when this row is that rather than an ordinary
   *  tool group (`pack-calls.ts`). */
  readonly pack?: PackCall;
  /** The harness event a `system` row stands for: a background task finishing, an interrupt, a reminder.
   *  It arrived as a user record, but nobody typed it, so it is never the reader's own message. */
  readonly event?: SystemBlockInfo;
  /** The images this row shows — a pasted screenshot or a generated picture the log named by marker. A row
   *  with images and no `text` is the picture alone. */
  readonly images?: readonly TranscriptImageMarker[];
  /** A failure the reader must see. A notice without it is daemon bookkeeping and is never shown. */
  readonly alert?: boolean;
}

/**
 * Is this row left out of the conversation? Every daemon notice except an alert is — "Browser
 * automation stays unavailable" is context, not conversation, and the transcript no longer keeps a
 * "Show details" fold to file it under.
 */
export const hiddenFromTranscript = (entry: TranscriptEntry): boolean =>
  entry.kind === 'notice' && entry.alert !== true;

/** One rendered transcript row and the last VISIBLE row before it, which is what its rhythm reads. */
export interface TranscriptItem {
  readonly entry: TranscriptEntry;
  readonly previous?: TranscriptEntry;
  /** An assistant row comes after this one: the agent has handled the turn this message was in. */
  readonly answered?: true;
}

/** The rows a reader sees, in order, each paired with the visible row before it. */
export const transcriptItems = (entries: readonly TranscriptEntry[]): readonly TranscriptItem[] => {
  const items: TranscriptItem[] = [];
  let previous: TranscriptEntry | undefined;
  for (const entry of entries) {
    if (hiddenFromTranscript(entry)) continue;
    items.push(previous === undefined ? { entry } : { entry, previous });
    previous = entry;
  }
  // Every row before the LAST assistant reply has been answered by it or by an earlier one.
  const lastReply = items.findLastIndex(item => item.entry.kind === 'assistant');
  return items.map((item, index) => (index < lastReply ? { ...item, answered: true } : item));
};

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

export const composerUsesEnterToSend = (pointerFine: boolean, canHover: boolean): boolean => pointerFine && canHover;

export const canSubmitComposer = (draft: string, disabled: boolean, sending: boolean): boolean =>
  draft.trim().length > 0 && !disabled && !sending;

/** A pause this long between two assistant messages starts a new run, so the name returns after it. */
export const RUN_GAP_MS = 10 * 60 * 1000;

/** Where an assistant text row sits in its run: the first one names the agent, the rest do not. */
export interface AgentRunMark {
  readonly role: 'start' | 'continue';
  /** The last text of its run, which is the one that carries the run's time. */
  readonly end: boolean;
}

/**
 * Group consecutive assistant output into runs, one mark per assistant text row (`undefined` for every
 * other row). Tool rows fold into the run they sit in without opening or closing it; anything else —
 * the reader's message, a peer, a system row, a command, a send-ledger row, a message this ferret sent,
 * a sub-ferret card — closes it, and so does a gap past `RUN_GAP_MS` between two assistant texts.
 */
export const agentRuns = (items: readonly TranscriptItem[]): readonly (AgentRunMark | undefined)[] => {
  const marks: ({ role: AgentRunMark['role']; end: boolean } | undefined)[] = [];
  let open: number | undefined;
  let lastAt: number | undefined;
  for (const { entry } of items) {
    if (entry.kind === 'assistant' && entry.sent === undefined && entry.pack === undefined) {
      const gapped = lastAt !== undefined && entry.at !== undefined && entry.at - lastAt > RUN_GAP_MS;
      const previousMark = open === undefined || gapped ? undefined : marks[open];
      if (previousMark !== undefined) previousMark.end = false;
      marks.push({ role: previousMark === undefined ? 'start' : 'continue', end: true });
      open = marks.length - 1;
      lastAt = entry.at ?? lastAt;
      continue;
    }
    marks.push(undefined);
    if (entry.kind === 'tool' && entry.sent === undefined && entry.pack === undefined) continue;
    open = undefined;
    lastAt = undefined;
  }
  return marks;
};

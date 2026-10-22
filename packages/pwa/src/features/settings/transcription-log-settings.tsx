/**
 * Settings › This device › Transcription log.
 *
 * Every dictation this device made, so words are never lost to a mis-tap: search the list, copy from
 * it, put an entry back in the composer, clear it, or switch recording off. Kept in this browser only
 * (`lib/stt/transcription-log.ts`); no audio, never synced, never sent to a machine.
 *
 * "Insert again" asks a composer for the words (`lib/stt/reinsert-transcription.ts`). When no
 * composer takes them — no conversation is open — they are copied instead and the row says so.
 */

import { Bug, Clipboard, CornerDownLeft, Search, Trash2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { DictationDebugSheet } from '../../components/dictation-debug-sheet.tsx';
import { DictationTimelineBar, TimingSummary } from '../../components/dictation-timeline-bar.tsx';
import { useDictationDebug, useTranscriptionLog } from '../../lib/store.tsx';
import type { DictationDebugLog } from '../../lib/stt/dictation-debug.ts';
import { requestReinsert } from '../../lib/stt/reinsert-transcription.ts';
import {
  searchTranscriptionLog,
  TRANSCRIPTION_ENGINE_LABELS,
  type TranscriptionEntry,
  type TranscriptionLog,
  type TranscriptionLogSnapshot,
} from '../../lib/stt/transcription-log.ts';
import { callDuration, callTime, PanelSwitch, useDebugSnapshot } from './dictation-debug-settings.tsx';

/** How many matches show before "Show more". */
export const TRANSCRIPTION_LOG_PAGE = 50;

const TRANSCRIPTION_LOG_INTRO =
  'Every dictation this device made, so your words are never lost to a mis-tap or a discard. Search it, copy from it, or put one back in the composer.';

const TRANSCRIPTION_LOG_PRIVACY =
  'Kept in this browser only: never synced and never sent to any machine. No audio is stored, only the words. It holds the newest 200 dictations from the last 30 days.';

export const TRANSCRIPTION_LOG_UNSAVED =
  'This browser would not save the log, so it is kept for this tab only and is gone when you close it.';

export const TRANSCRIPTION_LOG_EMPTY = 'Nothing here yet. Dictate something and it will be kept here.';

export const TRANSCRIPTION_LOG_NO_MATCH = 'Nothing matches that search.';

const OUTCOME_LABELS: Readonly<Record<TranscriptionEntry['outcome'], string>> = {
  pending: 'Not decided',
  inserted: 'Inserted',
  discarded: 'Discarded',
};

const PROMPT_LABELS: Readonly<Record<NonNullable<TranscriptionEntry['prompt']>, string>> = {
  fix: 'Fix',
  polish: 'Polish',
};

const NOTHING_KEPT: TranscriptionLogSnapshot = Object.freeze({ enabled: false, entries: [], saved: false });
const nothingKept = (): TranscriptionLogSnapshot => NOTHING_KEPT;
const noSubscription = (): (() => void) => () => undefined;

/** What the owner ended up with: the words they edited in, else the cleaned text, else the raw. */
export const textOf = (entry: TranscriptionEntry): string => entry.inserted ?? entry.cleaned ?? entry.raw;

const copyToClipboard = async (text: string): Promise<void> => {
  await globalThis.navigator.clipboard.writeText(text);
};

const reinsertByEvent = (entry: TranscriptionEntry): boolean =>
  requestReinsert(globalThis, { sessionId: entry.sessionId, text: textOf(entry) });

type RowNote = 'copied' | 'copied-instead' | 'copy-failed';

const NOTE_TEXT: Readonly<Record<RowNote, string>> = {
  copied: 'Copied.',
  'copied-instead': 'No conversation is open — copied instead.',
  'copy-failed': 'This browser would not let the words be copied.',
};

export interface TranscriptionLogSettingsProps {
  /** This device's log; the app store's when omitted. `null` keeps nothing. */
  readonly log?: TranscriptionLog | null;
  /** The debug ring, for "Debug details" links; the app store's when omitted. */
  readonly debug?: DictationDebugLog | null;
  /** Put an entry back in a composer; true when one took it. */
  readonly onReinsert?: (entry: TranscriptionEntry) => boolean;
  /** Copy text to the clipboard; rejects when the browser refuses. */
  readonly copy?: (text: string) => Promise<void>;
}

export function TranscriptionLogSettings({
  log: injectedLog,
  debug: injectedDebug,
  onReinsert = reinsertByEvent,
  copy = copyToClipboard,
}: TranscriptionLogSettingsProps) {
  const ambientLog = useTranscriptionLog();
  const ambientDebug = useDictationDebug();
  const log = injectedLog === undefined ? ambientLog : injectedLog;
  const snapshot = useSyncExternalStore(log?.subscribe ?? noSubscription, log?.snapshot ?? nothingKept, nothingKept);
  const ring = useDebugSnapshot(injectedDebug === undefined ? ambientDebug : injectedDebug);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(TRANSCRIPTION_LOG_PAGE);
  const [note, setNote] = useState<{ readonly id: string; readonly kind: RowNote } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const matches = searchTranscriptionLog(snapshot.entries, query);
  const shown = matches.slice(0, limit);
  const open = ring.records.find(record => record.id === openId);

  const copyText = async (id: string, text: string) => {
    try {
      await copy(text);
      setNote({ id, kind: 'copied' });
    } catch {
      setNote({ id, kind: 'copy-failed' });
    }
  };

  const reinsert = async (entry: TranscriptionEntry) => {
    if (onReinsert(entry)) {
      setNote(null);
      return;
    }
    try {
      await copy(textOf(entry));
      setNote({ id: entry.id, kind: 'copied-instead' });
    } catch {
      setNote({ id: entry.id, kind: 'copy-failed' });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="transcription-log-settings">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-cell leading-base text-fg">{TRANSCRIPTION_LOG_INTRO}</p>
        <p className="m-0 text-meta leading-base text-muted">{TRANSCRIPTION_LOG_PRIVACY}</p>
      </div>
      <PanelSwitch
        checked={snapshot.enabled}
        label="Transcription log"
        detail={snapshot.enabled ? 'On: each dictation is kept on this device.' : 'Off: new dictations are not kept.'}
        onChange={next => log?.setEnabled(next)}
      />
      {!snapshot.saved && (
        <p role="status" className="m-0 text-meta leading-base text-warn" data-log-unsaved="">
          {TRANSCRIPTION_LOG_UNSAVED}
        </p>
      )}

      <TimingSummary entries={snapshot.entries} />

      <section className="flex min-w-0 flex-col gap-2" aria-label="Kept dictations">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search the transcription log</span>
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-3.5 text-muted" />
            <input
              type="search"
              className="kt-input min-h-[44px] w-full min-w-0 rounded-control border border-border bg-surface-2 pl-7 pr-2 text-fg"
              placeholder="Search words, conversation, engine"
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setLimit(TRANSCRIPTION_LOG_PAGE);
              }}
            />
          </label>
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={snapshot.entries.length === 0}
            onClick={() => log?.clear()}
          >
            <Trash2 size={14} aria-hidden="true" /> Clear log
          </button>
        </div>

        {snapshot.entries.length === 0 ? (
          <p className="m-0 text-meta leading-base text-faint" data-log-empty="">
            {TRANSCRIPTION_LOG_EMPTY}
          </p>
        ) : matches.length === 0 ? (
          <p className="m-0 text-meta leading-base text-faint" data-log-empty="">
            {TRANSCRIPTION_LOG_NO_MATCH}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {shown.map(entry => (
              <li key={entry.id}>
                <EntryCard
                  entry={entry}
                  note={note?.id === entry.id ? note.kind : undefined}
                  hasDebug={entry.debugId !== undefined && ring.records.some(record => record.id === entry.debugId)}
                  onCopy={text => void copyText(entry.id, text)}
                  onReinsert={() => void reinsert(entry)}
                  onDebug={() => setOpenId(entry.debugId ?? null)}
                />
              </li>
            ))}
          </ul>
        )}
        {matches.length > shown.length && (
          <button
            type="button"
            className="kt-btn min-h-[44px] self-start"
            onClick={() => setLimit(limit + TRANSCRIPTION_LOG_PAGE)}
          >
            Show more ({String(matches.length - shown.length)} left)
          </button>
        )}
      </section>

      {open !== undefined && <DictationDebugSheet record={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

interface EntryCardProps {
  readonly entry: TranscriptionEntry;
  readonly note: RowNote | undefined;
  readonly hasDebug: boolean;
  readonly onCopy: (text: string) => void;
  readonly onReinsert: () => void;
  readonly onDebug: () => void;
}

function EntryCard({ entry, note, hasDebug, onCopy, onReinsert, onDebug }: EntryCardProps) {
  const kept = textOf(entry);
  const facts = [
    callTime(entry.at),
    entry.sessionLabel,
    TRANSCRIPTION_ENGINE_LABELS[entry.engine],
    entry.durationMs === undefined ? undefined : callDuration(entry.durationMs),
    entry.prompt === undefined ? undefined : `${PROMPT_LABELS[entry.prompt]} prompt`,
    OUTCOME_LABELS[entry.outcome],
  ].filter((fact): fact is string => fact !== undefined);

  return (
    <article className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-log-entry={entry.id}>
      <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">{facts.join(' · ')}</p>
      <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell leading-base text-fg">
        <span className="font-semibold">Heard: </span>
        {entry.raw}
      </p>
      {entry.timeline !== undefined && <DictationTimelineBar timeline={entry.timeline} compact />}
      {entry.cleaned !== undefined && (
        <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell leading-base text-fg">
          <span className="font-semibold">Cleaned: </span>
          {entry.cleaned}
        </p>
      )}
      {entry.inserted !== undefined && (
        <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-cell leading-base text-fg">
          <span className="font-semibold">You inserted: </span>
          {entry.inserted}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="kt-btn min-h-[44px]" onClick={() => onCopy(kept)}>
          <Clipboard size={14} aria-hidden="true" /> Copy
        </button>
        {kept !== entry.raw && (
          <button type="button" className="kt-btn min-h-[44px]" onClick={() => onCopy(entry.raw)}>
            <Clipboard size={14} aria-hidden="true" /> Copy raw
          </button>
        )}
        <button type="button" className="kt-btn min-h-[44px]" onClick={onReinsert}>
          <CornerDownLeft size={14} aria-hidden="true" /> Insert again
        </button>
        {hasDebug && (
          <button type="button" className="kt-btn min-h-[44px]" onClick={onDebug}>
            <Bug size={14} aria-hidden="true" /> Debug details
          </button>
        )}
      </div>
      {note !== undefined && (
        <p
          role="status"
          className={
            note === 'copy-failed' ? 'm-0 text-meta leading-base text-warn' : 'm-0 text-meta leading-base text-ok'
          }
          data-log-note={note}
        >
          {NOTE_TEXT[note]}
        </p>
      )}
    </article>
  );
}

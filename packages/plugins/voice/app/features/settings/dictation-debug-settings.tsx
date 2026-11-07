/**
 * Settings › This device › Dictation debug.
 *
 * An opt-in switch (off by default) for the person who wants to see what a clean-up call sent and
 * got back. While it is on, this tab keeps the last ten calls IN MEMORY (`lib/stt/dictation-debug.ts`)
 * and lists them here as "Recent calls"; a call opens the Details sheet. Nothing is saved, synced or
 * sent to a machine, and the key is never in a record.
 *
 * The switch and the list read the app store's `DictationDebugLog`; a log can be injected instead
 * (`null` renders the panel with nothing kept).
 */

import type { CleanupTrace } from '../../../contract/index.ts';
import { Bug, Trash2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { DictationDebugSheet } from '../../components/dictation-debug-sheet.tsx';
import { timingDuration } from '../../components/dictation-timeline-bar.tsx';
import { cn } from '../../shell-voice.ts';
import { clockOfInstant } from '../../lib/message-clock.ts';
import { useDictationDebug } from '../../lib/voice-store.tsx';
import type { DictationDebugLog, DictationDebugRecord, DictationDebugSnapshot } from '../../lib/stt/dictation-debug.ts';
import { SettingRow, SettingSwitch } from './setting-row.tsx';

const DICTATION_DEBUG_INTRO =
  'Show what a dictation clean-up call sent and what came back: the prompt, the provider’s raw reply and the checks that ran. Off by default.';

const DICTATION_DEBUG_PRIVACY =
  'While on, this tab keeps the last 10 calls in memory only. They are never saved, synced or sent to any machine, they disappear when you reload or switch this off, and your key is never part of one. A record does hold the words you dictated and a little conversation around them.';

/** Said while the log is off and empty, where the call list is not shown. */
const DICTATION_DEBUG_OFF_HINT = 'Switch it on, then dictate: each clean-up call will be listed here.';

export const DICTATION_DEBUG_EMPTY = 'No calls yet. Dictate something and its clean-up call will appear here.';

const NOTHING_KEPT: DictationDebugSnapshot = Object.freeze({ enabled: false, records: [] });
const nothingKept = (): DictationDebugSnapshot => NOTHING_KEPT;
const noSubscription = (): (() => void) => () => undefined;

/** The snapshot of an injected-or-ambient debug log; `null` is a log that keeps nothing. */
export function useDebugSnapshot(log: DictationDebugLog | null): DictationDebugSnapshot {
  return useSyncExternalStore(log?.subscribe ?? noSubscription, log?.snapshot ?? nothingKept, nothingKept);
}

export const callDuration = timingDuration;

const OUTCOME_LABELS: Readonly<Record<CleanupTrace['outcome'], string>> = {
  cleaned: 'Cleaned',
  kept_raw: 'Kept your words',
  failed: 'Failed',
};

const OUTCOME_TONES: Readonly<Record<CleanupTrace['outcome'], string>> = {
  cleaned: 'text-ok',
  kept_raw: 'text-muted',
  failed: 'text-err',
};

/** When a call happened, on the reader's own clock. */
export const callTime = (at: number): string => clockOfInstant(at)?.full ?? 'Unknown time';

export interface DictationDebugSettingsProps {
  /** This device's debug log; the app store's when omitted. `null` keeps nothing. */
  readonly log?: DictationDebugLog | null;
}

export function DictationDebugSettings({ log: injected }: DictationDebugSettingsProps) {
  const ambient = useDictationDebug();
  const log = injected === undefined ? ambient : injected;
  const snapshot = useDebugSnapshot(log);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = snapshot.records.find(record => record.id === openId);

  const showCalls = snapshot.enabled || snapshot.records.length > 0;

  return (
    <SettingRow
      settingId="dictation-debug"
      name="Dictation debug"
      hint={snapshot.enabled ? 'On: this tab is keeping recent calls' : 'Off: nothing is kept'}
      explanation={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0">{DICTATION_DEBUG_INTRO}</p>
          <p className="m-0">{DICTATION_DEBUG_PRIVACY}</p>
          {showCalls ? null : <p className="m-0">{DICTATION_DEBUG_OFF_HINT}</p>}
        </div>
      }
      control={labelId => (
        <SettingSwitch checked={snapshot.enabled} labelledBy={labelId} onChange={next => log?.setEnabled(next)} />
      )}
    >
      {showCalls ? (
        <section
          className="flex min-w-0 flex-col gap-2 px-panel pb-3"
          aria-label="Recent calls"
          data-testid="dictation-debug-settings"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-row font-semibold text-fg">Recent calls</h3>
            <button
              type="button"
              className="kt-btn min-h-[44px]"
              disabled={snapshot.records.length === 0}
              onClick={() => log?.clear()}
            >
              <Trash2 size={14} aria-hidden="true" /> Clear calls
            </button>
          </div>
          {snapshot.records.length === 0 ? (
            <p className="m-0 text-meta leading-base text-faint" data-debug-empty="">
              {DICTATION_DEBUG_EMPTY}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {snapshot.records.map(record => (
                <li key={record.id}>
                  <CallRow record={record} onOpen={() => setOpenId(record.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {open !== undefined && <DictationDebugSheet record={open} onClose={() => setOpenId(null)} />}
    </SettingRow>
  );
}

function CallRow({ record, onOpen }: { readonly record: DictationDebugRecord; readonly onOpen: () => void }) {
  const { trace } = record;
  const when = callTime(record.at);
  return (
    <button
      type="button"
      className="flex min-h-[44px] w-full min-w-0 flex-col gap-0.5 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left hover:border-accent"
      aria-label={`Open the details of the call at ${when}`}
      data-debug-call={record.id}
      onClick={onOpen}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-ui font-semibold text-fg">
        <Bug size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <span className="min-w-0 break-all">
          {trace.provider} · {trace.model}
        </span>
        <span className={cn('text-meta font-medium', OUTCOME_TONES[trace.outcome])}>
          {OUTCOME_LABELS[trace.outcome]}
        </span>
      </span>
      <span className="min-w-0 break-all text-meta leading-base text-muted">
        {when} · {callDuration(trace.totalMs)} · {trace.via === 'device' ? 'this browser' : 'a machine'} → {trace.host}
      </span>
    </button>
  );
}

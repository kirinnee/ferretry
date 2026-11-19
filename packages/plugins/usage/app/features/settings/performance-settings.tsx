/**
 * SETTINGS › PERFORMANCE: what this machine and this app spend their time on, in one report a
 * person can send to whoever is looking into "it's slow".
 *
 * ONE BUTTON RECORDS BOTH HALVES. "Record 30 s" starts the daemon's own profile (`/v1/diagnostics/
 * profile`) and, from the same instant, reads this browser's recorder (`lib/performance/`) over the
 * same seconds. The two answer different questions — what the machine did, and what this app asked it
 * for and how long the answers took — and the slowness a person feels is usually one of them.
 *
 * NOTHING IS LOST TO A FLAKY CONNECTION. The daemon's window runs on the daemon; this page only starts it
 * and reads it back after it has closed. A relay that drops mid-window costs a re-read, not the window.
 * The browser's recorder keeps the last hour regardless, so recording here never clears what
 * `fyPerformanceReport()` would print.
 *
 * A REFUSAL IS SAID. The route is for devices with operator access, because the report describes the
 * machine (which programs it runs, how its fleet is shaped). A device without it is told so, with the
 * daemon's own sentence and the place that always works — `fy daemon profile` on the machine itself.
 *
 * WHAT IS SHOWN is what is copied: the broken budgets first, as a list a person can read at a glance,
 * then each report as the text Copy report puts on the clipboard. "Download JSON" saves both documents
 * as one `{ daemon, pwa }` file.
 */

import { SettingGroup, SettingRow } from '@ferretry/app';
import { Badge, Button } from '@ferretry/app/ui';
import {
  PERFORMANCE_PROFILE_DEFAULT_SECONDS,
  type PerformanceReport,
  renderPerformanceReport,
} from '../../../contract/index.ts';
import { Activity, CircleAlert, Copy, Download } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PerformanceRecorder } from '../../lib/performance/recorder.ts';
import { renderPwaPerformanceReport } from '../../lib/performance/report-text.ts';
import { browserClock, type DaemonConnection } from '../../shell.ts';
import { type PerformanceClient, readDaemonProfile, startDaemonProfile } from './performance-api.ts';
import {
  brokenBudgets,
  budgetWords,
  type PerformanceRecording,
  PROFILE_REFUSED_INTRO,
  PROFILE_REFUSED_REMEDY,
  PROFILE_TOO_SLOW_SENTENCE,
  PWA_REPORT_UNAVAILABLE,
  percentDone,
  performanceFileName,
  performanceReportJson,
  performanceReportText,
  profileFailure,
  secondsLeft,
} from './performance-model.ts';

/** Puts text on the clipboard. */
export type ClipboardWriter = (text: string) => Promise<void>;

/** The real clipboard, which rejects rather than pretending on a browser that has none. */
const browserClipboardWriter =
  (): ClipboardWriter =>
  async (text: string): Promise<void> => {
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (value: string) => Promise<void> } })
      ?.clipboard;
    if (typeof clipboard?.writeText !== 'function') {
      throw new Error('this browser will not give the page clipboard access');
    }
    await clipboard.writeText(text);
  };

/** Hands a finished file to the person. */
export type SaveText = (fileName: string, text: string) => void;

/** The browser's own download: an object URL on a link that is clicked once, then let go. */
export const downloadText: SaveText = (fileName, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

/** A one-shot timer, answering how to cancel it; injected so a suite drives the window by hand. */
export type PerformanceTimer = (callback: () => void, milliseconds: number) => () => void;

const browserTimer: PerformanceTimer = (callback, milliseconds) => browserClock.after(callback, milliseconds);

/** How often the countdown moves, and how often a report not yet written is asked for again. */
const TICK_MS = 1_000;
/** How long past the window's end the panel keeps asking before it says the machine was too slow. */
const READ_GRACE_MS = 30_000;

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'recording'; readonly totalMs: number }
  | { readonly kind: 'reading' }
  | { readonly kind: 'done'; readonly recording: PerformanceRecording }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

type CopyState = 'idle' | 'copied' | 'failed';

export interface PerformanceSettingsProps {
  readonly connection: DaemonConnection;
  /** This daemon's client, which the profile is started and read through. */
  readonly client: PerformanceClient;
  /** This browser's recorder; without one the report says this browser's half was not recorded. */
  readonly recorder: PerformanceRecorder | undefined;
  readonly seconds?: number;
  readonly write?: ClipboardWriter;
  readonly save?: SaveText;
  /** A monotonic millisecond clock for the countdown. */
  readonly now?: () => number;
  readonly timer?: PerformanceTimer;
}

export function PerformanceSettings({
  connection,
  client,
  recorder,
  seconds = PERFORMANCE_PROFILE_DEFAULT_SECONDS,
  write = browserClipboardWriter(),
  save = downloadText,
  now = () => performance.now(),
  timer = browserTimer,
}: PerformanceSettingsProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [copy, setCopy] = useState<CopyState>('idle');
  /** Bumped on every new recording and on leaving, so an answer for an older one is dropped. */
  const generation = useRef(0);
  const cancels = useRef<(() => void)[]>([]);

  const stopTimers = useCallback((): void => {
    for (const cancel of cancels.current) cancel();
    cancels.current = [];
  }, []);

  // A different machine, or leaving the panel, abandons whatever was in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the connection is the reset trigger
  useEffect(() => {
    generation.current += 1;
    setPhase({ kind: 'idle' });
    return () => {
      generation.current += 1;
      stopTimers();
    };
  }, [connection, stopTimers]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different machine makes a new recorder, so the callback is rebuilt with the connection
  const record = useCallback((): void => {
    generation.current += 1;
    const mine = generation.current;
    stopTimers();
    setCopy('idle');
    setElapsedMs(0);
    setPhase({ kind: 'starting' });
    const clickedAt = now();
    const later = (callback: () => void, milliseconds: number): void => {
      cancels.current.push(timer(callback, milliseconds));
    };
    const fail = (cause: unknown): void => {
      if (generation.current !== mine) return;
      stopTimers();
      const failure = profileFailure(cause);
      setPhase(
        failure.kind === 'refused'
          ? { kind: 'refused', reason: failure.reason }
          : { kind: 'failed', reason: failure.reason },
      );
    };
    void (async () => {
      try {
        const started = await startDaemonProfile(client, seconds);
        if (generation.current !== mine) return;
        const totalMs =
          started.state === 'running' ? Math.max(0, Date.parse(started.endsAt) - Date.parse(started.startedAt)) : 0;
        setPhase({ kind: 'recording', totalMs });
        const finish = (report: PerformanceReport): void => {
          if (generation.current !== mine) return;
          stopTimers();
          // This browser's half covers the same seconds: from the click to the report being read.
          const pwa = recorder?.report(Math.max(1, now() - clickedAt)) ?? null;
          setPhase({ kind: 'done', recording: { daemon: report, pwa } });
        };
        const read = (): void => {
          if (generation.current !== mine) return;
          setPhase({ kind: 'reading' });
          void readDaemonProfile(client, started.id).then(view => {
            if (generation.current !== mine) return;
            if (view.state === 'finished') {
              finish(view.report);
              return;
            }
            if (now() - clickedAt > totalMs + READ_GRACE_MS) fail(new Error(PROFILE_TOO_SLOW_SENTENCE));
            else later(read, TICK_MS);
          }, fail);
        };
        if (started.state === 'finished') {
          finish(started.report);
          return;
        }
        const tick = (): void => {
          if (generation.current !== mine) return;
          const elapsed = now() - clickedAt;
          setElapsedMs(elapsed);
          if (elapsed >= totalMs) read();
          else later(tick, Math.min(TICK_MS, totalMs - elapsed));
        };
        later(tick, Math.min(TICK_MS, totalMs));
      } catch (cause) {
        fail(cause);
      }
    })();
  }, [client, connection, now, recorder, seconds, stopTimers, timer]);

  const busy = phase.kind === 'starting' || phase.kind === 'recording' || phase.kind === 'reading';
  const recording = phase.kind === 'done' ? phase.recording : null;

  const copyReport = useCallback((): void => {
    if (recording === null) return;
    write(performanceReportText(recording)).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  }, [recording, write]);

  return (
    <section
      className="fy-usage-settings flex min-w-0 flex-col gap-8"
      aria-labelledby="performance-settings-heading"
      data-performance=""
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="performance-settings-heading" className="m-0 text-row font-semibold text-fg">
          Performance
        </h3>
        <p className="m-0 text-cell leading-base text-muted">
          A report of where this machine and this app spend their time, to share with whoever is looking into “it’s
          slow”.
        </p>
      </div>
      <SettingGroup label="Record a report">
        <SettingRow
          name={`Record ${String(seconds)} seconds`}
          hint="Use the app as you normally would while it runs."
          explanation={`Records what this machine and this app spend their time on for ${String(seconds)} seconds, then shows a report you can copy or download. It names routes, programs and file patterns — never your sessions, files or secrets — so it is safe to share.`}
          wide
          dataAttributes={{ 'data-usage-stack': '' }}
          control={() => (
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px]"
              disabled={busy}
              onClick={record}
              data-performance-record=""
            >
              <Activity size={16} aria-hidden="true" />
              {busy ? 'Recording…' : recording === null ? `Record ${String(seconds)} s` : `Record again`}
            </Button>
          )}
        >
          {phase.kind === 'idle' || phase.kind === 'done' ? null : (
            <div className="px-panel pb-3">
              <PhaseView phase={phase} elapsedMs={elapsedMs} />
            </div>
          )}
        </SettingRow>
        {recording === null ? null : (
          <SettingRow
            name="Share this report"
            hint="Copy it as text, or save both halves as one JSON file."
            wide
            dataAttributes={{ 'data-usage-stack': '' }}
            control={() => (
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Button type="button" className="min-h-[44px] max-w-full" onClick={copyReport} data-performance-copy="">
                  <Copy size={16} aria-hidden="true" />
                  Copy report
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px]"
                  onClick={() => save(performanceFileName(recording), performanceReportJson(recording))}
                  data-performance-download=""
                >
                  <Download size={16} aria-hidden="true" />
                  Download JSON
                </Button>
              </span>
            )}
          >
            {copy === 'idle' ? null : (
              <p
                className="m-0 px-panel pb-3 text-cell leading-base text-muted"
                role="status"
                data-performance-copied={copy}
              >
                {copy === 'copied' ? 'Copied the report.' : 'Copy was blocked — select the report text instead.'}
              </p>
            )}
          </SettingRow>
        )}
      </SettingGroup>
      {phase.kind === 'refused' || phase.kind === 'failed' ? <PhaseProblem phase={phase} /> : null}
      {recording === null ? null : <RecordingView recording={recording} />}
    </section>
  );
}

/** What the recording is doing right now: starting, counting down, or reading the machine's report back. */
function PhaseView({ phase, elapsedMs }: { readonly phase: Phase; readonly elapsedMs: number }) {
  if (phase.kind === 'starting')
    return (
      <p className="m-0 text-cell leading-base text-muted" role="status">
        Starting the recording…
      </p>
    );
  if (phase.kind === 'recording' || phase.kind === 'reading') {
    const total = phase.kind === 'recording' ? phase.totalMs : 0;
    const percent = phase.kind === 'reading' ? 100 : percentDone(elapsedMs, total);
    const words =
      phase.kind === 'reading'
        ? 'Reading the machine’s report…'
        : `Recording — ${secondsLeft(elapsedMs, total)} s left. Use the app as you normally would.`;
    return (
      <div className="flex min-w-0 flex-col gap-1" data-performance-progress={percent}>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label="Recording performance"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={words}
        >
          <span className="block h-full bg-accent" style={{ width: `${String(percent)}%` }} />
        </div>
        <p className="m-0 text-cell leading-base text-muted" aria-hidden="true">
          {words}
        </p>
      </div>
    );
  }
  return null;
}

/** A refusal or a failure is said in a group of its own: one heading, the daemon's sentence, and where to go next. */
function PhaseProblem({ phase }: { readonly phase: Extract<Phase, { kind: 'refused' | 'failed' }> }) {
  if (phase.kind === 'refused')
    return (
      <div role="status" aria-label="Performance unavailable" data-performance-refused="">
        <SettingGroup label="This device may not record this machine">
          <li className="flex min-w-0 flex-col gap-1 px-panel py-3 text-cell leading-base">
            <span className="text-muted">{PROFILE_REFUSED_INTRO}</span>
            {phase.reason === '' ? null : <span className="text-muted">{phase.reason}</span>}
            <span className="text-fg">{PROFILE_REFUSED_REMEDY}</span>
          </li>
        </SettingGroup>
      </div>
    );
  return (
    <div role="alert" aria-label="Performance unavailable" data-performance-failed="">
      <SettingGroup label="The recording could not be finished">
        <li className="flex min-w-0 items-start gap-2 px-panel py-3 text-cell leading-base text-muted">
          <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-err" />
          {phase.reason}
        </li>
      </SettingGroup>
    </div>
  );
}

const REPORT_TEXT =
  'm-0 overflow-x-auto whitespace-pre bg-code-bg px-panel py-3 font-mono text-cell leading-base text-code-fg';

function RecordingView({ recording }: { readonly recording: PerformanceRecording }) {
  const broken = brokenBudgets(recording.daemon);
  return (
    <div className="flex min-w-0 flex-col gap-8" data-performance-report="">
      <div data-performance-budgets={broken.length}>
        <SettingGroup
          label={
            broken.length === 0
              ? `Every budget held (${recording.daemon.budgets.length})`
              : `${broken.length} of ${recording.daemon.budgets.length} budgets over`
          }
        >
          {[...recording.daemon.budgets]
            .sort((left, right) => Number(left.ok) - Number(right.ok))
            .map(budget => (
              <li
                key={budget.name}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-panel py-2 text-cell leading-base"
              >
                <Badge tone={budget.ok ? 'ok' : 'err'}>{budget.ok ? 'ok' : 'over'}</Badge>
                <span className="text-fg">{budget.name}</span>
                <span className="font-mono text-muted">{budgetWords(budget)}</span>
              </li>
            ))}
        </SettingGroup>
      </div>
      <div>
        <SettingGroup label="This machine">
          <li className="min-w-0">
            <pre className={REPORT_TEXT} data-performance-daemon="">
              {renderPerformanceReport(recording.daemon)}
            </pre>
          </li>
        </SettingGroup>
      </div>
      <div>
        <SettingGroup label="This app">
          <li className="min-w-0">
            <pre className={REPORT_TEXT} data-performance-pwa="">
              {recording.pwa === null ? PWA_REPORT_UNAVAILABLE : renderPwaPerformanceReport(recording.pwa)}
            </pre>
          </li>
        </SettingGroup>
      </div>
    </div>
  );
}

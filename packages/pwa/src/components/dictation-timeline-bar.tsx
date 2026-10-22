/**
 * How long each stage of a dictation took: one stacked bar (speech, cleanup, everything else) with the
 * numbers beside it, the slowest stage named, and a summary of recent dictations.
 *
 * It reads a `DictationTimeline` (`lib/stt/dictation-timeline.ts`, the owner of the arithmetic) and
 * draws it; it measures nothing. Colour never carries the meaning alone: every segment has a legend
 * row with its words and its milliseconds, and the slowest is said in text as well as outlined.
 */

import { cn } from '../lib/class-names.ts';
import {
  type BarStage,
  barSegments,
  type DictationTimeline,
  slowestStage,
  summarizeTimelines,
  TIMING_SUMMARY_WINDOW,
  type TimingRow,
  toComposerMs,
} from '../lib/stt/dictation-timeline.ts';

/** `1.2 s` from a second up, whole milliseconds below. */
export const timingDuration = (ms: number): string =>
  ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;

const STAGE_LABEL: Readonly<Record<BarStage, string>> = {
  speech: 'Speech to text',
  cleanup: 'Cleanup',
  other: 'Other',
};

const STAGE_FILL: Readonly<Record<BarStage, string>> = {
  speech: 'bg-accent',
  cleanup: 'bg-ok',
  other: 'bg-faint',
};

const ENGINE_LABEL: Readonly<Record<string, string>> = {
  parakeet: 'Parakeet (on this device)',
  'web-speech': 'Browser speech',
};

const VIA_LABEL: Readonly<Record<string, string>> = {
  device: 'this browser',
  daemon: 'via your machine',
  local: 'on this device',
};

const cleanupKeyLabel = (key: string): string => {
  const [provider = key, via = ''] = key.split('/');
  const place = VIA_LABEL[via];
  const name = provider === 'local' ? 'On-device cleanup' : provider.charAt(0).toUpperCase() + provider.slice(1);
  return place === undefined || provider === 'local' ? name : `${name}, ${place}`;
};

export interface DictationTimelineBarProps {
  readonly timeline: DictationTimeline;
  /** Drop the legend and show only the bar and one summary line: for a list row. */
  readonly compact?: boolean;
}

/** The stacked bar for one dictation, with a legend that says the same thing in words. */
export function DictationTimelineBar({ timeline, compact = false }: DictationTimelineBarProps) {
  const segments = barSegments(timeline);
  const slowest = slowestStage(timeline);
  const sum = segments.reduce((total, segment) => total + segment.ms, 0);
  const visible = segments.filter(segment => segment.ms > 0);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-timeline-bar="">
      <div
        role="img"
        aria-label={`${segments.map(segment => `${STAGE_LABEL[segment.stage]} ${timingDuration(segment.ms)}`).join(', ')}.${
          slowest === undefined ? '' : ` Slowest: ${STAGE_LABEL[slowest]}.`
        }`}
        className="flex h-3 w-full min-w-0 overflow-hidden rounded-control bg-surface-3"
      >
        {visible.map(segment => (
          <span
            key={segment.stage}
            data-stage={segment.stage}
            data-slowest={segment.stage === slowest ? '' : undefined}
            className={cn(
              'h-full min-w-[2px]',
              STAGE_FILL[segment.stage],
              segment.stage === slowest && 'outline outline-2 -outline-offset-2 outline-fg',
            )}
            style={{ width: `${String((segment.ms / sum) * 100)}%` }}
          />
        ))}
      </div>
      {compact ? (
        <p className="m-0 text-meta leading-base text-muted" data-timeline-line="">
          {segments
            .filter(segment => segment.stage !== 'other' || segment.ms > 0)
            .map(segment => `${STAGE_LABEL[segment.stage]} ${timingDuration(segment.ms)}`)
            .join(' · ')}
          {slowest === undefined ? '' : ` · slowest: ${STAGE_LABEL[slowest].toLowerCase()}`}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-meta leading-base text-muted">
          {segments.map(segment => (
            <li
              key={segment.stage}
              className={cn('flex items-center gap-1', segment.stage === slowest && 'font-semibold text-fg')}
              data-legend={segment.stage}
            >
              <span aria-hidden="true" className={cn('inline-block size-2 rounded-sm', STAGE_FILL[segment.stage])} />
              {STAGE_LABEL[segment.stage]} {timingDuration(segment.ms)}
              {segment.stage === slowest ? ' · slowest' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Row = readonly [label: string, value: string | undefined];

/** Every number the timeline holds, in the order a dictation runs. */
export function timelineRows(timeline: DictationTimeline): readonly Row[] {
  const { audio, speech, cleanup } = timeline;
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;
  const tokens =
    cleanup?.promptTokens === undefined && cleanup?.completionTokens === undefined
      ? undefined
      : `prompt ${String(cleanup?.promptTokens ?? '?')} · completion ${String(cleanup?.completionTokens ?? '?')}`;
  const rows: readonly Row[] = [
    [
      'Recording',
      audio === undefined
        ? undefined
        : `${timingDuration(audio.ms)}${audio.bytes === undefined ? '' : ` · ${kb(audio.bytes)}`}`,
    ],
    ['Prepare audio', timeline.prepareMs === undefined ? undefined : timingDuration(timeline.prepareMs)],
    ['Speech engine', [ENGINE_LABEL[speech.engine] ?? speech.engine, speech.model].filter(Boolean).join(' · ')],
    ['Speech to text', timingDuration(speech.totalMs)],
    ['Model load (first use)', speech.loadMs === undefined ? undefined : timingDuration(speech.loadMs)],
    ['Conversation read', timeline.contextMs === undefined ? undefined : timingDuration(timeline.contextMs)],
    [
      'Cleanup provider',
      cleanup === undefined
        ? undefined
        : [cleanupKeyLabel(`${cleanup.provider}/${cleanup.via}`), cleanup.model].filter(Boolean).join(' · '),
    ],
    [
      'Cleanup',
      cleanup === undefined ? undefined : `${timingDuration(cleanup.totalMs)} · ${cleanup.outcome.replace('_', ' ')}`,
    ],
    ['Cleanup first byte', cleanup?.firstByteMs === undefined ? undefined : timingDuration(cleanup.firstByteMs)],
    ['Provider time (daemon)', cleanup?.providerMs === undefined ? undefined : timingDuration(cleanup.providerMs)],
    [
      'Cleanup attempts',
      cleanup === undefined || cleanup.attempts < 2
        ? undefined
        : `${String(cleanup.attempts)} (retried without the conversation)`,
    ],
    ['Cleanup tokens', tokens],
    ['Stop to review', timingDuration(timeline.totalMs)],
    ['Insert into composer', timeline.insertMs === undefined ? undefined : timingDuration(timeline.insertMs)],
    ['Stop to composer', timeline.insertMs === undefined ? undefined : timingDuration(toComposerMs(timeline))],
    ['Time in review box', timeline.reviewMs === undefined ? undefined : timingDuration(timeline.reviewMs)],
  ];
  return rows.filter((row): row is readonly [string, string] => row[1] !== undefined && row[1] !== '');
}

export const timelineText = (timeline: DictationTimeline): string =>
  timelineRows(timeline)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

/** The bar and every number, for the debug sheet. */
export function DictationTimelineDetails({ timeline }: { readonly timeline: DictationTimeline }) {
  return (
    <div className="grid min-w-0 gap-2" data-timeline-details="">
      <DictationTimelineBar timeline={timeline} />
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui">
        {timelineRows(timeline).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SummaryTable({
  title,
  heading,
  rows,
  label,
}: {
  readonly title: string;
  readonly heading: string;
  readonly rows: readonly TimingRow[];
  readonly label: (key: string) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <table className="w-full min-w-0 border-collapse text-meta leading-base" data-timing-table={title}>
      <caption className="pb-1 text-left font-semibold text-fg">{title}</caption>
      <thead>
        <tr className="text-left text-muted">
          <th scope="col" className="py-0.5 pr-2 font-normal">
            {heading}
          </th>
          <th scope="col" className="px-1 py-0.5 text-right font-normal">
            Runs
          </th>
          <th scope="col" className="px-1 py-0.5 text-right font-normal">
            Median
          </th>
          <th scope="col" className="py-0.5 pl-1 text-right font-normal">
            p90
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.key} data-timing-row={row.key}>
            <th scope="row" className="min-w-0 break-words py-0.5 pr-2 text-left font-normal text-fg">
              {label(row.key)}
            </th>
            <td className="whitespace-nowrap px-1 py-0.5 text-right tabular-nums text-muted">{String(row.count)}</td>
            <td className="whitespace-nowrap px-1 py-0.5 text-right tabular-nums text-fg">
              {timingDuration(row.medianMs)}
            </td>
            <td className="whitespace-nowrap py-0.5 pl-1 text-right tabular-nums text-fg">
              {timingDuration(row.p90Ms)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface TimingSummaryProps {
  /** Newest first. Entries without a timeline are skipped. */
  readonly entries: readonly { readonly timeline?: DictationTimeline | undefined }[];
}

/** Median and p90 of speech and of cleanup over the newest dictations, per engine and provider. */
export function TimingSummary({ entries }: TimingSummaryProps) {
  const summary = summarizeTimelines(entries);
  if (summary.dictations === 0) return null;
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-label="Timing summary"
      data-timing-summary=""
    >
      <p className="m-0 text-meta leading-base text-muted">
        Last {String(Math.min(summary.dictations, TIMING_SUMMARY_WINDOW))} timed dictation
        {summary.dictations === 1 ? '' : 's'}: which stage is slow, speech to text or cleanup. Times only; no words.
      </p>
      <SummaryTable
        title="Speech to text"
        heading="Engine"
        rows={summary.speech}
        label={key => ENGINE_LABEL[key] ?? key}
      />
      <SummaryTable title="Cleanup" heading="Provider" rows={summary.cleanup} label={cleanupKeyLabel} />
    </section>
  );
}

/**
 * THE TIMELINE of one CI run (r9 E10): a gantt in plain SVG, no chart library.
 *
 *   - x = time since the run was created; one row per job; the job's steps are segments inside its bar;
 *   - the QUEUE WAIT before a job began is hatched (waiting is not work, so it is not a colour);
 *   - a live run has a now-line; its pulse follows `useMotionAllowed` (the OS switch AND Settings › Motion), and the
 *     line still moves to the new "now" when motion is off;
 *   - hover and keyboard focus show ONE highlight and ONE readout line (name, start, duration, status): arrows walk the
 *     marks (left/right inside a row, up/down between rows, Home/End), so the chart is a single tab stop;
 *   - on a phone the chart scrolls sideways INSIDE its own box (never the page) and the job names stay put; "Fit"
 *     squeezes the whole run into the box instead;
 *   - the chart is bounded: the longest few jobs and, in each, the longest few steps get a bar; the rest fold into one
 *     "N shorter" mark (a thin bar under the steps, a last row for jobs). A mark is a tab stop like any other, and Enter on
 *     it (or a click) opens the text list under the chart, which names every folded job and step. The list is built only
 *     when asked for, so a run of 256 jobs x 500 steps costs the same few hundred nodes as a small one;
 *   - ONE clock for the graph and every number on it: the wall time, the first job's wait and each wait are read at `now`.
 *
 * Colours are the app's status tokens, never a text colour; every status also has a glyph and a word in the label column,
 * so nothing is carried by colour alone. Times on screen are the device's local time.
 */
import { useMotionAllowed } from '@ferretry/app/ui';
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CiRun, CiStatus } from '../../../contract/index.ts';
import {
  FOCUS_KEYS,
  type FocusKey,
  type TimelineMark,
  type TimelineRow,
  barWidth,
  canFit,
  describeMark,
  focusOrder,
  formatSpan,
  layoutTimeline,
  listSteps,
  moveFocus,
  plotWidth,
  timelineTicks,
  xOf,
} from './timeline-model.ts';

const AXIS_H = 32;
const ROW_H = 56;
const BAR_H = 22;
const STEP_H = 14;
const PHONE_BELOW_PX = 640;

/** A status's one colour, from the theme tokens. Skipped never has a bar; queued is the hatch, not a fill. */
const STATUS_COLOR: Readonly<Record<CiStatus, string>> = {
  passed: 'var(--ok)',
  failed: 'var(--err)',
  running: 'var(--accent)',
  cancelled: 'var(--muted)',
  queued: 'var(--pend)',
  skipped: 'var(--muted)',
};

const STATUS_WORD: Readonly<Record<CiStatus, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
  queued: 'Queued',
  skipped: 'Skipped',
};

export interface CiTimelineProps {
  readonly run: CiRun;
  /** The clock, in epoch ms. Fixed in a test or a screenshot; omitted, a live run reads the device clock each second. */
  readonly now?: number;
}

/** The device clock while the run is live (one tick a second); a fixed `now` or a final run starts no timer. */
function useClock(live: boolean, fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !live) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [fixed, live]);
  return fixed ?? now;
}

/** The scroll box's own width, measured before the first paint so the chart is drawn once at its right size. */
function useBoxWidth(): {
  readonly ref: (node: HTMLDivElement | null) => void;
  readonly node: HTMLDivElement | null;
  readonly width: number;
} {
  const [width, setWidth] = useState(0);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (node === null) return undefined;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref: setNode, node, width };
}

const localClock = (originMs: number) => (offsetMs: number) =>
  new Date(originMs + offsetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** One glyph per status (never colour alone). 14 px, drawn in the status colour. */
function StatusGlyph({ status }: { readonly status: CiStatus }): ReactElement {
  const stroke = { stroke: STATUS_COLOR[status], strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const };
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
      {status === 'passed' ? <path d="M2.5 7.5 5.5 10.5 11.5 3.5" {...stroke} strokeLinejoin="round" /> : null}
      {status === 'failed' ? <path d="M3 3 11 11M11 3 3 11" {...stroke} /> : null}
      {status === 'running' ? (
        <>
          <circle cx={7} cy={7} r={5} {...stroke} strokeOpacity={0.5} />
          <path d="M7 2a5 5 0 0 1 5 5" {...stroke} strokeWidth={2.75} />
        </>
      ) : null}
      {status === 'cancelled' ? <path d="M3 3 11 11M7 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" {...stroke} /> : null}
      {status === 'queued' ? <circle cx={7} cy={7} r={4.5} {...stroke} strokeDasharray="2 2.4" /> : null}
      {status === 'skipped' ? <path d="M3 7h8" {...stroke} /> : null}
    </svg>
  );
}

/** One job's folded steps as text, built only while it is open (500 steps are 500 lines only when asked for). */
function FoldedSteps(props: {
  readonly id: string;
  readonly label: string;
  readonly status: CiStatus;
  readonly open: boolean;
  readonly onOpen: (id: string, open: boolean) => void;
  readonly marks: () => readonly TimelineMark[];
  readonly clock: (offsetMs: number) => string;
}): ReactElement {
  const { id, label, status, open, onOpen, marks, clock } = props;
  return (
    <details
      data-ci-timeline-fold={id}
      data-status={status}
      open={open}
      onToggle={event => onOpen(id, event.currentTarget.open)}
      className="ml-3"
    >
      <summary className="cursor-pointer py-0.5">{label}</summary>
      {open ? (
        <ul className="m-0 list-none p-0 pl-3">
          {marks().map(mark => (
            <li key={mark.key} data-ci-timeline-item={mark.key} data-status={mark.status}>
              {describeMark(mark, 0, clock)}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

const labelLength = (row: TimelineRow): string => {
  if (row.bar !== undefined) return `${row.live ? 'running ' : ''}${formatSpan(row.bar.endMs - row.bar.startMs)}`;
  if (row.status === 'skipped') return 'skipped';
  return row.queueMs > 0 ? `waited ${formatSpan(row.queueMs)}` : STATUS_WORD[row.status].toLowerCase();
};

const GAP = 2;
const MORE_H = 5;
/** Approximate width of an axis label in px (11 px type), to keep the now-line off a tick's text. */
const labelWidth = (label: string): number => label.length * 6.4 + 8;

export function CiTimeline({ run, now: fixedNow }: CiTimelineProps): ReactElement {
  const nowMs = useClock(run.live === true, fixedNow);
  const layout = useMemo(() => layoutTimeline(run, nowMs), [run, nowMs]);
  const motion = useMotionAllowed();
  const unique = useId().replace(/[^a-zA-Z0-9]/g, '');
  const patternId = `hatch-${unique}`;
  const dotsId = `dots-${unique}`;

  const box = useBoxWidth();
  const [fit, setFit] = useState(false);
  const labelPx = box.width > 0 && box.width < PHONE_BELOW_PX ? 140 : 200;
  const room = box.width - labelPx;
  const plot = plotWidth(room, fit);
  const ticks = useMemo(() => timelineTicks(layout.spanMs, Math.max(2, Math.floor(plot / 72))), [layout.spanMs, plot]);
  const height = AXIS_H + layout.rows.length * ROW_H + 4;
  const fitMatters = canFit(room);
  const [fade, setFade] = useState({ left: false, right: false });
  const placed = useRef<number | undefined>(undefined);

  // ONE highlight: the mark under the pointer, or the focused one; the last thing the person did wins.
  const order = useMemo(() => focusOrder(layout), [layout]);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<{ readonly key: string; readonly via: 'hover' | 'focus' } | undefined>(
    undefined,
  );
  const [queueHover, setQueueHover] = useState<string | undefined>(undefined);
  const known = (key: string | undefined): key is string => key !== undefined && order.some(mark => mark.key === key);
  const tabbable = known(focused) ? focused : order[0]?.key;
  const activeKey = active !== undefined && known(active.key) ? active.key : undefined;

  // The text list of what the chart folded: closed until asked for, and each job's steps open on their own.
  const [listOpen, setListOpen] = useState(false);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const openMore = useCallback((mark: TimelineMark): void => {
    setListOpen(true);
    if (mark.rowKey !== 'jmore') setOpenFolds(current => new Set(current).add(mark.rowKey));
  }, []);
  const setFold = useCallback((key: string, open: boolean): void => {
    setOpenFolds(current => {
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const folded = order.find(mark => mark.key === tabbable);
      if ((event.key === 'Enter' || event.key === ' ') && folded?.kind === 'more') {
        event.preventDefault();
        openMore(folded);
        return;
      }
      if (!FOCUS_KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const next = moveFocus(layout, tabbable, event.key as FocusKey);
      if (next === undefined) return;
      setFocused(next);
      setActive({ key: next, via: 'focus' });
      svgRef.current?.querySelector<SVGElement>(`[data-mark="${next}"]`)?.focus();
    },
    [layout, order, tabbable, openMore],
  );

  const clock = useMemo(() => localClock(layout.originMs), [layout.originMs]);
  const queueOf = useMemo(() => new Map(layout.rows.map(row => [row.key, row.queueMs])), [layout.rows]);
  const markOf = useMemo(() => new Map(order.map(mark => [mark.key, mark])), [order]);
  const readout = ((): string => {
    const mark = activeKey === undefined ? undefined : markOf.get(activeKey);
    if (mark !== undefined) return describeMark(mark, mark.kind === 'job' ? (queueOf.get(mark.key) ?? 0) : 0, clock);
    const waiting = queueHover === undefined ? undefined : layout.rows.find(row => row.key === queueHover);
    if (waiting !== undefined) return `${waiting.name}: waited ${formatSpan(waiting.queueMs)} before it started`;
    const first = layout.started
      ? `, first job started after ${formatSpan(layout.queuedMs)}`
      : layout.queuedMs > 0
        ? `, still waiting to start (${formatSpan(layout.queuedMs)})`
        : '';
    return `${run.name}: ${run.status}, attempt ${run.attempt}, ${run.live === true ? 'running for ' : 'took '}${formatSpan(layout.wallMs)}${first}.${fitMatters ? ' Tap a bar for its times; scroll sideways for the rest, or tap Fit.' : ' Hover or focus a bar for its times.'}`;
  })();

  // First view: a live run opens at its now-line, a failed one at its first failing bar, so the answer is on screen. A
  // phone starts here instead of at second zero; the names stay put (sticky) so nothing is lost. Measured before paint.
  const nowX = layout.nowMs === undefined ? undefined : xOf(layout.nowMs, layout.spanMs, plot);
  const failedX = useMemo(() => {
    const failing =
      order.find(mark => mark.kind === 'step' && mark.status === 'failed') ??
      order.find(mark => mark.status === 'failed');
    return failing === undefined ? undefined : xOf(failing.startMs, layout.spanMs, plot);
  }, [order, layout.spanMs, plot]);
  const scrollNode = box.node;
  useLayoutEffect(() => {
    if (scrollNode === null || box.width === 0) return;
    const visible = box.width - labelPx;
    if (placed.current !== run.id && !fit && canFit(room)) {
      placed.current = run.id;
      const target = nowX !== undefined ? nowX - visible * 0.75 : failedX !== undefined ? failedX - visible * 0.25 : 0;
      scrollNode.scrollLeft = Math.max(0, target);
    }
    if (fit) scrollNode.scrollLeft = 0;
    const next = {
      left: scrollNode.scrollLeft > 2,
      right: scrollNode.scrollLeft + scrollNode.clientWidth < scrollNode.scrollWidth - 2,
    };
    setFade(current => (current.left === next.left && current.right === next.right ? current : next));
  }, [scrollNode, box.width, labelPx, fit, room, run.id, nowX, failedX]);
  const onScroll = useCallback(() => {
    if (scrollNode === null) return;
    const next = {
      left: scrollNode.scrollLeft > 2,
      right: scrollNode.scrollLeft + scrollNode.clientWidth < scrollNode.scrollWidth - 2,
    };
    setFade(current => (current.left === next.left && current.right === next.right ? current : next));
  }, [scrollNode]);

  const foldedSteps = layout.rows.filter(row => row.steps.at(-1)?.kind === 'more');
  let foldedStepCount = 0;
  for (const row of foldedSteps) foldedStepCount += row.steps.at(-1)?.count ?? 0;
  const foldedJobCount = layout.hiddenJobs.length;
  const foldedWords = [
    ...(foldedJobCount > 0 ? [`${foldedJobCount} shorter ${foldedJobCount === 1 ? 'job' : 'jobs'}`] : []),
    ...(foldedStepCount > 0 ? [`${foldedStepCount} shorter ${foldedStepCount === 1 ? 'step' : 'steps'}`] : []),
  ].join(' and ');

  const usedStatuses = new Set<CiStatus>();
  let anyQueue = false;
  for (const row of layout.rows) {
    if (row.bar !== undefined) usedStatuses.add(row.bar.status);
    for (const step of row.steps) usedStatuses.add(step.status);
    if (row.queueMs > 0) anyQueue = true;
  }

  const hit = (mark: TimelineMark, y: number, h: number): ReactElement => {
    const x = xOf(mark.startMs, layout.spanMs, plot);
    const w = Math.max(barWidth(mark, layout.spanMs, plot), 8);
    return (
      <rect
        key={`hit-${mark.key}`}
        data-mark={mark.key}
        x={x}
        y={y}
        width={w}
        height={h}
        fill="transparent"
        role="option"
        aria-selected={mark.key === activeKey}
        aria-label={describeMark(mark, mark.kind === 'job' ? (queueOf.get(mark.key) ?? 0) : 0, clock)}
        tabIndex={mark.key === tabbable ? 0 : -1}
        style={{ outline: 'none', cursor: 'default' }}
        onClick={mark.kind === 'more' ? () => openMore(mark) : undefined}
        onPointerEnter={() => setActive({ key: mark.key, via: 'hover' })}
        onPointerLeave={() => setActive(focused === undefined ? undefined : { key: focused, via: 'focus' })}
        onFocus={() => {
          setFocused(mark.key);
          setActive({ key: mark.key, via: 'focus' });
        }}
        onBlur={() => {
          setFocused(undefined);
          setActive(current => (current?.via === 'focus' ? undefined : current));
        }}
      />
    );
  };

  const ring = (mark: TimelineMark, y: number, h: number): ReactElement => (
    <rect
      key="ring"
      data-ring={mark.key}
      x={xOf(mark.startMs, layout.spanMs, plot) - 1}
      y={y - 1}
      width={Math.max(barWidth(mark, layout.spanMs, plot), 2) + 2}
      height={h + 2}
      rx={5}
      fill="none"
      stroke="var(--fg)"
      strokeWidth={2}
      pointerEvents="none"
    />
  );

  const activeMark = activeKey === undefined ? undefined : markOf.get(activeKey);
  const rowTop = (row: TimelineRow): number => AXIS_H + row.rowIndex * ROW_H;
  const moreY = (row: TimelineRow): number => rowTop(row) + (ROW_H - BAR_H) / 2 + BAR_H + 3;
  const ringTarget = (() => {
    if (activeMark === undefined) return undefined;
    const row = layout.rows.find(candidate => candidate.key === activeMark.rowKey);
    if (row === undefined) return undefined;
    const barTop = rowTop(row) + (ROW_H - BAR_H) / 2;
    if (activeMark.kind === 'step') return ring(activeMark, rowTop(row) + (ROW_H - STEP_H) / 2, STEP_H);
    return activeMark.key === row.key ? ring(activeMark, barTop, BAR_H) : ring(activeMark, barTop + BAR_H + 3, MORE_H);
  })();

  return (
    <section data-ci-timeline aria-label="Run timeline" className="min-w-0">
      <div className="mb-2 flex items-start justify-between gap-3">
        <p
          data-ci-timeline-readout
          aria-live="polite"
          className="m-0 min-h-[2.5rem] min-w-0 flex-1 text-xs leading-5 text-fg-soft"
        >
          {readout}
        </p>
        {fitMatters ? (
          <button
            type="button"
            data-ci-timeline-fit
            aria-pressed={fit}
            onClick={() => setFit(value => !value)}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium ${
              fit ? 'border-accent bg-accent-soft text-fg' : 'border-border-strong bg-surface-2 text-fg'
            }`}
          >
            {fit ? 'Fit · on' : 'Fit'}
          </button>
        ) : null}
      </div>

      <div className="relative">
        <div
          ref={box.ref}
          data-ci-timeline-scroll
          onScroll={onScroll}
          className="overflow-x-auto overscroll-x-contain rounded-md border border-border bg-surface"
        >
          <div className="flex" style={{ width: labelPx + plot }}>
            <ul
              className="sticky left-0 z-10 m-0 shrink-0 list-none border-r border-border-soft bg-surface p-0"
              style={{ width: labelPx, paddingTop: AXIS_H }}
            >
              <li aria-hidden="true" className="absolute left-3 top-2 text-[11px] text-muted">
                Jobs
              </li>
              {layout.rows.map(row => (
                <li
                  key={row.key}
                  data-ci-timeline-row={row.key}
                  className="flex items-center gap-2 border-b border-border-soft px-3 last:border-b-0"
                  style={{ height: ROW_H }}
                  title={`${row.name}: ${STATUS_WORD[row.status]}`}
                >
                  <StatusGlyph status={row.status} />
                  <span className="sr-only">{STATUS_WORD[row.status]}: </span>
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 break-words text-xs font-medium leading-4 text-fg">
                      {row.name}
                    </span>
                    <span className="block truncate text-[11px] leading-4 text-muted">{labelLength(row)}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div
              role="listbox"
              tabIndex={-1}
              aria-label="Jobs and steps over time. Arrow keys move between bars."
              className="shrink-0"
              onKeyDown={onKeyDown}
            >
              <svg ref={svgRef} role="presentation" width={plot} height={height} className="block">
                <defs>
                  <pattern
                    id={patternId}
                    width={5}
                    height={5}
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width={5} height={5} fill="var(--surface-2)" />
                    <line x1={0} y1={0} x2={0} y2={5} stroke="var(--muted)" strokeWidth={2} />
                  </pattern>
                  <pattern id={dotsId} width={5} height={5} patternUnits="userSpaceOnUse">
                    <circle cx={2.5} cy={2.5} r={1} fill="var(--surface)" fillOpacity={0.85} />
                  </pattern>
                </defs>

                {ticks.map(tick => {
                  const x = xOf(tick.ms, layout.spanMs, plot);
                  return (
                    <g key={tick.ms} data-tick={tick.ms}>
                      <line x1={x} x2={x} y1={AXIS_H - 6} y2={height} stroke="var(--border)" strokeWidth={1} />
                      {nowX !== undefined && nowX >= x - 4 && nowX <= x + labelWidth(tick.label) ? null : (
                        <text
                          x={x + labelWidth(tick.label) > plot ? x - 4 : x + 4}
                          textAnchor={x + labelWidth(tick.label) > plot ? 'end' : 'start'}
                          y={16}
                          fontSize={11}
                          fill="var(--muted)"
                        >
                          {tick.label}
                        </text>
                      )}
                    </g>
                  );
                })}

                {layout.rows.map(row => {
                  const top = rowTop(row);
                  const barY = top + (ROW_H - BAR_H) / 2;
                  const stepY = top + (ROW_H - STEP_H) / 2;
                  const queueW = xOf(row.queueMs, layout.spanMs, plot) - xOf(0, layout.spanMs, plot);
                  const bar = row.bar;
                  const solid = bar !== undefined && row.steps.length === 0 && bar.kind === 'job';
                  return (
                    <g key={row.key} data-row={row.key}>
                      {row.jobIndex < layout.rows.length - 1 ? (
                        <line
                          x1={0}
                          x2={plot}
                          y1={top + ROW_H}
                          y2={top + ROW_H}
                          stroke="var(--border-soft)"
                          strokeWidth={1}
                        />
                      ) : null}
                      {row.queueMs > 0 ? (
                        <rect
                          data-queue={row.key}
                          x={xOf(0, layout.spanMs, plot)}
                          y={top + (ROW_H - 12) / 2}
                          width={queueW}
                          height={12}
                          rx={3}
                          fill={`url(#${patternId})`}
                          onPointerEnter={() => setQueueHover(row.key)}
                          onPointerLeave={() => setQueueHover(undefined)}
                        />
                      ) : null}
                      {bar !== undefined ? (
                        <rect
                          data-job-bar={row.key}
                          x={xOf(bar.startMs, layout.spanMs, plot)}
                          y={barY}
                          width={barWidth(bar, layout.spanMs, plot)}
                          height={BAR_H}
                          rx={4}
                          fill={STATUS_COLOR[bar.status]}
                          fillOpacity={solid ? 1 : bar.kind === 'more' ? 0.5 : 0.25}
                          pointerEvents="none"
                        />
                      ) : null}
                      {bar !== undefined && solid && bar.status === 'failed' ? (
                        <rect
                          x={xOf(bar.startMs, layout.spanMs, plot)}
                          y={barY}
                          width={barWidth(bar, layout.spanMs, plot)}
                          height={BAR_H}
                          rx={4}
                          fill={`url(#${dotsId})`}
                          pointerEvents="none"
                        />
                      ) : null}
                      {bar === undefined && row.queueMs === 0 ? (
                        <text x={10} y={top + ROW_H / 2 + 4} fontSize={11} fill="var(--muted)">
                          {STATUS_WORD[row.status].toLowerCase()}
                        </text>
                      ) : null}
                      {row.steps.map(step => {
                        const x = xOf(step.startMs, layout.spanMs, plot);
                        const w = barWidth(step, layout.spanMs, plot);
                        const gap = w > 2 * GAP + 2 ? GAP / 2 : 0;
                        if (step.kind === 'more')
                          return (
                            <rect
                              key={step.key}
                              data-more={step.key}
                              x={x}
                              y={moreY(row)}
                              width={w}
                              height={MORE_H}
                              rx={2}
                              fill={STATUS_COLOR[step.status]}
                              fillOpacity={0.6}
                              pointerEvents="none"
                            />
                          );
                        return (
                          <g key={step.key} pointerEvents="none">
                            <rect
                              data-step={step.key}
                              x={x + gap}
                              y={stepY}
                              width={w - 2 * gap}
                              height={STEP_H}
                              rx={3}
                              fill={STATUS_COLOR[step.status]}
                            />
                            {step.status === 'failed' ? (
                              <rect
                                x={x + gap}
                                y={stepY}
                                width={w - 2 * gap}
                                height={STEP_H}
                                rx={3}
                                fill={`url(#${dotsId})`}
                              />
                            ) : null}
                          </g>
                        );
                      })}
                      {bar !== undefined ? hit(bar, barY, BAR_H) : null}
                      {row.steps.map(step =>
                        step.kind === 'more' ? hit(step, moreY(row) - 2, MORE_H + 4) : hit(step, stepY - 2, STEP_H + 4),
                      )}
                    </g>
                  );
                })}

                {ringTarget}

                {layout.nowMs !== undefined ? (
                  <g data-now-line pointerEvents="none">
                    <line
                      x1={xOf(layout.nowMs, layout.spanMs, plot)}
                      x2={xOf(layout.nowMs, layout.spanMs, plot)}
                      y1={AXIS_H - 6}
                      y2={height}
                      stroke="var(--accent)"
                      strokeWidth={1.5}
                    />
                    <circle cx={xOf(layout.nowMs, layout.spanMs, plot)} cy={AXIS_H - 6} r={4} fill="var(--accent)">
                      {motion ? <animate attributeName="r" values="4;6;4" dur="1.6s" repeatCount="indefinite" /> : null}
                    </circle>
                  </g>
                ) : null}
              </svg>
            </div>
          </div>
        </div>
        {fade.right ? (
          <div
            aria-hidden="true"
            data-fade="right"
            className="pointer-events-none absolute inset-y-px right-px w-8 rounded-r-md"
            style={{ background: 'linear-gradient(to left, var(--surface), transparent)' }}
          />
        ) : null}
        {fade.left ? (
          <div
            aria-hidden="true"
            data-fade="left"
            className="pointer-events-none absolute inset-y-px z-20 w-10"
            style={{ left: labelPx + 1, background: 'linear-gradient(to right, var(--surface) 30%, transparent)' }}
          />
        ) : null}
      </div>

      {foldedWords === '' ? null : (
        <details
          data-ci-timeline-more
          open={listOpen}
          onToggle={event => setListOpen(event.currentTarget.open)}
          className="mt-2 text-xs text-fg-soft"
        >
          <summary className="cursor-pointer py-1 font-medium text-fg">List {foldedWords}</summary>
          {listOpen ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 pt-1">
              {layout.hiddenJobs.map(row => (
                <li key={row.key} data-ci-timeline-item={row.key} data-status={row.status}>
                  {row.bar === undefined ? (
                    <span>
                      {row.name}: {STATUS_WORD[row.status].toLowerCase()}
                    </span>
                  ) : (
                    <span>{describeMark(row.bar, row.queueMs, clock)}</span>
                  )}
                  {row.stepCount > 0 ? (
                    <FoldedSteps
                      id={row.key}
                      label={`${row.stepCount} ${row.stepCount === 1 ? 'step' : 'steps'}`}
                      status={row.status}
                      open={openFolds.has(row.key)}
                      onOpen={setFold}
                      marks={() => listSteps(run, layout, row.jobIndex)}
                      clock={clock}
                    />
                  ) : null}
                </li>
              ))}
              {foldedSteps.map(row => (
                <li key={row.key}>
                  <FoldedSteps
                    id={row.key}
                    label={`${row.name}: ${row.steps.at(-1)?.name ?? ''}`}
                    status={row.status}
                    open={openFolds.has(row.key)}
                    onOpen={setFold}
                    marks={() => listSteps(run, layout, row.jobIndex)}
                    clock={clock}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      )}

      <ul
        data-ci-timeline-legend
        className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11px] text-muted"
      >
        {(['passed', 'failed', 'running', 'cancelled'] as const)
          .filter(status => usedStatuses.has(status))
          .map(status => (
            <li key={status} className="flex items-center gap-1.5">
              <svg width={10} height={10} aria-hidden="true">
                <rect width={10} height={10} rx={2} fill={STATUS_COLOR[status]} />
                {status === 'failed' ? <rect width={10} height={10} rx={2} fill={`url(#${dotsId})`} /> : null}
              </svg>
              {STATUS_WORD[status]}
            </li>
          ))}
        {foldedWords === '' ? null : (
          <li className="flex items-center gap-1.5">
            <svg width={22} height={10} aria-hidden="true">
              <rect width={22} height={5} y={2} rx={2} fill="var(--muted)" fillOpacity={0.6} />
            </svg>
            Shorter ones folded (Enter on a bar lists them)
          </li>
        )}
        {anyQueue ? (
          <li className="flex items-center gap-1.5">
            <svg width={22} height={10} aria-hidden="true">
              <rect width={22} height={10} rx={2} fill={`url(#${patternId})`} />
            </svg>
            Waiting to start
          </li>
        ) : null}
      </ul>
    </section>
  );
}

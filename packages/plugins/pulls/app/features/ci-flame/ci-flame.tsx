/**
 * THE FLAMEGRAPH OF A CI RUN (r9 E11): an icicle chart. The top bar is the run, under it the jobs, under each job its
 * steps; a bar's width is the time it spent, and its colour is its status (never random). Click a bar to zoom into it
 * (Enter or Space on a focused one); the breadcrumb above goes back. Plain SVG, no chart library.
 *
 * One fixed line under the chart says what the widths mean, with the two numbers a person compares: the total time spent
 * and the run's wall time. The chart takes the run and "now" as arguments; the caller owns the clock.
 */
import { type KeyboardEvent, useLayoutEffect, useState } from 'react';
import type { CiRun, CiStatus } from '../../../contract/index.ts';
import './ci-flame.css';
import { formatDuration } from './format.ts';
import { buildFlame, findPath, type FlameBar, type FlameNode, layoutBars } from './model.ts';

const ROW_HEIGHT = 30;
const STATUS_WORD: Readonly<Record<CiStatus, string>> = {
  queued: 'waiting',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
};
const KIND_WORD = { run: 'Run', job: 'Job', step: 'Step' } as const;

/** The sentence under the chart. Parallel jobs add up, so the total is usually longer than the wall time. */
const unbroken = (ms: number): string => formatDuration(ms).replaceAll(' ', '\u00a0');

export const flameNote = (totalMs: number, wallMs: number): string =>
  totalMs > wallMs
    ? `Width is time spent. Parallel jobs add up, so the total (${unbroken(totalMs)}) is longer than the run’s wall time (${unbroken(wallMs)}).`
    : `Width is time spent. The total (${unbroken(totalMs)}) fits inside the run’s wall time (${unbroken(wallMs)}).`;

const GLYPH_PX = 7;
const PAD_PX = 16;

/** The words on a bar of `px` pixels: all of it when it fits, the name cut with an ellipsis when only that fits, none when even that does not. `0` means "not measured yet": everything (the bar clips it). */
export const barLabel = (node: FlameNode, px: number): string => {
  const full = `${node.name} · ${formatDuration(node.ms)}`;
  if (px <= 0 || px - PAD_PX >= full.length * GLYPH_PX) return full;
  const room = Math.floor((px - PAD_PX) / GLYPH_PX);
  if (room < 4) return '';
  return node.name.length <= room ? node.name : `${node.name.slice(0, room - 1)}…`;
};

const describe = (node: FlameNode, of: FlameNode): string => {
  const share = of.ms === 0 ? 0 : Math.round((node.ms / of.ms) * 100);
  const where = node === of ? '' : ` · ${share}% of ${of.name}`;
  return `${KIND_WORD[node.kind]} ${node.name} · ${STATUS_WORD[node.status]} · ${formatDuration(node.ms)}${where}`;
};

function Bar(props: {
  readonly bar: FlameBar;
  readonly focus: FlameNode;
  readonly shown: boolean;
  readonly chartPx: number;
  readonly onActive: (key: string | undefined) => void;
  readonly onPick: (node: FlameNode) => void;
}) {
  const { bar, focus, shown, chartPx, onActive, onPick } = props;
  const { node } = bar;
  const press = (event: KeyboardEvent<SVGSVGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onPick(node);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a bar is a nested <svg> inside the chart; SVG has no <button>, so it takes the role, a tab stop, and Enter and Space (onKeyDown)
    <svg
      x={`${bar.x}%`}
      y={bar.row * ROW_HEIGHT}
      width={`${bar.width}%`}
      height={ROW_HEIGHT}
      className="fy-flame-bar"
      data-flame-bar={node.key}
      data-kind={node.kind}
      data-status={node.status}
      data-live={node.live ? '' : undefined}
      data-shown={shown ? '' : undefined}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: same reason: a nested <svg> bar has no native button
      role="button"
      tabIndex={0}
      aria-label={describe(node, focus)}
      onClick={() => onPick(node)}
      onKeyDown={press}
      onPointerEnter={() => onActive(node.key)}
      onPointerLeave={() => onActive(undefined)}
      onFocus={() => onActive(node.key)}
      onBlur={() => onActive(undefined)}
    >
      <rect className="fy-flame-fill" width="100%" height="100%" />
      <rect className="fy-flame-edge" width="100%" height="3" />
      <rect className="fy-flame-ring" width="100%" height="100%" />
      <text className="fy-flame-label" x={8} y={ROW_HEIGHT / 2 + 5}>
        {barLabel(node, (bar.width / 100) * chartPx)}
      </text>
    </svg>
  );
}

export function CiFlame(props: { readonly run: CiRun; readonly nowMs: number }) {
  const { run, nowMs } = props;
  const flame = buildFlame(run, nowMs);
  const [focusKey, setFocusKey] = useState('run');
  const [pickedKey, setPickedKey] = useState<string | undefined>(undefined);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [chartEl, setChartEl] = useState<SVGSVGElement | null>(null);
  const [chartPx, setChartPx] = useState(0);
  useLayoutEffect(() => {
    if (chartEl === null) return undefined;
    const measure = (): void => setChartPx(chartEl.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watcher = new ResizeObserver(measure);
    watcher.observe(chartEl);
    return () => watcher.disconnect();
  }, [chartEl]);
  const { root } = flame;
  if (root === undefined)
    return (
      <section className="fy-flame" data-flame-empty="" aria-label={`Flamegraph of ${run.name}`}>
        <p className="fy-flame-note">No time to draw yet: nothing in this run has started.</p>
      </section>
    );

  const trail = findPath(root, focusKey) ?? [root];
  const focus = trail.at(-1) ?? root;
  const bars = layoutBars(focus);
  const rows = Math.max(...bars.map(bar => bar.row)) + 1;
  const byKey = new Map(bars.map(bar => [bar.node.key, bar.node]));
  const shown = byKey.get(activeKey ?? pickedKey ?? '') ?? focus;
  const statuses = [...new Set(bars.map(bar => bar.node.status))];

  const zoomTo = (key: string): void => {
    setFocusKey(key);
    setPickedKey(undefined);
  };
  const pick = (node: FlameNode): void => {
    setPickedKey(node.key);
    if (node.children.length > 0) setFocusKey(node.key);
  };

  return (
    <section className="fy-flame" data-flame="" aria-label={`Flamegraph of ${run.name}`}>
      <nav className="fy-flame-trail" aria-label="Zoom level">
        {trail.map((node, index) =>
          index === trail.length - 1 ? (
            <span key={node.key} className="fy-flame-here" aria-current="location">
              {node.name}
            </span>
          ) : (
            <span key={node.key} className="fy-flame-step">
              <button type="button" className="fy-flame-back" onClick={() => zoomTo(node.key)}>
                {node.name}
              </button>
              <span className="fy-flame-sep" aria-hidden="true">
                ›
              </span>
            </span>
          ),
        )}
      </nav>
      <svg ref={setChartEl} className="fy-flame-chart" height={rows * ROW_HEIGHT}>
        <title>{`Time spent by ${run.name}: the run, its jobs, then their steps`}</title>
        {bars.map(bar => (
          <Bar
            key={bar.node.key}
            bar={bar}
            focus={focus}
            shown={bar.node.key === shown.key}
            chartPx={chartPx}
            onActive={setActiveKey}
            onPick={pick}
          />
        ))}
      </svg>
      <p className="fy-flame-readout" data-flame-readout="" aria-live="polite">
        {describe(shown, focus)}
      </p>
      <ul className="fy-flame-legend" aria-label="Colours">
        {statuses.map(status => (
          <li key={status} data-status={status}>
            <span className="fy-flame-swatch" aria-hidden="true" />
            {STATUS_WORD[status]}
          </li>
        ))}
      </ul>
      <p className="fy-flame-note" data-flame-note="">
        {flameNote(root.ms, run.wallMs)}
      </p>
      {flame.unplotted > 0 ? (
        <p className="fy-flame-note" data-flame-unplotted="">
          {flame.unplotted === 1 ? '1 item has' : `${flame.unplotted} items have`} no time to draw: skipped, still
          waiting or instant.
        </p>
      ) : null}
    </section>
  );
}

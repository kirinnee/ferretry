/**
 * The `type: chart` renderer: an interactive chart drawn in the page itself, in the reader's theme.
 *
 * NO FRAME, NO AUTHOR CODE — the `map` shape. A chart's payload is data in this package's own small
 * language (`lib/fy-render-chart.ts`); it is read by a strict schema, turned into a Chart.js
 * configuration whose every colour, font and formatter is ours (`lib/fy-render-chart-config.ts`), and
 * painted on a canvas. No author string reaches a markup sink: labels are canvas `fillText` and React
 * text. So it needs no sandbox, and runs where the theme is — which is the point of it.
 *
 * LAZY, TWICE. The block mounts it once it is near the screen, and only then does this component fetch
 * the reader and Chart.js as one chunk (`load`, injectable so the unit tier needs no bundler).
 *
 * IN THE THEME, ON SCREEN. Colours come from the theme the block resolved (`components/fy-render-theme.ts`).
 * A theme switch redraws a chart only while it is on screen — the rule a Mermaid diagram follows — and a
 * chart that was off screen redraws when it comes back.
 *
 * A CHART THAT CANNOT BE READ FALLS BACK, QUIETLY. A payload the reader refuses reports `render` and the
 * block shows its source as the ordinary code fence; an engine that will not load reports `library`,
 * which the block offers to try again.
 *
 * WHAT IS PAGE TEXT, NOT CANVAS. The title, the legend (one toggle button per series — a pie's per
 * slice), the step controls and a visually hidden data table, so a keyboard reaches every control and a
 * screen reader gets the numbers, not just the `alt`.
 */

import { ChevronLeft, ChevronRight, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChartSpec, readChart as ReadChart } from '../lib/fy-render-chart.ts';
import { ZOOMABLE_KINDS } from '../lib/fy-render-chart-config.ts';
import { formatChartValue } from '../lib/fy-render-chart-format.ts';
import { paletteColors, paletteKey, type ResolvedTheme, toneColor } from '../lib/fy-render-palette.ts';
import type { ChartHandle, mountChart as MountChart } from './fy-render-chart-engine.ts';
import type { FyRenderSandboxFailure } from './fy-render-sandbox.tsx';

export interface FyRenderChartModules {
  readonly readChart: typeof ReadChart;
  readonly mountChart: typeof MountChart;
}

const loadModules = async (): Promise<FyRenderChartModules> => {
  const [lib, engine] = await Promise.all([import('../lib/fy-render-chart.ts'), import('./fy-render-chart-engine.ts')]);
  return { mountChart: engine.mountChart, readChart: lib.readChart };
};

const matches = (query: string): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
};

export interface FyRenderChartProps {
  readonly alt: string;
  readonly payload: string;
  /** The page's theme, resolved by the block. */
  readonly theme: ResolvedTheme;
  /** On screen now: a theme switch redraws only then. */
  readonly visible: boolean;
  readonly fullscreen: boolean;
  readonly onFailed: (failure: FyRenderSandboxFailure) => void;
  readonly load?: () => Promise<FyRenderChartModules>;
}

type Loaded = { readonly spec: ChartSpec; readonly mountChart: typeof MountChart };

export function FyRenderChart({
  alt,
  payload,
  theme,
  visible,
  fullscreen,
  onFailed,
  load = loadModules,
}: FyRenderChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handle = useRef<ChartHandle | null>(null);
  const tableId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [frame, setFrame] = useState(0);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [zoomed, setZoomed] = useState(false);
  /** The theme the canvas was last painted in — redrawn when it differs AND the chart is on screen. */
  const [painted, setPainted] = useState<{ readonly key: string; readonly theme: ResolvedTheme } | null>(null);
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  useEffect(() => {
    let live = true;
    setLoaded(null);
    load().then(
      modules => {
        if (!live) return;
        const reading = modules.readChart(payload);
        if (!reading.ok) {
          failed.current({ detail: reading.reason, kind: 'render' });
          return;
        }
        setFrame(0);
        setHidden(new Set());
        setLoaded({ mountChart: modules.mountChart, spec: reading.spec });
      },
      () => {
        if (live) failed.current({ detail: 'The chart library could not be loaded', kind: 'library' });
      },
    );
    return () => {
      live = false;
    };
  }, [payload, load]);

  const key = paletteKey(theme);
  if (painted === null || (painted.key !== key && visible)) {
    if (loaded !== null) setPainted({ key, theme });
  }
  const paint = painted?.theme ?? null;

  // The latest frame and legend state, read when the chart is (re)mounted without making either a
  // remount trigger: stepping and toggling are commands on the live chart, never a new one.
  const state = useRef({ frame, hidden });
  state.current = { frame, hidden };

  /**
   * ONE CHART PER (bytes, painted theme, interaction mode). A theme repaint and a fullscreen toggle
   * remount it — the interaction mode decides which gestures the zoom plugin binds, and it binds them at
   * creation — carrying the frame and the hidden series across.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (loaded === null || paint === null || canvas === null) return;
    setZoomed(false);
    let mounted: ChartHandle | null = null;
    try {
      mounted = loaded.mountChart(canvas, {
        frame: state.current.frame,
        hidden: state.current.hidden,
        interaction: {
          animate: !matches('(prefers-reduced-motion: reduce)'),
          coarse: matches('(pointer: coarse)'),
          fullscreen,
          onZoom: setZoomed,
        },
        spec: loaded.spec,
        theme: paint,
      });
    } catch (error) {
      failed.current({
        detail: error instanceof Error ? error.message : 'The chart could not be drawn',
        kind: 'render',
      });
      return;
    }
    handle.current = mounted;
    return () => {
      mounted?.destroy();
      handle.current = null;
    };
  }, [loaded, paint, fullscreen]);

  const step = useCallback((to: number): void => {
    setFrame(to);
    handle.current?.showFrame(to);
  }, []);
  const toggle = (index: number): void => {
    const next = new Set(hidden);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setHidden(next);
    handle.current?.setHidden(next);
  };

  const spec = loaded?.spec ?? null;
  const current = spec?.frames[Math.min(frame, spec.frames.length - 1)] ?? null;
  const sliced = spec?.kind === 'pie' || spec?.kind === 'doughnut';
  const slices = paint === null ? [] : paletteColors(paint);
  const entries =
    current === null
      ? []
      : sliced
        ? current.labels.map((name, index) => ({ color: slices[index % slices.length] ?? '', name }))
        : current.series.map(line => ({ color: paint === null ? '' : toneColor(line.tone, paint), name: line.name }));
  const frames = spec?.frames.length ?? 0;

  return (
    <div
      className="fy-render-chart"
      data-fy-render-chart={spec === null ? 'loading' : 'drawn'}
      data-fy-render-chart-palette={painted?.key ?? ''}
    >
      {current?.title ? <p className="fy-render-chart-title">{current.title}</p> : null}
      <div className="fy-render-chart-plot">
        <canvas
          aria-describedby={spec === null ? undefined : tableId}
          aria-label={`Chart: ${alt}`}
          ref={canvasRef}
          role="img"
        />
        {zoomed && spec !== null && ZOOMABLE_KINDS.has(spec.kind) ? (
          <button
            className="fy-render-quiet-action fy-render-chart-reset"
            onClick={() => handle.current?.resetZoom()}
            type="button"
          >
            <ZoomOut aria-hidden="true" size={12} /> Reset zoom
          </button>
        ) : null}
      </div>
      {entries.length > 1 ? (
        <ul aria-label="Series" className="fy-render-chart-legend">
          {entries.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a series is identified by its position, which never reorders
            <li key={`${index}:${entry.name}`}>
              <button
                aria-pressed={!hidden.has(index)}
                className="fy-render-chart-key"
                onClick={() => toggle(index)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="fy-render-chart-swatch"
                  style={{ background: entry.color || undefined }}
                />
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {spec !== null && frames > 1 ? (
        <div className="fy-render-chart-frames">
          <button
            aria-label="Previous step"
            className="fy-render-tool"
            disabled={frame === 0}
            onClick={() => step(frame - 1)}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={14} />
          </button>
          <input
            aria-label="Step"
            aria-valuetext={`Step ${frame + 1} of ${frames}: ${current?.label ?? ''}`}
            className="fy-render-chart-slider"
            max={frames - 1}
            min={0}
            onChange={event => step(Number(event.currentTarget.value))}
            step={1}
            type="range"
            value={frame}
          />
          <button
            aria-label="Next step"
            className="fy-render-tool"
            disabled={frame >= frames - 1}
            onClick={() => step(frame + 1)}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={14} />
          </button>
          <output aria-live="polite" className="fy-render-chart-step">
            <span className="fy-render-chart-count">
              {frame + 1} / {frames}
            </span>{' '}
            {current?.label}
          </output>
        </div>
      ) : null}
      {spec !== null && current !== null ? <ChartTable frame={current} id={tableId} spec={spec} title={alt} /> : null}
    </div>
  );
}

/** The numbers behind the picture, for a screen reader: one row per label (or point), one column per series. */
function ChartTable({
  spec,
  frame,
  id,
  title,
}: {
  readonly spec: ChartSpec;
  readonly frame: ChartSpec['frames'][number];
  readonly id: string;
  readonly title: string;
}) {
  const caption = frame.label === null ? `Data: ${title}` : `Data: ${title} — ${frame.label}`;
  if (spec.kind === 'scatter')
    return (
      // A WRAPPER, because a table never shrinks below its content: clipping the table itself leaves it full width.
      <div className="fy-render-chart-data" id={id}>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Series</th>
              <th scope="col">{spec.x.label ?? 'x'}</th>
              <th scope="col">{spec.y.label ?? 'y'}</th>
            </tr>
          </thead>
          <tbody>
            {frame.series.flatMap(line =>
              line.points.map((point, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a static, ordered, never-reordered table
                <tr key={`${line.name}:${index}`}>
                  <th scope="row">{line.name}</th>
                  <td>{formatChartValue(point.x, spec.x)}</td>
                  <td>{formatChartValue(point.y, spec.y)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="fy-render-chart-data" id={id}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{spec.x.label ?? 'Label'}</th>
            {frame.series.map(line => (
              <th key={line.name} scope="col">
                {line.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {frame.labels.map((label, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static, ordered, never-reordered table
            <tr key={`${row}:${label}`}>
              <th scope="row">{label}</th>
              {frame.series.map(line => (
                <td key={line.name}>{formatChartValue(line.values[row] ?? null, spec.y)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A read chart, in the reader's theme, as a Chart.js configuration — the one place a `chart` payload
 * meets Chart.js, and pure: no DOM, no canvas, no Chart.js runtime (its types only).
 *
 * WHAT AN AUTHOR CONTROLS ENDS AT THE SPEC. Every colour here is a resolved theme token, every font is
 * the page's, every formatter is {@link formatChartValue} over the closed format set, and every callback
 * is this module's own. An author string reaches Chart.js only as a label or a series name, which it
 * draws with `fillText` on a canvas — text, never markup.
 *
 * The legend and the title are NOT drawn on the canvas: the component renders both as page text, so a
 * legend entry is a real button a keyboard can reach and the title is selectable and themed by CSS.
 */

import type { ChartConfiguration, ChartDataset, ChartType, TooltipItem } from 'chart.js';
import type {} from 'chartjs-plugin-zoom';
import type { ChartAxis, ChartFrame, ChartSpec } from './fy-render-chart.ts';
import { formatChartValue } from './fy-render-chart-format.ts';
import { paletteColors, type ResolvedTheme, toneColor } from './fy-render-palette.ts';

export interface ChartInteraction {
  /** Animate a draw and a frame change. Off under `prefers-reduced-motion: reduce`. */
  readonly animate: boolean;
  /** In the fullscreen overlay, where the chart may take a finger or the wheel without trapping the page. */
  readonly fullscreen: boolean;
  /** A coarse pointer: a finger on the canvas inline belongs to the page's scroll. */
  readonly coarse: boolean;
  /** Told when the reader zooms or resets, so the component can offer Reset. */
  readonly onZoom?: (zoomed: boolean) => void;
}

/** Kinds that draw on a category axis and may zoom along it. */
export const ZOOMABLE_KINDS: ReadonlySet<ChartSpec['kind']> = new Set(['line', 'area']);
const CARTESIAN: ReadonlySet<ChartSpec['kind']> = new Set(['line', 'area', 'bar', 'scatter']);
const SLICED: ReadonlySet<ChartSpec['kind']> = new Set(['pie', 'doughnut']);

/** A hex literal with its alpha replaced: a fill is the series colour, washed. `''` stays `''`. */
const washed = (color: string, alpha: number): string =>
  color === ''
    ? ''
    : `${color.slice(0, 7)}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, '0')}`;

/** A theme value, or Chart.js's own default when the token could not be resolved. */
const or = (color: string): string | undefined => (color === '' ? undefined : color);

const chartType = (kind: ChartSpec['kind']): ChartType => (kind === 'area' ? 'line' : kind);

/** One frame's datasets, coloured from the theme. */
export function chartDatasets(spec: ChartSpec, frame: ChartFrame, theme: ResolvedTheme): ChartDataset[] {
  const many = frame.series.reduce((most, line) => Math.max(most, line.values.length, line.points.length), 0) > 60;
  const palette = paletteColors(theme);
  return frame.series.map((line, index): ChartDataset => {
    const color = toneColor(line.tone, theme);
    if (SLICED.has(spec.kind)) {
      return {
        backgroundColor: frame.labels.map((_, slice) => palette[slice % palette.length] ?? ''),
        borderColor: or(theme.colors.bg),
        borderWidth: 2,
        data: [...line.values],
        hoverOffset: 6,
        label: line.name,
      } as ChartDataset;
    }
    if (spec.kind === 'scatter') {
      return {
        backgroundColor: or(washed(color, 0.75)),
        borderColor: or(color),
        data: line.points.map(({ x, y }) => ({ x, y })),
        label: line.name,
        pointHoverRadius: 6,
        pointRadius: 3.5,
      } as ChartDataset;
    }
    if (spec.kind === 'radar') {
      return {
        backgroundColor: or(washed(color, 0.18)),
        borderColor: or(color),
        borderWidth: 2,
        data: [...line.values],
        fill: true,
        label: line.name,
        pointBackgroundColor: or(color),
        pointRadius: 2.5,
      } as ChartDataset;
    }
    const asLine = line.kind === 'line' || (line.kind === null && spec.kind !== 'bar');
    if (asLine) {
      const area = spec.kind === 'area' && line.kind === null;
      return {
        backgroundColor: or(washed(color, area ? 0.22 : 0.9)),
        borderColor: or(color),
        borderWidth: 2,
        cubicInterpolationMode: 'monotone',
        data: [...line.values],
        fill: area ? (spec.stacked && index > 0 ? '-1' : 'origin') : false,
        label: line.name,
        pointBackgroundColor: or(color),
        pointHoverRadius: 5,
        pointRadius: many ? 0 : 2.5,
        spanGaps: false,
        type: 'line',
        // A line drawn over bars sits on top of them.
        order: spec.kind === 'bar' ? 0 : 1,
      } as ChartDataset;
    }
    return {
      backgroundColor: or(color),
      borderRadius: theme.radius,
      borderSkipped: spec.stacked ? false : 'start',
      data: [...line.values],
      hoverBackgroundColor: or(washed(color, 0.8)),
      label: line.name,
      maxBarThickness: 48,
      order: 1,
      type: 'bar',
    } as ChartDataset;
  });
}

const tickFont = (theme: ResolvedTheme) => ({ family: theme.font || undefined, size: 11 });

/** A value axis: the y of a vertical chart, the x of a horizontal bar chart. */
const valueScale = (spec: ChartSpec, axis: ChartAxis, theme: ResolvedTheme) => ({
  beginAtZero: spec.kind === 'bar' || spec.kind === 'area' || spec.stacked,
  border: { color: or(theme.colors.border), display: false },
  grid: { color: or(theme.colors['border-soft']), drawTicks: false },
  max: axis.max ?? undefined,
  min: axis.min ?? undefined,
  stacked: spec.stacked,
  ticks: {
    callback: (value: number | string) => formatChartValue(Number(value), axis, { compact: true }),
    color: or(theme.colors.muted),
    font: tickFont(theme),
    maxTicksLimit: 6,
    padding: 6,
  },
  title: { color: or(theme.colors.muted), display: axis.label !== null, font: tickFont(theme), text: axis.label ?? '' },
  type: 'linear' as const,
});

/** A category axis: labels, and no grid lines across the plot. */
const categoryScale = (spec: ChartSpec, axis: ChartAxis, theme: ResolvedTheme) => ({
  border: { color: or(theme.colors.border) },
  grid: { display: false },
  stacked: spec.stacked,
  ticks: { autoSkipPadding: 8, color: or(theme.colors.muted), font: tickFont(theme), maxRotation: 0 },
  title: { color: or(theme.colors.muted), display: axis.label !== null, font: tickFont(theme), text: axis.label ?? '' },
  type: 'category' as const,
});

/** The tooltip's one line per series, in the axis's own format. */
const tooltipLabel =
  (spec: ChartSpec) =>
  (item: TooltipItem<ChartType>): string => {
    const name = item.dataset.label ?? '';
    if (spec.kind === 'scatter') {
      const { x, y } = item.raw as { x: number; y: number };
      return `${name}: ${formatChartValue(x, spec.x)}, ${formatChartValue(y, spec.y)}`;
    }
    const raw = item.raw as number | null;
    const value = formatChartValue(raw, spec.y);
    return SLICED.has(spec.kind) ? `${item.label}: ${value}` : `${name}: ${value}`;
  };

/**
 * ZOOM WITHOUT TRAPPING THE PAGE. Inline, a finger on the canvas scrolls the transcript and the mouse
 * zooms by dragging a box or with a pinch on a trackpad (which arrives as Ctrl + wheel), so plain
 * scrolling over a chart never zooms it. In fullscreen the chart is the only thing on screen, so it
 * takes the wheel, a pinch and a drag to pan. Line and area charts only, along the category axis.
 */
const zoomOptions = (spec: ChartSpec, theme: ResolvedTheme, interaction: ChartInteraction) => {
  const onZoom = interaction.onZoom;
  const zoomed = ({ chart }: { chart: { isZoomedOrPanned: () => boolean } }): void =>
    onZoom?.(chart.isZoomedOrPanned());
  const { fullscreen, coarse } = interaction;
  if (!ZOOMABLE_KINDS.has(spec.kind))
    return {
      pan: { enabled: false },
      zoom: { drag: { enabled: false }, pinch: { enabled: false }, wheel: { enabled: false } },
    };
  return {
    limits: { x: { max: 'original' as const, min: 'original' as const, minRange: 2 } },
    pan: { enabled: fullscreen, mode: 'x' as const, onPanComplete: zoomed },
    zoom: {
      drag: {
        backgroundColor: or(washed(theme.colors.accent, 0.15)),
        borderColor: or(theme.colors.accent),
        borderWidth: 1,
        enabled: !fullscreen && !coarse,
      },
      mode: 'x' as const,
      onZoomComplete: zoomed,
      pinch: { enabled: fullscreen },
      wheel: { enabled: !coarse || fullscreen, modifierKey: fullscreen ? undefined : ('ctrl' as const) },
    },
  };
};

export function chartConfiguration(
  spec: ChartSpec,
  frameIndex: number,
  theme: ResolvedTheme,
  interaction: ChartInteraction,
): ChartConfiguration {
  const frame = spec.frames[Math.min(Math.max(frameIndex, 0), spec.frames.length - 1)] as ChartFrame;
  const c = theme.colors;
  const font = { family: theme.font || undefined, size: 12 };
  const scales: Record<string, unknown> = {};
  if (CARTESIAN.has(spec.kind)) {
    const value = valueScale(spec, spec.y, theme);
    const category =
      spec.kind === 'scatter'
        ? { ...valueScale({ ...spec, stacked: false }, spec.x, theme), beginAtZero: false }
        : categoryScale(spec, spec.x, theme);
    scales.x = spec.horizontal ? value : category;
    scales.y = spec.horizontal ? category : value;
  }
  if (spec.kind === 'radar')
    scales.r = {
      angleLines: { color: or(c['border-soft']) },
      beginAtZero: true,
      grid: { color: or(c['border-soft']) },
      pointLabels: { color: or(c['fg-soft']), font: tickFont(theme) },
      ticks: {
        backdropColor: 'transparent',
        callback: (tick: number | string) => formatChartValue(Number(tick), spec.y, { compact: true }),
        color: or(c.muted),
        font: tickFont(theme),
        maxTicksLimit: 5,
      },
    };
  const pointed = spec.kind === 'scatter' || SLICED.has(spec.kind);
  return {
    data: {
      datasets: chartDatasets(spec, frame, theme),
      labels: spec.kind === 'scatter' ? [] : [...frame.labels],
    },
    options: {
      animation: interaction.animate ? { duration: 420, easing: 'easeOutCubic' } : false,
      color: or(c['fg-soft']),
      cutout: spec.kind === 'doughnut' ? '58%' : undefined,
      font,
      indexAxis: spec.horizontal ? 'y' : 'x',
      interaction: pointed
        ? { intersect: true, mode: 'nearest' }
        : { axis: spec.horizontal ? 'y' : 'x', intersect: false, mode: 'index' },
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: {
          backgroundColor: or(c.surface),
          bodyColor: or(c['fg-soft']),
          bodyFont: font,
          borderColor: or(c.border),
          borderWidth: 1,
          boxPadding: 4,
          callbacks: { label: tooltipLabel(spec) },
          cornerRadius: theme.radius,
          padding: 8,
          titleColor: or(c.fg),
          titleFont: { ...font, weight: 600 },
          usePointStyle: true,
        },
        zoom: zoomOptions(spec, theme, interaction),
      },
      responsive: true,
      scales,
    },
    type: chartType(spec.kind),
  } as ChartConfiguration;
}

/**
 * Chart.js, mounted on a canvas the component owns — the only file that imports the library, so the
 * library and its zoom plugin arrive as one lazy chunk, fetched once a chart is near the viewport.
 *
 * BUNDLED, PINNED, TREE-SHAKEN. Only the controllers, scales and elements the seven kinds need are
 * registered; nothing is loaded from the network. Neither Chart.js nor `chartjs-plugin-zoom` (with its
 * Hammer.js dependency) writes markup — they paint a canvas and set inline styles — so the page's
 * `require-trusted-types-for 'script'` has nothing to refuse; `tests/unit/build-contract.test.ts` holds
 * the shipped chunk to that.
 *
 * NO AUTHOR CODE. The configuration comes from `lib/fy-render-chart-config.ts`, whose every callback is
 * its own; the payload contributes numbers and labels, never a function.
 */

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  RadarController,
  RadialLinearScale,
  ScatterController,
  Tooltip,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import type { ChartSpec } from '../lib/fy-render-chart.ts';
import { type ChartInteraction, chartConfiguration, chartDatasets } from '../lib/fy-render-chart-config.ts';
import type { ResolvedTheme } from '../lib/fy-render-palette.ts';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  RadarController,
  RadialLinearScale,
  ScatterController,
  Tooltip,
  zoomPlugin,
);

export interface ChartHandle {
  /** Step to another frame, morphing the series in place (no animation under reduced motion). */
  readonly showFrame: (index: number) => void;
  /** Which series (or, for a pie, which slices) are hidden — the legend's state, applied. */
  readonly setHidden: (hidden: ReadonlySet<number>) => void;
  readonly resetZoom: () => void;
  readonly destroy: () => void;
}

export interface ChartMount {
  readonly spec: ChartSpec;
  readonly frame: number;
  readonly hidden: ReadonlySet<number>;
  readonly theme: ResolvedTheme;
  readonly interaction: ChartInteraction;
}

const sliced = (spec: ChartSpec): boolean => spec.kind === 'pie' || spec.kind === 'doughnut';

export function mountChart(canvas: HTMLCanvasElement, mount: ChartMount): ChartHandle {
  const { spec, theme, interaction } = mount;
  const chart = new Chart(canvas, chartConfiguration(spec, mount.frame, theme, interaction));

  const setHidden = (hidden: ReadonlySet<number>): void => {
    if (sliced(spec)) {
      const count = chart.data.labels?.length ?? 0;
      for (let index = 0; index < count; index += 1)
        if (chart.getDataVisibility(index) === hidden.has(index)) chart.toggleDataVisibility(index);
    } else {
      for (let index = 0; index < chart.data.datasets.length; index += 1)
        chart.setDatasetVisibility(index, !hidden.has(index));
    }
    chart.update();
  };
  if (mount.hidden.size > 0) setHidden(mount.hidden);

  return {
    destroy: () => chart.destroy(),
    // The plugin reports the reset through `onZoomComplete`, which tells the component it is no longer zoomed.
    resetZoom: () => chart.resetZoom(),
    setHidden,
    showFrame: index => {
      const frame = spec.frames[index];
      if (frame === undefined) return;
      const next = chartDatasets(spec, frame, theme);
      // IN PLACE, so Chart.js morphs the bars and lines it already drew rather than redrawing from zero.
      chart.data.labels = spec.kind === 'scatter' ? [] : [...frame.labels];
      next.forEach((dataset, at) => {
        const current = chart.data.datasets[at];
        if (current === undefined) chart.data.datasets.push(dataset);
        else Object.assign(current, dataset);
      });
      chart.data.datasets.length = next.length;
      chart.update(interaction.animate ? undefined : 'none');
    },
  };
}

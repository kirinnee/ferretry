import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import should from 'should';
import '../support/dom.ts';
import { readChart } from '../../src/lib/fy-render-chart.ts';
import { type ResolvedTheme, THEME_TOKENS, type ThemeToken } from '../../src/lib/fy-render-palette.ts';

/**
 * The engine against the REAL Chart.js. The unit DOM has no 2D context, so the canvas is handed one that
 * accepts every drawing call and draws nothing — what is proven is what the engine asks Chart.js to hold
 * (frames swapped in place, series and slices hidden, zoom reset), read back through Chart.js's own API.
 * What it paints is measured in real Chromium (`fy-render-component.visual.test.tsx`).
 */

/** A context whose every method is a no-op, whose measurements are zero, and whose properties are writable. */
const inertContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const state: Record<string | symbol, unknown> = { canvas };
  return new Proxy(state, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, width: 0 });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'getLineDash') return () => [];
      return () => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
};

const realGetContext = HTMLCanvasElement.prototype.getContext;
let engine: typeof import('../../src/components/fy-render-chart-engine.ts');
let chartJs: typeof import('chart.js');
beforeAll(async () => {
  // Chart.js and Hammer.js read `window` while they load, so they are imported only once the DOM exists.
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return inertContext(this);
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  engine = await import('../../src/components/fy-render-chart-engine.ts');
  chartJs = await import('chart.js');
});

// Every other suite in this process gets the DOM's own canvas back.
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

const theme: ResolvedTheme = {
  colors: Object.fromEntries(THEME_TOKENS.map(token => [token, '#123456'])) as Record<ThemeToken, string>,
  font: 'system-ui',
  mode: 'dark',
  radius: 2,
};

const canvases: HTMLCanvasElement[] = [];
afterEach(() => {
  for (const canvas of canvases.splice(0)) chartJs.Chart.getChart(canvas)?.destroy();
  document.body.innerHTML = '';
});

const mount = (payload: string, hidden: ReadonlySet<number> = new Set(), onZoom?: (zoomed: boolean) => void) => {
  const reading = readChart(payload);
  if (!reading.ok) throw new Error(reading.reason);
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  canvases.push(canvas);
  const handle = engine.mountChart(canvas, {
    frame: 0,
    hidden,
    interaction: { animate: false, coarse: false, fullscreen: false, ...(onZoom === undefined ? {} : { onZoom }) },
    spec: reading.spec,
    theme,
  });
  const chart = chartJs.Chart.getChart(canvas);
  if (chart === undefined) throw new Error('Chart.js made no chart');
  return { chart, handle };
};

const FRAMES = [
  'kind: bar',
  'x: [a, b]',
  'series: [{name: A, data: [1, 2]}, {name: B, data: [3, 4]}]',
  'frames:',
  '  - {label: one}',
  '  - {label: two, x: [c, d, e], series: [{name: A, data: [5, 6, 7]}]}',
].join('\n');

describe('mountChart', () => {
  test('should mount the chart with the series it was told to hide already hidden', () => {
    // Act
    const { chart } = mount(FRAMES, new Set([1]));

    // Assert
    should(chart.data.labels).eql(['a', 'b']);
    should([chart.isDatasetVisible(0), chart.isDatasetVisible(1)]).eql([true, false]);
  });

  test('should step to a frame IN PLACE: the same dataset objects, new values, extra series dropped', () => {
    // Arrange
    const { chart, handle } = mount(FRAMES);
    const first = chart.data.datasets[0];

    // Act
    handle.showFrame(1);

    // Assert
    should(chart.data.labels).eql(['c', 'd', 'e']);
    should(chart.data.datasets).have.length(1);
    should(chart.data.datasets[0]).equal(first);
    should(chart.data.datasets[0]?.data).eql([5, 6, 7]);

    // Act — back again, where a series has to be added, and past the end, which is ignored.
    handle.showFrame(0);
    handle.showFrame(9);

    // Assert
    should(chart.data.datasets.map(dataset => dataset.data)).eql([
      [1, 2],
      [3, 4],
    ]);
  });

  test('should hide and show slices of a pie, rather than whole series', () => {
    // Arrange
    const { chart, handle } = mount('kind: pie\nx: [a, b, c]\nseries: [{name: Share, data: [1, 2, 3]}]');

    // Act
    handle.setHidden(new Set([0, 2]));

    // Assert
    should([0, 1, 2].map(index => chart.getDataVisibility(index))).eql([false, true, false]);

    // Act
    handle.setHidden(new Set([2]));

    // Assert — a slice shown again is toggled back, and an already-hidden one is left alone.
    should([0, 1, 2].map(index => chart.getDataVisibility(index))).eql([true, true, false]);
  });

  test('should reset the zoom, tell the component, and destroy the chart', () => {
    // Arrange
    const told: boolean[] = [];
    const { chart, handle } = mount('kind: line\nseries: [{name: A, data: [1, 2, 3]}]', new Set(), zoomed =>
      told.push(zoomed),
    );

    // Act
    handle.resetZoom();
    handle.destroy();

    // Assert
    should(told).eql([false]);
    should(chartJs.Chart.getChart(chart.canvas)).be.undefined();
  });
});

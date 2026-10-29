import { afterEach, describe, test } from 'bun:test';
import { act } from 'react';
import should from 'should';
import { FyRenderChart, type FyRenderChartModules } from '../../src/components/fy-render-chart.tsx';
import type { ChartHandle, ChartMount } from '../../src/components/fy-render-chart-engine.ts';
import type { FyRenderSandboxFailure } from '../../src/components/fy-render-sandbox.tsx';
import { readChart } from '../../src/lib/fy-render-chart.ts';
import { paletteKey, type ResolvedTheme, THEME_TOKENS, type ThemeToken } from '../../src/lib/fy-render-palette.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

/**
 * The chart component, mounted in a real document with Chart.js replaced by a recorder, so what is claimed
 * is the component's own behaviour: when it draws, what it repaints and when, what its legend and step
 * controls call, and what a screen reader is given. The configuration Chart.js receives is proven in
 * `fy-render-palette.test.ts`; the real library, in real Chromium, in `fy-render-component.visual.test.tsx`.
 */

const STEPS = [
  'kind: bar',
  'title: Spend',
  'x: [Mon, Tue]',
  'y: {format: money}',
  'series:',
  '  - {name: Agents, data: [2, 3]}',
  '  - {name: Wardens, data: [1, 1], tone: muted}',
  'frames:',
  '  - {label: Before}',
  '  - {label: After, title: Spend after, series: [{name: Agents, data: [1, 1]}, {name: Wardens, data: [0.5, 0.5]}]}',
].join('\n');

const theme = (mode: 'light' | 'dark', shade = 1): ResolvedTheme => ({
  colors: Object.fromEntries(
    THEME_TOKENS.map((token, index) => [
      token,
      `#${shade.toString(16).padStart(2, '0')}00${(index + 1).toString(16).padStart(2, '0')}`,
    ]),
  ) as Record<ThemeToken, string>,
  font: 'system-ui',
  mode,
  radius: 0,
});

interface Recorder {
  readonly calls: string[];
  readonly mounts: ChartMount[];
  readonly modules: FyRenderChartModules;
}

const recorder = (): Recorder => {
  const calls: string[] = [];
  const mounts: ChartMount[] = [];
  const handle: ChartHandle = {
    destroy: () => calls.push('destroy'),
    resetZoom: () => calls.push('resetZoom'),
    setHidden: hidden => calls.push(`hidden:${[...hidden].join(',')}`),
    showFrame: index => calls.push(`frame:${index}`),
  };
  return {
    calls,
    modules: {
      mountChart: (_canvas, chart) => {
        mounts.push(chart);
        calls.push('mount');
        return handle;
      },
      readChart,
    },
    mounts,
  };
};

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const one of mounted.splice(0)) await one.unmount();
});

const show = async (element: React.ReactElement): Promise<Mounted> => {
  const one = await mount(element);
  mounted.push(one);
  return one;
};

const settle = (ready: () => boolean, what: string): Promise<void> =>
  settleUntil(ready, what, callback => act(callback));

describe('FyRenderChart', () => {
  test('should draw once the modules load, with its title, legend, steps and data table as page text', async () => {
    // Arrange
    const fake = recorder();

    // Act
    const view = await show(
      <FyRenderChart
        alt="Spend per day"
        fullscreen={false}
        load={async () => fake.modules}
        onFailed={() => {}}
        payload={STEPS}
        theme={theme('dark')}
        visible
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the chart to mount');

    // Assert — the canvas is named by the alt and described by the table of its numbers.
    const canvas = must(view.container.querySelector('canvas'), 'the canvas');
    should(canvas.getAttribute('role')).equal('img');
    should(canvas.getAttribute('aria-label')).equal('Chart: Spend per day');
    const table = must(view.container.querySelector('.fy-render-chart-data'), 'the data table');
    should(canvas.getAttribute('aria-describedby')).equal(table.id);
    should(table.querySelector('caption')?.textContent).equal('Data: Spend per day — Before');
    should([...table.querySelectorAll('tbody tr')].map(row => row.textContent)).eql(['Mon$2.00$1.00', 'Tue$3.00$1.00']);
    should(view.container.querySelector('.fy-render-chart-title')?.textContent).equal('Spend');
    // The legend is real toggle buttons; the steps are buttons and a slider.
    should([...view.container.querySelectorAll('.fy-render-chart-key')].map(key => key.textContent)).eql([
      'Agents',
      'Wardens',
    ]);
    should(view.container.querySelector('input[type="range"]')?.getAttribute('aria-valuetext')).equal(
      'Step 1 of 2: Before',
    );
    should(fake.mounts[0]?.frame).equal(0);
    should(fake.mounts[0]?.theme.mode).equal('dark');
  });

  test('should step frames and toggle series as commands on the live chart, never a remount', async () => {
    // Arrange
    const fake = recorder();
    const view = await show(
      <FyRenderChart
        alt="Spend"
        fullscreen={false}
        load={async () => fake.modules}
        onFailed={() => {}}
        payload={STEPS}
        theme={theme('light')}
        visible
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the chart to mount');
    const next = must(view.container.querySelector<HTMLButtonElement>('[aria-label="Next step"]'), 'Next');
    const previous = must(view.container.querySelector<HTMLButtonElement>('[aria-label="Previous step"]'), 'Previous');
    should(previous.disabled).be.true();

    // Act
    await interact(() => next.click());
    const wardens = must(view.container.querySelectorAll<HTMLButtonElement>('.fy-render-chart-key')[1], 'Wardens');
    await interact(() => wardens.click());

    // Assert
    should(fake.calls).eql(['mount', 'frame:1', 'hidden:1']);
    should(next.disabled).be.true();
    should(wardens.getAttribute('aria-pressed')).equal('false');
    should(view.container.querySelector('.fy-render-chart-title')?.textContent).equal('Spend after');
    should(view.container.querySelector('output')?.textContent).equal('2 / 2 After');
    should(view.container.querySelector('table caption')?.textContent).equal('Data: Spend — After');
  });

  test('should repaint for a new theme only while on screen, carrying the frame and hidden series across', async () => {
    // Arrange
    const fake = recorder();
    // One loader for the life of the block, as the app has: a new one is new bytes to read.
    const load = async (): Promise<FyRenderChartModules> => fake.modules;
    const element = (paint: ResolvedTheme, visible: boolean) => (
      <FyRenderChart
        alt="Spend"
        fullscreen={false}
        load={load}
        onFailed={() => {}}
        payload={STEPS}
        theme={paint}
        visible={visible}
      />
    );
    const view = await show(element(theme('dark'), true));
    await settle(() => fake.calls.includes('mount'), 'the chart to mount');
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[aria-label="Next step"]'), 'Next').click(),
    );
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('.fy-render-chart-key'), 'Agents').click(),
    );

    // Act — another theme, while scrolled away.
    await view.render(element(theme('dark', 2), false));

    // Assert — nothing is repainted off screen.
    should(fake.mounts).have.length(1);

    // Act — it comes back.
    await view.render(element(theme('dark', 2), true));

    // Assert — one repaint, in the new palette, where the reader left it.
    should(fake.mounts).have.length(2);
    should(paletteKey(fake.mounts[1]?.theme as ResolvedTheme)).equal(paletteKey(theme('dark', 2)));
    should(fake.mounts[1]?.frame).equal(1);
    should([...(fake.mounts[1]?.hidden ?? [])]).eql([0]);
    should(fake.calls.filter(call => call === 'destroy')).have.length(1);
  });

  test('should report a description it cannot read as a render failure, and a missing library as library', async () => {
    // Arrange
    const failures: FyRenderSandboxFailure[] = [];

    // Act
    await show(
      <FyRenderChart
        alt="Broken"
        fullscreen={false}
        load={async () => recorder().modules}
        onFailed={failure => failures.push(failure)}
        payload={'kind: line\ncolor: red\nseries: [{name: A, data: [1]}]'}
        theme={theme('dark')}
        visible
      />,
    );
    await show(
      <FyRenderChart
        alt="Offline"
        fullscreen={false}
        load={async () => {
          throw new Error('chunk failed');
        }}
        onFailed={failure => failures.push(failure)}
        payload={STEPS}
        theme={theme('dark')}
        visible
      />,
    );
    await settle(() => failures.length === 2, 'both failures');

    // Assert
    should(failures.map(failure => failure.kind).sort()).eql(['library', 'render']);
    should(failures.find(failure => failure.kind === 'render')?.detail).containEql('color');
  });

  test('should remount for fullscreen, which decides which gestures the chart may take', async () => {
    // Arrange
    const fake = recorder();
    const load = async (): Promise<FyRenderChartModules> => fake.modules;
    const element = (fullscreen: boolean) => (
      <FyRenderChart
        alt="Trend"
        fullscreen={fullscreen}
        load={load}
        onFailed={() => {}}
        payload={'kind: line\nseries: [{name: A, data: [1, 2, 3]}]'}
        theme={theme('dark')}
        visible
      />
    );
    const view = await show(element(false));
    await settle(() => fake.calls.includes('mount'), 'the chart to mount');

    // Act
    await view.render(element(true));

    // Assert
    should(fake.mounts.map(chart => chart.interaction.fullscreen)).eql([false, true]);
    // One series: no legend to toggle, no steps.
    should(view.container.querySelector('.fy-render-chart-legend')).be.null();
    should(view.container.querySelector('input[type="range"]')).be.null();
  });
});

describe('FyRenderChart edges', () => {
  test('should offer Reset zoom once the chart reports a zoom, and hand Reset to the live chart', async () => {
    // Arrange
    const fake = recorder();
    const load = async (): Promise<FyRenderChartModules> => fake.modules;
    const view = await show(
      <FyRenderChart
        alt="Trend"
        fullscreen={false}
        load={load}
        onFailed={() => {}}
        payload={'kind: line\nseries: [{name: A, data: [1, 2, 3]}]'}
        theme={theme('dark')}
        visible
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the chart to mount');
    should(view.container.querySelector('.fy-render-chart-reset')).be.null();

    // Act — the reader zooms (the plugin tells the chart, the chart tells the component).
    await interact(() => fake.mounts[0]?.interaction.onZoom?.(true));
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('.fy-render-chart-reset'), 'Reset').click(),
    );

    // Assert
    should(fake.calls).containEql('resetZoom');
  });

  test('should report a chart the engine could not draw as a render failure, with its reason', async () => {
    // Arrange
    const failures: FyRenderSandboxFailure[] = [];
    const load = async (): Promise<FyRenderChartModules> => ({
      mountChart: () => {
        throw new Error('no context');
      },
      readChart,
    });

    // Act
    await show(
      <FyRenderChart
        alt="Broken engine"
        fullscreen={false}
        load={load}
        onFailed={failure => failures.push(failure)}
        payload={'kind: line\nseries: [{name: A, data: [1]}]'}
        theme={theme('dark')}
        visible
      />,
    );
    await settle(() => failures.length === 1, 'the failure');

    // Assert
    should(failures).eql([{ detail: 'no context', kind: 'render' }]);
  });

  test('should give a scatter chart a table of its points, and treat an unreadable media query as no preference', async () => {
    // Arrange — a browser whose `matchMedia` throws: motion and pointer fall back to their defaults.
    const real = window.matchMedia;
    window.matchMedia = (() => {
      throw new Error('unsupported');
    }) as typeof window.matchMedia;
    const fake = recorder();
    const load = async (): Promise<FyRenderChartModules> => fake.modules;

    try {
      // Act
      const view = await show(
        <FyRenderChart
          alt="Latency against size"
          fullscreen={false}
          load={load}
          onFailed={() => {}}
          payload={
            'kind: scatter\nx: {label: Size, format: bytes}\ny: {label: Latency, format: duration}\nseries: [{name: Runs, data: [[1024, 0.5], [2048, 1.5]]}]'
          }
          theme={theme('light')}
          visible
        />,
      );
      await settle(() => fake.calls.includes('mount'), 'the chart to mount');

      // Assert
      should(fake.mounts[0]?.interaction).containEql({ animate: true, coarse: false });
      const table = must(view.container.querySelector('.fy-render-chart-data'), 'the data table');
      should([...table.querySelectorAll('thead th')].map(cell => cell.textContent)).eql(['Series', 'Size', 'Latency']);
      should([...table.querySelectorAll('tbody tr')].map(row => row.textContent)).eql([
        'Runs1 KiB500 ms',
        'Runs2 KiB1.5 s',
      ]);
    } finally {
      window.matchMedia = real;
    }
  });

  test('should load the real reader and engine through its default loader', async () => {
    // Arrange — the one place the lazy chunk's wiring is proven: no fake, the shipped modules. This DOM
    // has no canvas, so Chart.js draws nothing, but it mounts and the page text around it renders.
    const failures: FyRenderSandboxFailure[] = [];

    // Act
    const view = await show(
      <FyRenderChart
        alt="Real modules"
        fullscreen={false}
        onFailed={failure => failures.push(failure)}
        payload={'kind: bar\nx: [a, b]\nseries: [{name: A, data: [1, 2]}, {name: B, data: [2, 1]}]'}
        theme={theme('dark')}
        visible
      />,
    );
    await settle(
      () => view.container.querySelector('[data-fy-render-chart="drawn"]') !== null || failures.length > 0,
      'the real modules',
    );

    // Assert
    should(failures).eql([]);
    should(view.container.querySelectorAll('.fy-render-chart-key')).have.length(2);
  });
});

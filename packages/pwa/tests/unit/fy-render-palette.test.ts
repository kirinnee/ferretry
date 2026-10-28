import { describe, test } from 'bun:test';
import type { ChartConfiguration } from 'chart.js';
import should from 'should';
import { type ChartSpec, readChart } from '../../src/lib/fy-render-chart.ts';
import { chartConfiguration } from '../../src/lib/fy-render-chart-config.ts';
import {
  CHART_PALETTE_SLOTS,
  MERMAID_COLOR_VARIABLES,
  mermaidThemeVariables,
  PALETTE_KEY,
  paletteColors,
  paletteKey,
  type ResolvedTheme,
  THEME_TOKENS,
  type ThemeToken,
  toneColor,
} from '../../src/lib/fy-render-palette.ts';

/**
 * The theme, as data a renderer can use: which token paints which part of a chart or a diagram, the key
 * a compiled diagram is cached under, and the proof that a chart configuration carries NO colour the
 * theme did not supply.
 */

/** A theme whose every token is a distinct, recognisable hex literal: `#0000NN` for the Nth token. */
const theme = (mode: 'light' | 'dark' = 'dark', overrides: Partial<Record<ThemeToken, string>> = {}): ResolvedTheme => {
  const colors = Object.fromEntries(
    THEME_TOKENS.map((token, index) => [token, `#0000${(index + 1).toString(16).padStart(2, '0')}`]),
  ) as Record<ThemeToken, string>;
  return { colors: { ...colors, ...overrides }, font: 'Inter, system-ui, sans-serif', mode, radius: 4 };
};

const spec = (payload: string): ChartSpec => {
  const reading = readChart(payload);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.spec;
};

const interaction = { animate: true, coarse: false, fullscreen: false } as const;

/** The plugin options a test reads, in the shape this package writes them. */
interface Toggle {
  readonly enabled: boolean;
  readonly modifierKey?: string;
}
interface PluginOptions {
  readonly zoom: { readonly zoom: Readonly<Record<'wheel' | 'pinch' | 'drag', Toggle>>; readonly pan: Toggle };
  readonly tooltip: { readonly callbacks: { readonly label: (item: unknown) => string } };
}
const pluginsOf = (config: ChartConfiguration): PluginOptions =>
  (config.options?.plugins ?? {}) as unknown as PluginOptions;

/** Every string in a value that looks like a colour: a hex literal or a CSS colour function. */
const colours = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (/^#[0-9a-f]{3,8}$/iu.test(value) || /^(?:rgb|hsl|oklch|color)a?\(/iu.test(value)) found.push(value);
  } else if (Array.isArray(value)) for (const item of value) colours(item, found);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) colours(item, found);
  return found;
};

describe('fy-render palette — tones', () => {
  test('should map each named tone to its role token and each slot to the viz palette', () => {
    const read = theme();
    should(toneColor('accent', read)).equal(read.colors.accent);
    should(toneColor('good', read)).equal(read.colors.ok);
    should(toneColor('warn', read)).equal(read.colors.warn);
    should(toneColor('bad', read)).equal(read.colors.err);
    should(toneColor('muted', read)).equal(read.colors.muted);
    for (let slot = 1; slot <= CHART_PALETTE_SLOTS; slot += 1)
      should(toneColor(slot, read)).equal(read.colors[`viz-${slot}` as ThemeToken]);
    // Past the last slot wraps, rather than painting nothing.
    should(toneColor(CHART_PALETTE_SLOTS + 1, read)).equal(read.colors['viz-1']);
    should(paletteColors(read)).have.length(CHART_PALETTE_SLOTS);
  });
});

describe('fy-render palette — the diagram cache key', () => {
  test('should change with the mode and with any one colour, and keep the wire shape', () => {
    const base = paletteKey(theme('dark'));
    should(PALETTE_KEY.test(base)).be.true();
    should(base.startsWith('dark:')).be.true();
    should(paletteKey(theme('dark'))).equal(base);
    should(paletteKey(theme('light')).startsWith('light:')).be.true();
    // Two dark themes that differ in one hue are two keys: "dark" alone would keep a stale diagram up.
    should(paletteKey(theme('dark', { 'viz-3': '#123456' }))).not.equal(base);
    should(paletteKey({ ...theme('dark'), font: 'Georgia, serif' })).not.equal(base);
  });
});

describe('fy-render palette — Mermaid theme variables', () => {
  test('should paint every variable it sets from a token, and only the variables the shell admits', () => {
    // Act
    const read = theme('light');
    const variables = mermaidThemeVariables(read);

    // Assert
    const tokenValues = new Set(Object.values(read.colors));
    for (const [key, value] of Object.entries(variables.colors)) {
      should(MERMAID_COLOR_VARIABLES as readonly string[]).containEql(key);
      should(tokenValues.has(value)).be.true();
    }
    should(variables.colors.primaryTextColor).equal(read.colors.fg);
    should(variables.colors.lineColor).equal(read.colors.muted);
    should(variables.colors.pie1).equal(read.colors['viz-1']);
    should(variables.darkMode).be.false();
    should(variables.fontFamily).equal('Inter, system-ui, sans-serif');
  });

  test('should leave out a token that did not resolve and a font that could break out of a style', () => {
    // Arrange — `''` is "not resolved"; a translucent token is still a hex literal and kept.
    const read = { ...theme('dark', { fg: '', muted: '#11223344' }), font: 'x;} svg { fill: red' };

    // Act
    const variables = mermaidThemeVariables(read);

    // Assert
    should(variables.colors).not.have.property('primaryTextColor');
    should(variables.colors.lineColor).equal('#11223344');
    should(variables.fontFamily).equal('');
    should(variables.darkMode).be.true();
  });
});

describe('fy-render chart configuration', () => {
  const BAR =
    'kind: bar\nx: [a, b]\nstacked: true\nseries: [{name: A, data: [1, 2]}, {name: B, data: [3, 4], tone: warn}]';

  test('should carry no colour the theme did not supply, for every kind', () => {
    // Arrange
    const read = theme();
    const allowed = new Set(Object.values(read.colors).flatMap(value => [value, value.slice(0, 7)]));
    const payloads = [
      BAR,
      'kind: line\nseries: [{name: A, data: [1, 2]}, {name: B, data: [2, 1]}]',
      'kind: area\nstacked: true\nseries: [{name: A, data: [1, 2]}, {name: B, data: [2, 1]}]',
      'kind: pie\nx: [a, b, c]\nseries: [{name: A, data: [1, 2, 3]}]',
      'kind: doughnut\nx: [a, b]\nseries: [{name: A, data: [1, 2]}]',
      'kind: scatter\nseries: [{name: A, data: [[1, 2]]}]',
      'kind: radar\nx: [a, b, c]\nseries: [{name: A, data: [1, 2, 3]}]',
    ];

    for (const payload of payloads) {
      // Act
      const found = colours(chartConfiguration(spec(payload), 0, read, interaction));

      // Assert — a wash is the token's own hex with an alpha appended, never a new hue.
      should(found.length).be.above(0);
      for (const colour of found) should(allowed.has(colour.slice(0, 7))).be.true();
    }
  });

  test('should colour each series from its tone, and each pie slice from the palette in order', () => {
    const read = theme();
    const bar = chartConfiguration(spec(BAR), 0, read, interaction);
    should(bar.data.datasets.map(dataset => dataset.backgroundColor)).eql([read.colors['viz-1'], read.colors.warn]);
    const pie = chartConfiguration(
      spec('kind: pie\nx: [a, b, c]\nseries: [{name: A, data: [1, 2, 3]}]'),
      0,
      read,
      interaction,
    );
    should(pie.data.datasets[0]?.backgroundColor).eql([
      read.colors['viz-1'],
      read.colors['viz-2'],
      read.colors['viz-3'],
    ]);
  });

  test('should fall back to the library default for a token that did not resolve, never a guess', () => {
    const read = theme('dark', { 'viz-1': '' });
    const bar = chartConfiguration(spec(BAR), 0, read, interaction);
    should(bar.data.datasets[0]?.backgroundColor).be.undefined();
  });

  test('should zoom only a line or area chart, and never trap a finger or the wheel inline', () => {
    // Arrange
    const zoomOf = (payload: string, mode: { coarse: boolean; fullscreen: boolean }) =>
      pluginsOf(chartConfiguration(spec(payload), 0, theme(), { animate: true, ...mode })).zoom;
    const line = 'kind: line\nseries: [{name: A, data: [1, 2, 3]}]';

    // Assert — a bar chart never zooms.
    const bar = zoomOf(BAR, { coarse: false, fullscreen: true });
    should([bar.zoom.wheel.enabled, bar.zoom.pinch.enabled, bar.zoom.drag.enabled, bar.pan.enabled]).eql([
      false,
      false,
      false,
      false,
    ]);
    // Inline with a mouse: a box drag, or Ctrl + wheel (a trackpad pinch), and no pan.
    const desk = zoomOf(line, { coarse: false, fullscreen: false });
    should([desk.zoom.drag.enabled, desk.zoom.wheel.enabled, desk.zoom.wheel.modifierKey, desk.pan.enabled]).eql([
      true,
      true,
      'ctrl',
      false,
    ]);
    // Inline on a phone: nothing binds, so one finger scrolls the transcript.
    const phone = zoomOf(line, { coarse: true, fullscreen: false });
    should([phone.zoom.drag.enabled, phone.zoom.wheel.enabled, phone.zoom.pinch.enabled, phone.pan.enabled]).eql([
      false,
      false,
      false,
      false,
    ]);
    // Fullscreen: the chart is the plane — pinch, wheel and pan.
    const full = zoomOf(line, { coarse: true, fullscreen: true });
    should([full.zoom.pinch.enabled, full.zoom.wheel.enabled, full.pan.enabled, full.zoom.drag.enabled]).eql([
      true,
      true,
      true,
      false,
    ]);
  });

  test('should not animate under reduced motion, and should swap the axes for a horizontal bar', () => {
    const still = chartConfiguration(spec(BAR), 0, theme(), { ...interaction, animate: false });
    should(still.options?.animation).be.false();
    const horizontal = chartConfiguration(
      spec('kind: bar\nhorizontal: true\ny: {format: percent}\nseries: [{name: A, data: [1]}]'),
      0,
      theme(),
      interaction,
    );
    const scales = horizontal.options?.scales as Record<string, { type: string }>;
    should(horizontal.options?.indexAxis).equal('y');
    should(scales.x?.type).equal('linear');
    should(scales.y?.type).equal('category');
  });

  test('should format a tick and a tooltip with the axis format, never an author callback', () => {
    // Arrange
    const read = spec('kind: line\ny: {format: percent}\nseries: [{name: Share, data: [42]}]');
    const config = chartConfiguration(read, 0, theme(), interaction);
    const scales = config.options?.scales as Record<string, { ticks: { callback: (value: number) => string } }>;
    const { tooltip } = pluginsOf(config);

    // Act / Assert
    should(scales.y?.ticks.callback(42)).equal(new Intl.NumberFormat(undefined, { style: 'percent' }).format(0.42));
    should(tooltip.callbacks.label({ dataset: { label: 'Share' }, label: '1', raw: 42 })).containEql('Share: ');
  });

  test('should draw the frame it is asked for, clamped to the frames there are', () => {
    const read = spec(
      'kind: bar\nseries: [{name: A, data: [1]}]\nframes: [{label: a}, {label: b, series: [{name: A, data: [9]}]}]',
    );
    should(chartConfiguration(read, 1, theme(), interaction).data.datasets[0]?.data).eql([9]);
    should(chartConfiguration(read, 7, theme(), interaction).data.datasets[0]?.data).eql([9]);
  });
});

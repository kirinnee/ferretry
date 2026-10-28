import { describe, test } from 'bun:test';
import should from 'should';
import { FY_RENDER_LIMITS } from '../../src/lib/fy-render-bounds.ts';
import { type ChartSpec, formatChartValue, readChart } from '../../src/lib/fy-render-chart.ts';

/**
 * The chart reader, read as a reader: this package's own chart language in, a bounded drawing plan or a
 * refusal out. Nothing here draws; the config builder, the engine and the component tiers do that.
 */

const spec = (payload: string): ChartSpec => {
  const reading = readChart(payload);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.spec;
};

const reasonOf = (payload: string): string => {
  const reading = readChart(payload);
  if (reading.ok) throw new Error('expected a refusal');
  return reading.reason;
};

const BAR = [
  'kind: bar',
  'title: Warden spend',
  'x: [26 Oct, 27 Oct, 28 Oct]',
  'y: { label: USD, format: money }',
  'stacked: true',
  'series:',
  '  - name: Investigations',
  '    data: [2.1, 2.2, 2.0]',
  '  - name: First-pass filter',
  '    data: [0.3, 0.3, 0.29]',
  '    tone: muted',
].join('\n');

describe('fy-render chart reader — accepted shapes', () => {
  test('should read the brief’s stacked bar chart from YAML into one frame with theme tones', () => {
    // Act
    const read = spec(BAR);

    // Assert — a default tone is the series' palette slot; an authored one is kept as the role it names.
    should(read.kind).equal('bar');
    should(read.stacked).be.true();
    should(read.y).eql({ currency: 'USD', format: 'money', label: 'USD', max: null, min: null });
    should(read.frames).have.length(1);
    should(read.frames[0]?.title).equal('Warden spend');
    should(read.frames[0]?.labels).eql(['26 Oct', '27 Oct', '28 Oct']);
    should(read.frames[0]?.series.map(line => line.tone)).eql([1, 'muted']);
    should(read.frames[0]?.series[0]?.values).eql([2.1, 2.2, 2.0]);
  });

  test('should read the same chart from JSON', () => {
    const json = JSON.stringify({ kind: 'line', series: [{ data: [1, 2, 3], name: 'Turns' }], x: ['a', 'b', 'c'] });
    should(spec(json).frames[0]?.labels).eql(['a', 'b', 'c']);
  });

  test('should accept every kind, with a gap as null and numbers as labels', () => {
    for (const kind of ['line', 'bar', 'area', 'pie', 'doughnut', 'radar'])
      should(spec(`kind: ${kind}\nx: [2024, 2025]\nseries: [{name: A, data: [1, null]}]`).frames[0]?.labels).eql([
        '2024',
        '2025',
      ]);
    const scatter = spec('kind: scatter\nseries: [{name: Runs, data: [[1, 2], {x: 3, y: 4}]}]');
    should(scatter.frames[0]?.series[0]?.points).eql([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    should(scatter.frames[0]?.labels).eql([]);
  });

  test('should number the categories when only values are given', () => {
    should(spec('kind: line\nseries: [{name: A, data: [5, 6, 7]}, {name: B, data: [1]}]').frames[0]?.labels).eql([
      '1',
      '2',
      '3',
    ]);
  });

  test('should read an x axis with a label, and a y axis with bounds and a currency', () => {
    const read = spec(
      'kind: area\nx: {label: Day, values: [Mon, Tue]}\ny: {format: money, currency: EUR, min: 0, max: 10}\nseries: [{name: A, data: [1, 2]}]',
    );
    should(read.x.label).equal('Day');
    should(read.frames[0]?.labels).eql(['Mon', 'Tue']);
    should(read.y).eql({ currency: 'EUR', format: 'money', label: null, max: 10, min: 0 });
  });

  test('should let each frame override the series, the labels and the title, inheriting the rest', () => {
    // Act
    const read = spec(
      [
        'kind: bar',
        'title: Spend',
        'x: [a, b]',
        'series: [{name: Base, data: [1, 2]}]',
        'frames:',
        '  - {label: Before}',
        '  - {label: After, title: Spend after, series: [{name: Base, data: [3, 4]}]}',
        '  - {label: Later, x: [c, d, e], series: [{name: Base, data: [5, 6, 7]}]}',
      ].join('\n'),
    );

    // Assert
    should(read.frames.map(frame => frame.label)).eql(['Before', 'After', 'Later']);
    should(read.frames.map(frame => frame.title)).eql(['Spend', 'Spend after', 'Spend']);
    should(read.frames[0]?.series[0]?.values).eql([1, 2]);
    should(read.frames[1]?.series[0]?.values).eql([3, 4]);
    should(read.frames[2]?.labels).eql(['c', 'd', 'e']);
  });

  test('should keep a per-series kind on a bar chart, so a line can sit over bars', () => {
    const read = spec('kind: bar\nseries: [{name: Cost, data: [1]}, {name: Trend, data: [1], kind: line, tone: 3}]');
    should(read.frames[0]?.series.map(line => [line.kind, line.tone])).eql([
      [null, 1],
      ['line', 3],
    ]);
  });

  test('should read a horizontal bar chart', () => {
    should(spec('kind: bar\nhorizontal: true\nseries: [{name: A, data: [1]}]').horizontal).be.true();
  });
});

describe('fy-render chart reader — refusals', () => {
  test('should refuse what is not JSON or YAML, and what is not an object', () => {
    should(reasonOf('kind: [bar')).equal('The chart description is not valid JSON or YAML');
    should(reasonOf('[1, 2]')).containEql('chart:');
    should(reasonOf('just words')).containEql('chart:');
  });

  test('should refuse a YAML alias, so no document expands past its bytes', () => {
    should(reasonOf('kind: line\nx: &l [a]\nseries: [{name: A, data: [1]}]\nmore: *l')).equal(
      'The chart description is not valid JSON or YAML',
    );
  });

  test('should refuse a colour, a font or any key the language does not name', () => {
    // The point of the language: an author never paints. A `color:` is refused, not ignored, so whoever
    // wrote it sees their block fall back rather than a chart silently in other colours.
    should(reasonOf('kind: line\ncolor: red\nseries: [{name: A, data: [1]}]')).containEql('color');
    should(reasonOf('kind: line\nseries: [{name: A, data: [1], color: "#ff0000"}]')).containEql('color');
    should(reasonOf('kind: line\nseries: [{name: A, data: [1], tone: "#ff0000"}]')).containEql('tone');
    should(reasonOf('kind: line\nseries: [{name: A, data: [1], tone: 9}]')).containEql('tone');
    should(reasonOf('kind: line\noptions: {plugins: {}}\nseries: [{name: A, data: [1]}]')).containEql('options');
    should(reasonOf('kind: line\ny: {format: "$0.00"}\nseries: [{name: A, data: [1]}]')).containEql('y.format');
    should(reasonOf('kind: line\ny: {format: money, currency: usd}\nseries: [{name: A, data: [1]}]')).containEql(
      'currency',
    );
  });

  test('should refuse an unknown kind and a chart with no series', () => {
    should(reasonOf('kind: gantt\nseries: [{name: A, data: [1]}]')).containEql('kind');
    should(reasonOf('kind: line')).containEql('series');
    should(reasonOf('kind: line\nseries: []')).containEql('series');
  });

  test('should refuse a value that is not a finite number', () => {
    should(reasonOf('kind: line\nseries: [{name: A, data: [1, "2"]}]')).containEql('series.0.data');
    should(reasonOf('kind: line\nseries: [{name: A, data: [.inf]}]')).containEql('series.0.data');
  });

  test('should refuse points on a category chart and values on a scatter chart', () => {
    should(reasonOf('kind: line\nseries: [{name: A, data: [[1, 2]]}]')).equal(
      'series "A": only a scatter series is a list of points',
    );
    should(reasonOf('kind: scatter\nseries: [{name: A, data: [1, 2]}]')).equal(
      'series "A": a scatter series is a list of [x, y] points',
    );
    should(reasonOf('kind: scatter\nx: [a]\nseries: [{name: A, data: [[1, 2]]}]')).equal(
      'a scatter chart has a numeric x axis, not labels',
    );
  });

  test('should refuse more values than labels, and options a kind does not have', () => {
    should(reasonOf('kind: bar\nx: [a]\nseries: [{name: A, data: [1, 2]}]')).equal(
      'series "A" has more values than the x axis has labels',
    );
    should(reasonOf('kind: pie\nstacked: true\nseries: [{name: A, data: [1]}]')).equal(
      'stacked is only for line, area and bar charts',
    );
    should(reasonOf('kind: line\nhorizontal: true\nseries: [{name: A, data: [1]}]')).equal(
      'horizontal is only for bar charts',
    );
    should(reasonOf('kind: radar\nseries: [{name: A, data: [1], kind: line}]')).equal(
      'series "A": a per-series kind is only for line, area and bar charts',
    );
  });

  test('should refuse text past its cap, and text over more than one line', () => {
    const long = 'a'.repeat(FY_RENDER_LIMITS.chartTitleCharacters + 1);
    should(reasonOf(`kind: line\ntitle: ${long}\nseries: [{name: A, data: [1]}]`)).containEql('title');
    const name = 'n'.repeat(FY_RENDER_LIMITS.chartLabelCharacters + 1);
    should(reasonOf(`kind: line\nseries: [{name: ${name}, data: [1]}]`)).containEql('series.0.name');
    should(reasonOf('kind: line\nseries: [{name: "two\\nlines", data: [1]}]')).containEql('one line');
  });

  test('should refuse past every count cap', () => {
    const many = (count: number, item: (index: number) => string): string =>
      `[${Array.from({ length: count }, (_, index) => item(index)).join(', ')}]`;
    const tooManySeries = many(FY_RENDER_LIMITS.chartSeries + 1, index => `{name: s${index}, data: [1]}`);
    should(reasonOf(`kind: line\nseries: ${tooManySeries}`)).containEql('series');
    const tooManyPoints = many(FY_RENDER_LIMITS.chartPoints + 1, () => '1');
    should(reasonOf(`kind: line\nseries: [{name: A, data: ${tooManyPoints}}]`)).containEql('series.0.data');
    const tooManyLabels = many(FY_RENDER_LIMITS.chartLabels + 1, index => `l${index}`);
    should(reasonOf(`kind: line\nx: ${tooManyLabels}\nseries: [{name: A, data: [1]}]`)).containEql('x');
    const tooManyFrames = many(FY_RENDER_LIMITS.chartFrames + 1, index => `{label: f${index}}`);
    should(reasonOf(`kind: line\nseries: [{name: A, data: [1]}]\nframes: ${tooManyFrames}`)).containEql('frames');
  });

  test('should refuse a chart that draws too many points across its frames, though each is inside its own cap', () => {
    // Arrange — 12 series of 500 points is 6,000; two frames of it is 12,000.
    const values = `[${Array.from({ length: FY_RENDER_LIMITS.chartPoints }, () => '1').join(',')}]`;
    const series = `[${Array.from({ length: FY_RENDER_LIMITS.chartSeries }, (_, index) => `{name: s${index}, data: ${values}}`).join(',')}]`;

    // Act / Assert
    should(reasonOf(`kind: line\nseries: ${series}\nframes: [{label: a}, {label: b}]`)).equal(
      `the chart draws more than ${FY_RENDER_LIMITS.chartTotalPoints} points`,
    );
  });

  test('should refuse a payload past the byte cap before it is parsed', () => {
    should(reasonOf(`kind: line\n#${'x'.repeat(FY_RENDER_LIMITS.chartBytes)}`)).equal(
      'The chart description exceeds 64 KiB',
    );
  });
});

describe('fy-render chart value formats', () => {
  const en = { locale: 'en-US' } as const;
  const axis = (format: ChartSpec['y']['format'], currency = 'USD') => ({ currency, format });

  test('should print numbers, compact on a tick only past ten thousand', () => {
    should(formatChartValue(1234.567, axis('number'), en)).equal('1,234.57');
    should(formatChartValue(1234, axis('number'), { ...en, compact: true })).equal('1,234');
    should(formatChartValue(123_456, axis('number'), { ...en, compact: true })).equal('123K');
    should(formatChartValue(1_234_567, axis('number'), { ...en, compact: true })).equal('1.23M');
    should(formatChartValue(25_000, axis('money'), { ...en, compact: true })).equal('$25K');
    should(formatChartValue(null, axis('number'), en)).equal('—');
  });

  test('should print a percentage as written, not as a fraction', () => {
    should(formatChartValue(42, axis('percent'), en)).equal('42%');
    should(formatChartValue(12.25, axis('percent'), en)).equal('12.3%');
  });

  test('should print money in the axis currency, with cents only for small amounts', () => {
    should(formatChartValue(2.1, axis('money'), en)).equal('$2.10');
    should(formatChartValue(1234, axis('money'), en)).equal('$1,234');
    should(formatChartValue(3, axis('money', 'EUR'), en)).equal('€3.00');
  });

  test('should print seconds as a person says a duration', () => {
    should(formatChartValue(0.45, axis('duration'), en)).equal('450 ms');
    should(formatChartValue(12.5, axis('duration'), en)).equal('12.5 s');
    should(formatChartValue(200, axis('duration'), en)).equal('3m 20s');
    should(formatChartValue(7500, axis('duration'), en)).equal('2h 5m');
    should(formatChartValue(3600, axis('duration'), en)).equal('1h');
    should(formatChartValue(97_200, axis('duration'), en)).equal('1d 3h');
  });

  test('should print bytes in binary units', () => {
    should(formatChartValue(512, axis('bytes'), en)).equal('512 B');
    should(formatChartValue(1536, axis('bytes'), en)).equal('1.5 KiB');
    should(formatChartValue(5 * 1024 ** 3, axis('bytes'), en)).equal('5 GiB');
  });
});

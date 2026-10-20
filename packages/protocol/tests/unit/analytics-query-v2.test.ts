import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnalyticsAggregation,
  AnalyticsAggregationSchema,
  type AnalyticsLabel,
  AnalyticsLabelSchema,
  type AnalyticsMatcher,
  type AnalyticsMetric,
  AnalyticsMetricSchema,
  type AnalyticsRange,
  ParsedAnalyticsQuerySchema,
} from '../../src/lib/analytics.ts';
import {
  ANALYTICS_RANGE_UNIT_SECONDS,
  ANALYTICS_RANGE_UNITS,
  AnalyticsQueryError,
  type AnalyticsQueryParts,
  formatAnalyticsQuery,
  MAX_ANALYTICS_GROUP_LABELS,
  MAX_ANALYTICS_QUERY_CHARS,
  MAX_ANALYTICS_RANGE_SECONDS,
  parseAnalyticsQuery,
  scopeAnalyticsQuery,
} from '../../src/lib/analytics-query.ts';

/** What a query MEANS, without the spelling it arrived in. */
function meaning(parsed: AnalyticsQueryParts): AnalyticsQueryParts {
  return {
    ...(parsed.aggregation === undefined ? {} : { aggregation: parsed.aggregation }),
    ...(parsed.metric === undefined ? {} : { metric: parsed.metric }),
    groupBy: parsed.groupBy,
    matchers: parsed.matchers,
    ...(parsed.range === undefined ? {} : { range: parsed.range }),
  };
}

function refusal(source: string): unknown {
  try {
    parseAnalyticsQuery(source);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A seeded PRNG (mulberry32), so a failing property names a seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Characters a single-quoted value cannot carry verbatim: the quote, the escape, and what canonical JSON escapes. */
const SINGLE_QUOTE_UNSAFE = new Set(["'", '\\', '\r', '\n', '\t', '\u0000', '\u2028']);

class Gen {
  public constructor(private readonly next: () => number) {}

  public int(below: number): number {
    return Math.floor(this.next() * below);
  }

  public bool(): boolean {
    return this.next() < 0.5;
  }

  public pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)]!;
  }

  public space(): string {
    return this.pick(['', '', ' ', '  ', '\t', '\n ']);
  }

  public value(): string {
    const alphabets = ['abcxyz0189-_./:@+', 'abc*?', 'a b,}{]["\'\\=~()', 'é𝕏\u0000\r\n\t\u2028'];
    const alphabet = [...this.pick(alphabets)];
    const length = 1 + this.int(8);
    let value = '';
    for (let index = 0; index < length; index += 1) value += this.pick(alphabet);
    // A value is trimmed unless quoted, and the grammar has no way to say an all-space value.
    return value.trim() === '' ? 'x' : value;
  }

  public matcher(): AnalyticsMatcher {
    const label = this.pick(AnalyticsLabelSchema.options.filter(candidate => candidate !== 'tree'));
    const value = this.value();
    const kind = this.int(3);
    if (kind === 0) return { label, op: '=~', value, wildcard: true };
    if (kind === 1) return { label, op: '=', value, wildcard: false };
    return { label, op: '=', value, wildcard: /[*?]/.test(value) };
  }

  public range(): AnalyticsRange {
    if (this.bool()) {
      const unit = this.pick(ANALYTICS_RANGE_UNITS);
      const count = 1 + this.int(400);
      return { kind: 'relative', seconds: count * ANALYTICS_RANGE_UNIT_SECONDS[unit] };
    }
    const from = Date.UTC(2024, 0, 1) + this.int(1_000) * (this.bool() ? 86_400_000 : 3_600_000);
    const to = from + (1 + this.int(90)) * (this.bool() ? 86_400_000 : 60_000);
    return { kind: 'absolute', from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }

  public parts(): AnalyticsQueryParts {
    const shape = this.int(3);
    const aggregation: AnalyticsAggregation | undefined =
      shape === 0 ? undefined : this.pick(AnalyticsAggregationSchema.options);
    let metric: AnalyticsMetric | undefined =
      shape === 2 || (shape === 0 && this.bool()) ? this.pick(AnalyticsMetricSchema.options) : undefined;
    if (aggregation === 'count' && metric !== undefined) metric = 'sessions';
    if (
      metric === 'duration_active_seconds_per_turn' &&
      aggregation !== undefined &&
      aggregation !== 'sum' &&
      aggregation !== 'avg'
    ) {
      metric = 'duration_active_seconds';
    }
    const groupBy: AnalyticsLabel[] = [];
    if (aggregation !== undefined) {
      const wanted = this.int(MAX_ANALYTICS_GROUP_LABELS + 1);
      while (groupBy.length < wanted) {
        const label = this.pick(AnalyticsLabelSchema.options);
        if (!groupBy.includes(label)) groupBy.push(label);
      }
    }
    const matchers = Array.from({ length: this.int(4) }, () => this.matcher());
    // An empty query is the DEFAULT query, not a raw one, so a raw query always says something.
    const empty = aggregation === undefined && metric === undefined && matchers.length === 0;
    return {
      ...(aggregation === undefined ? {} : { aggregation }),
      ...(metric === undefined ? {} : { metric }),
      groupBy,
      matchers,
      ...(empty || this.bool() ? { range: this.range() } : {}),
    };
  }

  /** A NON-canonical spelling of the same parts: case, spacing, PromQL nesting, `==`, `w`, quotes. */
  public spell(parts: AnalyticsQueryParts): string {
    const s = () => this.space();
    const matcher = (m: AnalyticsMatcher) => {
      const op = m.op === '=~' ? '=~' : m.wildcard ? '=' : /[*?]/.test(m.value) || this.bool() ? '==' : '=';
      const plain = /^[A-Za-z0-9_./:@+*?-]+$/.test(m.value);
      const quoted =
        !plain || this.bool()
          ? this.bool() && ![...m.value].some(char => SINGLE_QUOTE_UNSAFE.has(char))
            ? `'${m.value}'`
            : JSON.stringify(m.value)
          : m.value;
      return `${m.label}${s()}${op}${s()}${quoted}`;
    };
    const selector =
      parts.matchers.length === 0
        ? this.bool()
          ? '{}'
          : ''
        : `{${s()}${parts.matchers.map(matcher).join(`${s()},${s()}`)}${s()}}`;
    const range = parts.range === undefined ? '' : `[${this.spellRange(parts.range)}]`;
    const by =
      parts.groupBy.length === 0
        ? ''
        : `${this.pick(['by', 'BY', 'By'])}${s()}(${s()}${parts.groupBy.join(`${s()},${s()}`)}${s()})`;
    const aggregation =
      parts.aggregation === undefined ? '' : this.bool() ? parts.aggregation.toUpperCase() : parts.aggregation;
    if (parts.aggregation === undefined) return `${s()}${parts.metric ?? ''}${s()}${selector}${s()}${range}${s()}`;
    if (parts.metric !== undefined && this.bool()) {
      // PromQL: the selector and range inside the call, `by` before or after it.
      const inner = `(${s()}${parts.metric}${s()}${selector}${s()}${range}${s()})`;
      return this.bool()
        ? `${aggregation}${by === '' ? s() : ` ${s()}`}${by}${s()}${inner}`
        : `${aggregation}${inner}${s()}${by}`;
    }
    const call = parts.metric === undefined ? aggregation : `${aggregation}${s()}(${s()}${parts.metric}${s()})`;
    return `${call}${by === '' ? s() : ` ${s()}`}${by}${s()}${selector}${s()}${range}`;
  }

  private spellRange(range: AnalyticsRange): string {
    if (range.kind === 'relative') {
      const units = ANALYTICS_RANGE_UNITS.filter(unit => range.seconds % ANALYTICS_RANGE_UNIT_SECONDS[unit] === 0);
      const unit = this.pick(units);
      return `${range.seconds / ANALYTICS_RANGE_UNIT_SECONDS[unit]}${unit}`;
    }
    const bound = (instant: string, end: boolean) => {
      const at = Date.parse(instant);
      if (at % 86_400_000 === 0 && this.bool()) return new Date(end ? at - 86_400_000 : at).toISOString().slice(0, 10);
      return this.bool() ? instant : instant.replace('.000Z', '+00:00');
    };
    return `${bound(range.from, false)}${this.space()}..${this.space()}${bound(range.to, true)}`;
  }

  /** Arbitrary text over the grammar's own characters, for the never-throws-anything-else property. */
  public noise(): string {
    const tokens = [
      'sum',
      'avg',
      'count',
      'cost_usd',
      'tokens',
      'by',
      '(',
      ')',
      '{',
      '}',
      '[',
      ']',
      ',',
      '=',
      '=~',
      '==',
      '"',
      "'",
      '\\',
      'model',
      'tree',
      'session',
      '7d',
      '0d',
      '2026-10-01',
      '..',
      'T',
      'Z',
      ' ',
      'x',
      '*',
      '9',
    ];
    return Array.from({ length: this.int(14) }, () => this.pick(tokens)).join(this.bool() ? '' : ' ');
  }
}

const SEEDS = Array.from({ length: 40 }, (_, index) => 1_000 + index);
const CASES_PER_SEED = 50;

describe('analytics query grammar v2', () => {
  describe('examples', () => {
    it('should parse a metric, grouping, filters and a relative range into one canonical spelling', () => {
      // Act
      const actual = parseAnalyticsQuery('sum(cost_usd) by (model) {harness=claude, model=claude-opus-5-5} [7d]');

      // Assert
      should(meaning(actual)).deepEqual({
        aggregation: 'sum',
        metric: 'cost_usd',
        groupBy: ['model'],
        matchers: [
          { label: 'harness', op: '=', value: 'claude', wildcard: false },
          { label: 'model', op: '=', value: 'claude-opus-5-5', wildcard: false },
        ],
        range: { kind: 'relative', seconds: 604_800 },
      });
      should(actual.canonical).equal('sum(cost_usd) by (model) {harness=claude, model=claude-opus-5-5} [7d]');
      should(ParsedAnalyticsQuerySchema.parse(actual)).deepEqual(actual);
    });

    it('should canonicalise the PromQL nesting, either side of by', () => {
      // Act
      const before = parseAnalyticsQuery('sum by (model) (cost_usd{harness=claude}[7d])');
      const after = parseAnalyticsQuery('SUM( cost_usd {harness=claude} [1w] ) BY (model)');

      // Assert
      should(before.canonical).equal('sum(cost_usd) by (model) {harness=claude} [7d]');
      should(after.canonical).equal(before.canonical);
    });

    it('should keep every legacy spelling and its canonical form', () => {
      // Act + Assert
      should(parseAnalyticsQuery('sum by (day) {model=x}').canonical).equal('sum by (day) {model=x}');
      should(parseAnalyticsQuery('{status=completed}').canonical).equal('{status=completed}');
      should(parseAnalyticsQuery('count').canonical).equal('count');
      should(parseAnalyticsQuery('sum{model=x}').canonical).equal('sum {model=x}');
    });

    it('should accept a metric with no grouping, and a bare metric as a raw query', () => {
      // Act
      const total = parseAnalyticsQuery('sum(cost_usd)');
      const raw = parseAnalyticsQuery('duration_active_seconds {runtime=claude-auto} [30d]');
      const counted = parseAnalyticsQuery('count(sessions) by (machine, project, session)');

      // Assert
      should(meaning(total)).deepEqual({ aggregation: 'sum', metric: 'cost_usd', groupBy: [], matchers: [] });
      should(raw.aggregation).be.undefined();
      should(raw.metric).equal('duration_active_seconds');
      should(raw.canonical).equal('duration_active_seconds {runtime=claude-auto} [30d]');
      should(counted.groupBy).deepEqual(['machine', 'project', 'session']);
    });

    it('should write relative ranges in the largest exact unit, never weeks', () => {
      // Act + Assert
      should(parseAnalyticsQuery('[14d]').canonical).equal('[14d]');
      should(parseAnalyticsQuery('[4w]').canonical).equal('[28d]');
      should(parseAnalyticsQuery('[48h]').canonical).equal('[2d]');
      should(parseAnalyticsQuery('[90m]').canonical).equal('[90m]');
      should(parseAnalyticsQuery('[120s]').canonical).equal('[2m]');
      should(parseAnalyticsQuery('[61s]').canonical).equal('[61s]');
    });

    it('should read a date range as whole UTC days, last day included, and keep instants exact', () => {
      // Act
      const days = parseAnalyticsQuery('[2026-10-01..2026-10-20]');
      const instants = parseAnalyticsQuery('[2026-10-01T06:00:00+02:00..2026-10-02T00:00:00Z]');

      // Assert
      should(days.range).deepEqual({
        kind: 'absolute',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-21T00:00:00.000Z',
      });
      should(days.canonical).equal('[2026-10-01..2026-10-20]');
      should(instants.range).deepEqual({
        kind: 'absolute',
        from: '2026-10-01T04:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
      });
      should(instants.canonical).equal('[2026-10-01T04:00:00.000Z..2026-10-01]');
    });

    it('should accept the v2 labels and keep the metric and range through a session scope', () => {
      // Act
      const scoped = scopeAnalyticsQuery('max(duration_wall_seconds) by (runtime) [24h]', 'abc');

      // Assert
      should(scoped).equal('max(duration_wall_seconds) by (runtime) {id=abc} [1d]');
    });

    it.each([
      { source: 'sum(cost_usd) by (model) (tokens)', message: 'unexpected analytics query suffix' },
      { source: 'sum(planet)', message: 'unknown analytics metric "planet"' },
      { source: 'sum(', message: 'unknown analytics metric' },
      { source: 'sum(cost_usd', message: 'expected ) after sum(cost_usd' },
      { source: 'sum by (model) (cost_usd) by (day)', message: 'by (...) may be given once' },
      { source: 'count(cost_usd)', message: 'count counts sessions' },
      {
        source: 'max(duration_active_seconds_per_turn)',
        message: 'is a ratio of sums: use sum(duration_active_seconds_per_turn)',
      },
      { source: 'cost_usd by (model)', message: 'requires an aggregation' },
      { source: 'planet {model=x}', message: 'unknown analytics aggregation or metric "planet"' },
      { source: 'sum(cost_usd{model=x}) {model=y}', message: 'filters may be given once' },
      { source: 'sum(cost_usd[7d]) [1d]', message: 'a range may be given once' },
      { source: '{model=x', message: 'unterminated filter selector' },
      { source: '[7d', message: 'unterminated range' },
      { source: '[7y]', message: 'unknown range unit "y"' },
      { source: '[0d]', message: 'longer than zero' },
      { source: '[3661d]', message: 'at most 3660d' },
      { source: '[yesterday]', message: 'must look like [7d]' },
      { source: '[2026-02-30..2026-03-01]', message: 'is not a calendar date' },
      { source: '[2026-10-01..2026-10-01T00:00:00]', message: 'must be a date (2026-10-01) or an ISO instant' },
      { source: '[1969-12-31..1970-01-02]', message: 'range bounds must fall in 1970..9999' },
      { source: '[2026-10-02..2026-10-01]', message: 'a range must end after it starts' },
      { source: '{model=}', message: 'could not parse filter matcher' },
      { source: `{model="x}`, message: 'unterminated quoted filter value' },
    ])('should refuse "$source" with "$message"', ({ source, message }) => {
      // Act
      const actual = refusal(source);

      // Assert
      should(actual).be.instanceof(AnalyticsQueryError);
      should((actual as Error).message).containEql(message);
    });

    it('should refuse a query whose canonical spelling would be too long', () => {
      // Arrange — a raw newline in a single-quoted value is one character in, two once canonical
      const source = `{model='${'\n'.repeat(1_100)}'}`;

      // Act
      const actual = refusal(source);

      // Assert
      should(source.length).be.below(MAX_ANALYTICS_QUERY_CHARS);
      should((actual as Error).message).containEql('once written canonically');
    });

    it('should format parts into the canonical spelling and refuse parts the grammar refuses', () => {
      // Act
      const formatted = formatAnalyticsQuery({
        aggregation: 'avg',
        metric: 'duration_active_seconds',
        groupBy: ['week'],
        matchers: [{ label: 'project', op: '=', value: '/work/ferretry', wildcard: false }],
        range: { kind: 'relative', seconds: 2_592_000 },
      });
      let refused: unknown;
      try {
        formatAnalyticsQuery({ groupBy: ['model'], matchers: [] });
      } catch (error) {
        refused = error;
      }

      // Assert
      should(formatted).equal('avg(duration_active_seconds) by (week) {project=/work/ferretry} [30d]');
      should(refused).be.instanceof(AnalyticsQueryError);
      should(formatAnalyticsQuery({ groupBy: [], matchers: [] })).equal('{}');
      should(parseAnalyticsQuery('{ }').canonical).equal('{}');
    });

    it('should spell the largest relative range and the unit table consistently', () => {
      // Act
      const longest = parseAnalyticsQuery(`[${MAX_ANALYTICS_RANGE_SECONDS / 86_400}d]`);

      // Assert
      should(longest.range).deepEqual({ kind: 'relative', seconds: MAX_ANALYTICS_RANGE_SECONDS });
      should(ANALYTICS_RANGE_UNITS.map(unit => ANALYTICS_RANGE_UNIT_SECONDS[unit])).deepEqual([
        1, 60, 3_600, 86_400, 604_800,
      ]);
    });
  });

  describe('properties', () => {
    it('should parse every spelling of a query to the meaning it was generated from', () => {
      for (const seed of SEEDS) {
        const gen = new Gen(random(seed));
        for (let index = 0; index < CASES_PER_SEED; index += 1) {
          // Arrange
          const parts = gen.parts();
          const spelling = gen.spell(parts);

          // Act
          const parsed = parseAnalyticsQuery(spelling);

          // Assert
          should(meaning(parsed)).deepEqual(meaning(parts), `seed ${seed} case ${index}: ${spelling}`);
        }
      }
    });

    it('should round-trip the canonical form exactly and idempotently', () => {
      for (const seed of SEEDS) {
        const gen = new Gen(random(seed));
        for (let index = 0; index < CASES_PER_SEED; index += 1) {
          // Arrange
          const parsed = parseAnalyticsQuery(gen.spell(gen.parts()));

          // Act
          const again = parseAnalyticsQuery(parsed.canonical);

          // Assert
          should(meaning(again)).deepEqual(meaning(parsed), `seed ${seed} case ${index}: ${parsed.canonical}`);
          should(again.canonical).equal(parsed.canonical);
          should(formatAnalyticsQuery(parsed)).equal(parsed.canonical);
          should(parsed.canonical.length).be.belowOrEqual(MAX_ANALYTICS_QUERY_CHARS);
        }
      }
    });

    it('should refuse arbitrary text only ever with an AnalyticsQueryError', () => {
      for (const seed of SEEDS) {
        const gen = new Gen(random(seed));
        for (let index = 0; index < CASES_PER_SEED; index += 1) {
          // Arrange
          const source = gen.noise();

          // Act
          const outcome = refusal(source);

          // Assert
          if (outcome !== undefined) should(outcome).be.instanceof(AnalyticsQueryError, `seed ${seed}: ${source}`);
          else
            should(parseAnalyticsQuery(parseAnalyticsQuery(source).canonical).canonical).equal(
              parseAnalyticsQuery(source).canonical,
            );
        }
      }
    });
  });
});

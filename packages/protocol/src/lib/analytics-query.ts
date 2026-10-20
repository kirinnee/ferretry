import {
  ANALYTICS_RATIO_METRICS,
  type AnalyticsAggregation,
  AnalyticsAggregationSchema,
  type AnalyticsLabel,
  AnalyticsLabelSchema,
  type AnalyticsMatcher,
  type AnalyticsMetric,
  AnalyticsMetricSchema,
  type AnalyticsRange,
  type ParsedAnalyticsQuery,
} from './analytics.ts';
import { InstantSchema } from './common.ts';

export const DEFAULT_ANALYTICS_QUERY = 'sum by (day)';
export const DEFAULT_SESSION_ANALYTICS_QUERY = 'sum by (model)';
export const MAX_ANALYTICS_QUERY_CHARS = 2_048;
export const MAX_ANALYTICS_GROUP_LABELS = 4;

/** The units a relative range may be written in, smallest first. */
export const ANALYTICS_RANGE_UNITS = ['s', 'm', 'h', 'd', 'w'] as const;
export type AnalyticsRangeUnit = (typeof ANALYTICS_RANGE_UNITS)[number];
export const ANALYTICS_RANGE_UNIT_SECONDS: { readonly [U in AnalyticsRangeUnit]: number } = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/**
 * The longest relative range, about ten years. A bound rather than a convenience: past it a window's
 * start leaves the instants an ISO timestamp can spell, and the window could not be reported back.
 */
export const MAX_ANALYTICS_RANGE_SECONDS = 3_660 * ANALYTICS_RANGE_UNIT_SECONDS.d;

/**
 * The units a canonical relative range is WRITTEN in, largest first. Weeks are accepted on input and
 * never emitted, so `[14d]` stays `[14d]` instead of turning into `[2w]` under a range chip.
 */
const CANONICAL_RANGE_UNITS: readonly AnalyticsRangeUnit[] = ['d', 'h', 'm', 's'];

const DAY_MS = 86_400_000;
/** 9999-12-31T23:59:59.999Z — the last instant a four-digit-year ISO timestamp spells. */
const MAX_INSTANT_MS = 253_402_300_799_999;

// DERIVED, never respelled. A second copy of either list proves soundness — no wrong member — and
// says nothing about completeness, so a label added to the schema would parse everywhere except in
// the query grammar, and the only symptom would be a query an operator was told does not exist.
const ANALYTICS_AGGREGATIONS: readonly AnalyticsAggregation[] = AnalyticsAggregationSchema.options;
const ANALYTICS_LABELS: readonly AnalyticsLabel[] = AnalyticsLabelSchema.options;
const ANALYTICS_METRICS: readonly AnalyticsMetric[] = AnalyticsMetricSchema.options;
const aggregations = new Set<string>(ANALYTICS_AGGREGATIONS);
const labels = new Set<string>(ANALYTICS_LABELS);
const metrics = new Set<string>(ANALYTICS_METRICS);

export class AnalyticsQueryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AnalyticsQueryError';
  }
}

/** A query as data: everything `formatAnalyticsQuery` needs to write its one canonical spelling. */
export interface AnalyticsQueryParts {
  readonly aggregation?: AnalyticsAggregation;
  readonly metric?: AnalyticsMetric;
  readonly groupBy: readonly AnalyticsLabel[];
  readonly matchers: readonly AnalyticsMatcher[];
  readonly range?: AnalyticsRange;
}

const MATCHER_HEAD = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:==|=~|=)\s*$/;

function splitMatchers(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== undefined) {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote === char) quote = undefined;
      else if (quote === undefined && MATCHER_HEAD.test(source.slice(start, index))) quote = char;
      continue;
    }
    if (char === ',' && quote === undefined) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/**
 * The index of the `}` closing the selector that opens at `open`.
 *
 * Quotes are tracked by the same rule `splitMatchers` uses — a quote opens a value only straight after
 * `label op` — so a `}` inside a quoted value never closes the selector, and the range that may follow
 * the selector is never read as part of it.
 */
function selectorEnd(source: string, open: number): number {
  let start = open + 1;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) escaped = false;
    else if (char === '\\' && quote !== undefined) escaped = true;
    else if (char === '"' || char === "'") {
      if (quote === char) quote = undefined;
      else if (quote === undefined && MATCHER_HEAD.test(source.slice(start, index))) quote = char;
    } else if (quote === undefined && char === ',') start = index + 1;
    else if (quote === undefined && char === '}') return index;
  }
  if (quote !== undefined) throw new AnalyticsQueryError('unterminated quoted filter value');
  throw new AnalyticsQueryError('unterminated filter selector: expected }');
}

function parseValue(source: string): string {
  const value = source.trim();
  if (value === '') throw new AnalyticsQueryError('filter values may not be empty');
  const first = value[0];
  if (first !== '"' && first !== "'") return value;
  if (value.length < 2 || value.at(-1) !== first) throw new AnalyticsQueryError('unterminated quoted filter value');

  // Double-quoted values are bounded JSON strings: decode via JSON.parse so CR, BS, FF, NUL,
  // \uXXXX and astral surrogate pairs round-trip exactly against canonical JSON.stringify.
  if (first === '"') {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new AnalyticsQueryError('malformed double-quoted filter value');
    }
  }

  let result = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char !== '\\') {
      result += char;
      continue;
    }
    index += 1;
    const escaped = value[index]!;
    result += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
  }
  return result;
}

function unknownLabel(label: string): AnalyticsQueryError {
  return new AnalyticsQueryError(
    `unknown analytics label ${JSON.stringify(label)} (choose ${ANALYTICS_LABELS.join(', ')})`,
  );
}

function parseMatchers(source: string): AnalyticsMatcher[] {
  if (source.trim() === '') return [];
  return splitMatchers(source).flatMap(raw => {
    const part = raw.trim();
    if (part === '') return [];
    const match = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|=~|=)\s*(.+)$/s);
    if (match === null) throw new AnalyticsQueryError(`could not parse filter matcher ${JSON.stringify(part)}`);
    const label = match[1]!;
    if (!labels.has(label)) throw unknownLabel(label);

    const syntaxOp = match[2] as '==' | '=' | '=~';
    const op = syntaxOp === '=~' ? '=~' : '=';
    const value = parseValue(match[3]!);
    const wildcard = syntaxOp !== '==' && (op === '=~' || /[*?]/.test(value));
    if (label === 'tree' && wildcard) {
      throw new AnalyticsQueryError('tree filters take one exact session id: use {tree=<session-id>}');
    }
    return [{ label: label as AnalyticsLabel, op, value, wildcard }];
  });
}

function parseGroupBy(source: string): AnalyticsLabel[] {
  const groupBy: AnalyticsLabel[] = [];
  for (const raw of source.split(',')) {
    const label = raw.trim();
    if (label === '') continue;
    if (!labels.has(label)) throw unknownLabel(label);
    if (groupBy.includes(label as AnalyticsLabel)) {
      throw new AnalyticsQueryError(`duplicate grouping label ${JSON.stringify(label)}`);
    }
    groupBy.push(label as AnalyticsLabel);
  }
  if (groupBy.length === 0) throw new AnalyticsQueryError('by (...) needs at least one label');
  if (groupBy.length > MAX_ANALYTICS_GROUP_LABELS) {
    throw new AnalyticsQueryError(`at most ${MAX_ANALYTICS_GROUP_LABELS} grouping labels are allowed`);
  }
  return groupBy;
}

/** One end of an absolute range, in epoch milliseconds. A date is a UTC day; `end` makes it inclusive. */
function rangeBound(source: string, end: boolean): number {
  const text = source.trim();
  const date = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const start = Date.UTC(year, month - 1, day);
    // Date.UTC rolls 2026-02-30 over into March; a date that does not name itself is not a date.
    if (new Date(start).toISOString().slice(0, 10) !== text) {
      throw new AnalyticsQueryError(`range date ${JSON.stringify(text)} is not a calendar date`);
    }
    return end ? start + DAY_MS : start;
  }
  if (!InstantSchema.safeParse(text).success) {
    throw new AnalyticsQueryError(
      `range bound ${JSON.stringify(text)} must be a date (2026-10-01) or an ISO instant with a timezone`,
    );
  }
  return Date.parse(text);
}

function parseRange(source: string): AnalyticsRange {
  const text = source.trim();
  const relative = text.match(/^(\d{1,9})([A-Za-z]+)$/);
  if (relative !== null) {
    const unit = relative[2]! as AnalyticsRangeUnit;
    if (!ANALYTICS_RANGE_UNITS.includes(unit)) {
      throw new AnalyticsQueryError(
        `unknown range unit ${JSON.stringify(relative[2])} (choose ${ANALYTICS_RANGE_UNITS.join(', ')})`,
      );
    }
    const seconds = Number(relative[1]) * ANALYTICS_RANGE_UNIT_SECONDS[unit];
    if (seconds === 0) throw new AnalyticsQueryError('a range must be longer than zero');
    if (seconds > MAX_ANALYTICS_RANGE_SECONDS) {
      throw new AnalyticsQueryError(`a range may be at most ${MAX_ANALYTICS_RANGE_SECONDS / 86_400}d`);
    }
    return { kind: 'relative', seconds };
  }
  const bounds = text.split('..');
  if (bounds.length !== 2) {
    throw new AnalyticsQueryError('a range must look like [7d] or [2026-10-01..2026-10-20]');
  }
  const from = rangeBound(bounds[0]!, false);
  const to = rangeBound(bounds[1]!, true);
  if (from < 0 || to > MAX_INSTANT_MS) throw new AnalyticsQueryError('range bounds must fall in 1970..9999');
  if (!(from < to)) throw new AnalyticsQueryError('a range must end after it starts');
  return { kind: 'absolute', from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function quoteValue(value: string): string {
  return /^[A-Za-z0-9_./:@+*?-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatBound(instant: string, end: boolean): string {
  const at = Date.parse(instant);
  if (at % DAY_MS !== 0) return new Date(at).toISOString();
  return new Date(end ? at - DAY_MS : at).toISOString().slice(0, 10);
}

/** The canonical range suffix, without the leading space. */
function formatRange(range: AnalyticsRange): string {
  if (range.kind === 'absolute') return `[${formatBound(range.from, false)}..${formatBound(range.to, true)}]`;
  const unit = CANONICAL_RANGE_UNITS.find(candidate => range.seconds % ANALYTICS_RANGE_UNIT_SECONDS[candidate] === 0);
  // `s` divides every whole number of seconds, so the find cannot miss; the fallback keeps it total.
  const chosen = unit ?? 's';
  return `[${range.seconds / ANALYTICS_RANGE_UNIT_SECONDS[chosen]}${chosen}]`;
}

/**
 * The one canonical spelling, written from parts WITHOUT checking them.
 *
 * Private, because unchecked parts can spell something the grammar refuses; the exported
 * `formatAnalyticsQuery` re-parses what this writes, so nothing outside can emit an invalid query.
 */
function emit(parts: AnalyticsQueryParts): string {
  const head =
    parts.aggregation === undefined
      ? (parts.metric ?? '')
      : parts.metric === undefined
        ? parts.aggregation
        : `${parts.aggregation}(${parts.metric})`;
  const grouping = parts.groupBy.length === 0 ? '' : ` by (${parts.groupBy.join(', ')})`;
  const filters =
    parts.matchers.length === 0
      ? ''
      : ` {${parts.matchers
          .map(matcher => {
            const operator = matcher.op === '=' && !matcher.wildcard && /[*?]/.test(matcher.value) ? '==' : matcher.op;
            return `${matcher.label}${operator}${quoteValue(matcher.value)}`;
          })
          .join(', ')}}`;
  const range = parts.range === undefined ? '' : ` ${formatRange(parts.range)}`;
  const written = `${head}${grouping}${filters}${range}`.trim();
  // Every session, raw, is `{}`: an empty string is not this query, it is the DEFAULT one.
  return written === '' ? '{}' : written;
}

/**
 * Write a query's one canonical spelling from its parts.
 *
 * For editors — a metric picker, range chips, group-by chips — that change a parsed query and must
 * hand back text. The result is re-parsed, so parts the grammar refuses (a `by` with no aggregation,
 * five grouping labels) raise `AnalyticsQueryError` here instead of producing a link that fails later.
 */
export function formatAnalyticsQuery(parts: AnalyticsQueryParts): string {
  return parseAnalyticsQuery(emit(parts)).canonical;
}

/** Force a query onto one exact session and expose the enforced scope canonically. */
export function scopeAnalyticsQuery(input: string | undefined, sessionId: string): string {
  // trim only gates an all-whitespace id; the exact bytes must survive into the mandatory matcher
  if (sessionId.trim() === '') throw new AnalyticsQueryError('session analytics scope needs an exact session id');
  const parsed = parseAnalyticsQuery((input ?? '').trim() || DEFAULT_SESSION_ANALYTICS_QUERY);
  return emit({
    ...parsed,
    matchers: [
      ...parsed.matchers.filter(matcher => matcher.label !== 'id'),
      { label: 'id', op: '=', value: sessionId, wildcard: false },
    ],
  });
}

/** A left-to-right reader over one query string. */
class Cursor {
  public index = 0;

  public constructor(public readonly source: string) {}

  public skipSpace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) this.index += 1;
  }

  public peek(): string | undefined {
    this.skipSpace();
    return this.source[this.index];
  }

  /** The identifier at the cursor, consumed, or `undefined` when there is none. */
  public word(): string | undefined {
    this.skipSpace();
    const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (match === null) return undefined;
    this.index += match[0].length;
    return match[0];
  }

  /** Whether the identifier at the cursor is `word` (case-insensitively), without consuming it. */
  public at(word: string): boolean {
    this.skipSpace();
    const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    return match !== null && match[0].toLowerCase() === word;
  }

  public rest(): string {
    return this.source.slice(this.index).trim();
  }
}

interface Body {
  matchers?: AnalyticsMatcher[];
  range?: AnalyticsRange;
}

/** `by (label, …)` at the cursor, consumed. */
function readGroupBy(cursor: Cursor): AnalyticsLabel[] {
  cursor.word();
  cursor.skipSpace();
  const grouping = cursor.source.slice(cursor.index).match(/^\(\s*([^)]*)\s*\)/);
  if (grouping === null) throw new AnalyticsQueryError('grouping must look like by (model, status)');
  cursor.index += grouping[0].length;
  return parseGroupBy(grouping[1]!);
}

/** An optional `{…}` selector and an optional `[…]` range at the cursor, into `body`. */
function readBody(cursor: Cursor, body: Body): void {
  if (cursor.peek() === '{') {
    if (body.matchers !== undefined) throw new AnalyticsQueryError('filters may be given once');
    const end = selectorEnd(cursor.source, cursor.index);
    body.matchers = parseMatchers(cursor.source.slice(cursor.index + 1, end));
    cursor.index = end + 1;
  }
  if (cursor.peek() === '[') {
    if (body.range !== undefined) throw new AnalyticsQueryError('a range may be given once');
    const end = cursor.source.indexOf(']', cursor.index);
    if (end === -1) throw new AnalyticsQueryError('unterminated range: expected ]');
    body.range = parseRange(cursor.source.slice(cursor.index + 1, end));
    cursor.index = end + 1;
  }
}

function readMetric(cursor: Cursor): AnalyticsMetric {
  const name = cursor.word();
  if (name === undefined || !metrics.has(name)) {
    throw new AnalyticsQueryError(
      `unknown analytics metric ${JSON.stringify(name ?? cursor.rest())} (choose ${ANALYTICS_METRICS.join(', ')})`,
    );
  }
  return name as AnalyticsMetric;
}

/**
 * Parse the bounded PromQL-like analytics query surface into pure data.
 *
 * Grammar (EBNF and every definition: docs/insights-query.md):
 *
 *   query  = [ head ] [ selector ] [ range ]
 *   head   = agg [ "(" metric ")" ] [ by ]       canonical: sum(cost_usd) by (model)
 *          | agg [ by ] "(" metric [ selector ] [ range ] ")" [ by ]     PromQL style
 *          | metric                               raw rows, sorted by the metric
 */
export function parseAnalyticsQuery(input?: string): ParsedAnalyticsQuery {
  const source = (input ?? '').trim() || DEFAULT_ANALYTICS_QUERY;
  if (source.length > MAX_ANALYTICS_QUERY_CHARS) {
    throw new AnalyticsQueryError(`analytics query exceeds ${MAX_ANALYTICS_QUERY_CHARS} characters`);
  }

  const cursor = new Cursor(source);
  let aggregation: AnalyticsAggregation | undefined;
  let metric: AnalyticsMetric | undefined;
  let groupBy: AnalyticsLabel[] = [];
  const body: Body = {};

  const head = cursor.peek() === '{' || cursor.peek() === '[' ? undefined : cursor.word();
  if (head !== undefined && aggregations.has(head.toLowerCase())) {
    aggregation = head.toLowerCase() as AnalyticsAggregation;
    if (cursor.at('by')) groupBy = readGroupBy(cursor);
    if (cursor.peek() === '(') {
      cursor.index += 1;
      metric = readMetric(cursor);
      readBody(cursor, body);
      if (cursor.peek() !== ')') throw new AnalyticsQueryError(`expected ) after ${aggregation}(${metric}`);
      cursor.index += 1;
    }
    if (cursor.at('by')) {
      if (groupBy.length > 0) throw new AnalyticsQueryError('by (...) may be given once');
      groupBy = readGroupBy(cursor);
    }
    if (metric !== undefined && ANALYTICS_RATIO_METRICS.has(metric) && aggregation !== 'sum' && aggregation !== 'avg') {
      throw new AnalyticsQueryError(`${metric} is a ratio of sums: use sum(${metric}) or avg(${metric})`);
    }
    if (aggregation === 'count' && metric !== undefined && metric !== 'sessions') {
      throw new AnalyticsQueryError('count counts sessions: write count or count(sessions)');
    }
  } else if (head !== undefined && head.toLowerCase() === 'by') {
    throw new AnalyticsQueryError('by (...) requires an aggregation');
  } else if (head !== undefined && metrics.has(head)) {
    metric = head as AnalyticsMetric;
    if (cursor.at('by')) throw new AnalyticsQueryError('by (...) requires an aggregation');
  } else if (head !== undefined) {
    throw new AnalyticsQueryError(
      `unknown analytics aggregation or metric ${JSON.stringify(head)} (choose ${ANALYTICS_AGGREGATIONS.join(', ')}, or a metric: ${ANALYTICS_METRICS.join(', ')})`,
    );
  }

  readBody(cursor, body);
  if (cursor.rest() !== '') {
    throw new AnalyticsQueryError(`unexpected analytics query suffix ${JSON.stringify(cursor.rest())}`);
  }

  const parts: ParsedAnalyticsQuery = {
    source,
    canonical: '',
    ...(aggregation === undefined ? {} : { aggregation }),
    ...(metric === undefined ? {} : { metric }),
    groupBy,
    matchers: body.matchers ?? [],
    ...(body.range === undefined ? {} : { range: body.range }),
  };
  const canonical = emit(parts);
  // Escaping can lengthen a value six-fold, and a canonical form the parser would refuse is not a
  // spelling of this query at all: every accepted query's canonical form must parse back.
  if (canonical.length > MAX_ANALYTICS_QUERY_CHARS) {
    throw new AnalyticsQueryError(
      `analytics query exceeds ${MAX_ANALYTICS_QUERY_CHARS} characters once written canonically`,
    );
  }
  return { ...parts, canonical };
}

/** Convert glob syntax to an escaped SQL LIKE pattern for the adapter. */
export function matcherLikePattern(value: string): string {
  let result = '';
  for (const char of value) {
    if (char === '*') result += '%';
    else if (char === '?') result += '_';
    else if (char === '%' || char === '_' || char === '\\') result += `\\${char}`;
    else result += char;
  }
  return result;
}

/**
 * Grammar-aware completion for the daemon's analytics query language.
 *
 * The vocabulary comes from the shared protocol schemas rather than a PWA
 * copy, so pairing to a newer daemon cannot make this UI suggest a query the
 * typed client would reject. This module is deliberately pure: cache and
 * transport ownership stay with the daemon-scoped analytics surface.
 */
import { AnalyticsAggregationSchema, AnalyticsLabelSchema, AnalyticsMetricSchema } from '@ferretry/protocol';

type AnalyticsCompletionKind = 'aggregation' | 'keyword' | 'label' | 'metric' | 'operator' | 'range' | 'value';
type AnalyticsCompletionContext =
  | 'aggregation'
  | 'clause'
  | 'grouping-label'
  | 'matcher-label'
  | 'matcher-value'
  | 'metric'
  | 'range';

export interface AnalyticsCompletion {
  readonly id: string;
  readonly kind: AnalyticsCompletionKind;
  readonly label: string;
  readonly detail?: string;
  readonly replacement: string;
  readonly group: string;
  readonly rankPriority: number;
}

interface AnalyticsTreeSuggestion {
  readonly id: string;
  readonly detail?: string;
}

export interface AnalyticsCompletionSources {
  readonly valuesFor?: (label: string) => readonly string[] | undefined;
  readonly treeIds?: readonly AnalyticsTreeSuggestion[];
}

export interface AnalyticsCompletionResult {
  readonly context: AnalyticsCompletionContext;
  readonly token: string;
  readonly replaceRange: { readonly start: number; readonly end: number };
  readonly candidates: readonly AnalyticsCompletion[];
  readonly pendingValueLabel?: string;
  readonly notice?: string;
}

const aggregations = AnalyticsAggregationSchema.options;
const labels = AnalyticsLabelSchema.options;
const metrics = AnalyticsMetricSchema.options;

/**
 * The ranges offered as one-click chips and as completions. These are choices, not the grammar: the
 * grammar is the protocol parser's, and the unit test parses every one of these with it.
 */
export const ANALYTICS_RANGE_PRESETS: readonly string[] = ['24h', '7d', '14d', '30d', '90d'];
const labelSet = new Set<string>(labels);
const valueLabels = new Set([
  'agent',
  'model',
  'context_window',
  'harness',
  'mode',
  'status',
  'label',
  'token_data',
  'day',
  'week',
  'runtime',
  'machine',
  'project',
]);
const maxGroupingLabels = 4;
const tokenCharacter = /[A-Za-z0-9_.:@+*?/-]/;
const priority: Record<AnalyticsCompletionKind, number> = {
  aggregation: 100,
  keyword: 80,
  metric: 70,
  range: 65,
  label: 60,
  operator: 40,
  value: 20,
};

const labelDetail: Partial<Record<(typeof labels)[number], string>> = {
  id: 'exact session id',
  agent: 'agent name',
  model: 'reported model',
  context_window: 'context window in tokens',
  harness: 'claude or codex',
  mode: 'auto, interactive, …',
  status: 'completed, failed, running, …',
  label: 'batch label',
  cwd: 'working directory',
  repo: 'working directory alias',
  parent: 'immediate parent session',
  tree: 'whole lineage subtree',
  day: 'UTC day bucket',
  week: 'UTC week bucket',
  token_data: 'whether token counters are complete',
  runtime: 'the runtime the session ran on',
  project: 'repository of the working directory',
  session: 'exact session id',
  machine: 'the machine that ran it',
};

const metricDetail: Record<(typeof metrics)[number], string> = {
  tokens: 'all tokens',
  tokens_input: 'input tokens, cache included',
  tokens_output: 'output tokens, reasoning included',
  tokens_cache_read: 'cached input read',
  tokens_cache_write: 'cached input written',
  tokens_reasoning: 'reasoning tokens',
  cost_usd: 'equivalent API cost in USD',
  cost_now_usd: "the same tokens at today's rates, in USD",
  turns: 'prompts answered',
  sessions: 'number of sessions',
  duration_active_seconds: 'time spent working a turn',
  duration_wall_seconds: 'session start to finish',
  duration_active_seconds_per_turn: 'active time per turn (sum or avg)',
};

const aggregationDetail: Record<(typeof aggregations)[number], string> = {
  sum: 'total across the group',
  avg: 'mean per session',
  min: 'smallest in the group',
  max: 'largest in the group',
  count: 'sessions only, no measures',
};

export const quoteAnalyticsValue = (value: string): string =>
  /^[A-Za-z0-9_./:@+*?-]+$/.test(value) ? value : JSON.stringify(value);

const makeCompletion = (
  kind: AnalyticsCompletionKind,
  label: string,
  replacement: string,
  group: string,
  detail?: string,
): AnalyticsCompletion => ({
  id: `${kind}:${label}`,
  kind,
  label,
  replacement,
  group,
  detail,
  rankPriority: priority[kind],
});

const fuzzyScore = (value: string, query: string): number => {
  let offset = 0;
  for (const character of query.toLowerCase()) {
    offset = value.toLowerCase().indexOf(character, offset);
    if (offset < 0) return 0;
    offset += 1;
  }
  return query.length;
};

export const rankAnalyticsCompletions = (
  candidates: readonly AnalyticsCompletion[],
  query: string,
  limit = 12,
): AnalyticsCompletion[] =>
  candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: query ? Math.max(fuzzyScore(candidate.label, query) * 3, fuzzyScore(candidate.detail ?? '', query)) : 1,
    }))
    .filter(item => item.score > 0)
    .sort(
      (left, right) =>
        right.candidate.rankPriority - left.candidate.rankPriority ||
        right.score - left.score ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(item => item.candidate);

interface Scan {
  bracketOpen: number;
  braceOpen: number;
  parenOpen: number;
  lastComma: number;
  quoted: boolean;
}

const scanBefore = (before: string): Scan => {
  let bracketOpen = -1,
    braceOpen = -1,
    parenOpen = -1,
    lastComma = -1;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < before.length; index += 1) {
    const character = before[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') {
      braceOpen = index;
      lastComma = -1;
    } else if (character === '}') braceOpen = -1;
    else if (character === '[') bracketOpen = index;
    else if (character === ']') bracketOpen = -1;
    else if (character === '(') {
      parenOpen = index;
      lastComma = -1;
    } else if (character === ')') parenOpen = -1;
    else if (character === ',') lastComma = index;
  }
  return { bracketOpen, braceOpen, parenOpen, lastComma, quoted: quote !== undefined };
};

const tokenRange = (text: string, caret: number, floor: number) => {
  let start = caret,
    end = caret;
  while (start > floor && tokenCharacter.test(text[start - 1]!)) start -= 1;
  while (end < text.length && tokenCharacter.test(text[end]!)) end += 1;
  return { start, end };
};

const labelCandidates = (
  group: string,
  suffix: (label: string) => string,
  excluded = new Set<string>(),
): AnalyticsCompletion[] =>
  labels
    .filter(label => !excluded.has(label))
    .map(label => makeCompletion('label', label, suffix(label), group, labelDetail[label]));

const valueCandidates = (label: string, sources: AnalyticsCompletionSources) => {
  if (label === 'tree') {
    const ids = sources.treeIds ?? [];
    return ids.length
      ? {
          candidates: ids.map(entry =>
            makeCompletion('value', entry.id, quoteAnalyticsValue(entry.id), 'Sessions', entry.detail),
          ),
        }
      : { candidates: [], notice: 'tree filters take one exact session id.' };
  }
  if (!valueLabels.has(label))
    return { candidates: [], notice: `${label} values are unbounded; type an exact value or a glob.` };
  const values = sources.valuesFor?.(label);
  return values === undefined
    ? { candidates: [], pendingValueLabel: label }
    : { candidates: values.map(value => makeCompletion('value', value, quoteAnalyticsValue(value), 'Values')) };
};

export function analyticsCompletions(
  text: string,
  caret: number,
  sources: AnalyticsCompletionSources = {},
): AnalyticsCompletionResult {
  const position = Math.max(0, Math.min(text.length, Math.trunc(caret)));
  const before = text.slice(0, position);
  const scan = scanBefore(before);
  if (scan.quoted)
    return {
      context: 'matcher-value',
      token: '',
      replaceRange: { start: position, end: position },
      candidates: [],
      notice: 'Close the quote to continue.',
    };
  if (scan.bracketOpen >= 0 && scan.braceOpen < 0) {
    const range = tokenRange(text, position, scan.bracketOpen + 1);
    const token = text.slice(range.start, position);
    return {
      context: 'range',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        ANALYTICS_RANGE_PRESETS.map(preset =>
          makeCompletion('range', preset, `${preset}]`, 'Ranges', `the last ${preset}`),
        ),
        token,
      ),
      notice: 'or an absolute range, 2026-10-01..2026-10-20',
    };
  }
  if (scan.braceOpen >= 0) {
    const segmentStart = Math.max(scan.braceOpen, scan.lastComma) + 1;
    const segment = before.slice(segmentStart);
    const matcher = segment.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)(=~|=)(\s*)/);
    if (matcher) {
      const range = tokenRange(text, position, segmentStart + matcher[0].length);
      const token = text.slice(range.start, position);
      if (matcher[2] === 'tree' && matcher[4] === '=~')
        return {
          context: 'matcher-value',
          token,
          replaceRange: range,
          candidates: [],
          notice: 'tree filters take one exact session id — use tree= instead of tree=~.',
        };
      const values = valueCandidates(matcher[2]!, sources);
      return {
        context: 'matcher-value',
        token,
        replaceRange: range,
        candidates: rankAnalyticsCompletions(values.candidates, token),
        pendingValueLabel: values.pendingValueLabel,
        notice: values.notice,
      };
    }
    const range = tokenRange(text, position, segmentStart);
    const token = text.slice(range.start, position);
    const operators = labelSet.has(token)
      ? [
          makeCompletion('operator', `${token}=`, `${token}=`, 'Operators', 'exact match'),
          ...(token === 'tree'
            ? []
            : [makeCompletion('operator', `${token}=~`, `${token}=~`, 'Operators', 'case-insensitive glob')]),
        ]
      : [];
    return {
      context: 'matcher-label',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions([...labelCandidates('Labels', label => `${label}=`), ...operators], token),
    };
  }
  if (scan.parenOpen >= 0 && /\b(?:sum|avg|min|max|count)\s*$/i.test(before.slice(0, scan.parenOpen))) {
    const range = tokenRange(text, position, scan.parenOpen + 1);
    const token = text.slice(range.start, position);
    return {
      context: 'metric',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        metrics.map(name => makeCompletion('metric', name, `${name})`, 'Metrics', metricDetail[name])),
        token,
        metrics.length,
      ),
    };
  }
  if (scan.parenOpen >= 0 && /\bby\s*$/i.test(before.slice(0, scan.parenOpen))) {
    const segmentStart = Math.max(scan.parenOpen, scan.lastComma) + 1;
    const range = tokenRange(text, position, segmentStart);
    const token = text.slice(range.start, position);
    const listed = before
      .slice(scan.parenOpen + 1)
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    const used = new Set(token ? listed.slice(0, -1) : listed);
    if (used.size >= maxGroupingLabels)
      return {
        context: 'grouping-label',
        token,
        replaceRange: range,
        candidates: [],
        notice: `at most ${maxGroupingLabels} grouping labels are allowed`,
      };
    return {
      context: 'grouping-label',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        labelCandidates('Group by', label => label, used),
        token,
      ),
    };
  }
  const range = tokenRange(text, position, 0);
  const token = text.slice(range.start, position);
  const head = before.slice(0, range.start).match(/^\s*([A-Za-z]+)\b/);
  if (!head || !aggregations.includes(head[1]!.toLowerCase() as (typeof aggregations)[number])) {
    return {
      context: 'aggregation',
      token,
      replaceRange: range,
      candidates: rankAnalyticsCompletions(
        [
          ...aggregations.map(name =>
            makeCompletion('aggregation', name, `${name} `, 'Aggregations', aggregationDetail[name]),
          ),
          makeCompletion('keyword', '{', '{', 'Filters', 'raw rows for a filter'),
          ...labelCandidates('Filters', label => `{${label}=`),
        ],
        token,
      ),
    };
  }
  const grouped = /\bby\s*\(/i.test(before);
  const withMetric = /^\s*[A-Za-z]+\s*\(/.test(before);
  const ranged = before.includes('[');
  return {
    context: 'clause',
    token,
    replaceRange: range,
    candidates: rankAnalyticsCompletions(
      [
        ...(withMetric ? [] : [makeCompletion('keyword', '(', '(', 'Metric', 'pick the quantity to aggregate')]),
        ...(grouped ? [] : [makeCompletion('keyword', 'by', 'by (', 'Grouping', 'group the result by labels')]),
        ...(ranged ? [] : [makeCompletion('keyword', '[', '[', 'Range', 'only recent sessions, e.g. [7d]')]),
        makeCompletion('keyword', '{', '{', 'Filters', 'restrict the matched sessions'),
        ...labelCandidates('Filters', label => `{${label}=`),
      ],
      token,
    ),
  };
}

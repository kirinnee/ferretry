/**
 * The analytics ledger is intentionally a table, not a dashboard: a reader can
 * sort exact daemon-supplied aggregates without losing unknown prices or making
 * the surrounding pane scroll sideways on a phone.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp } from 'lucide-react';
import type { AnalyticsAggregateResult, AnalyticsMeasure, AnalyticsResponse } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';

export type AnalyticsSortKey =
  | 'group'
  | 'sessions'
  | 'input'
  | 'output'
  | 'cacheRead'
  | 'cacheWrite'
  | 'total'
  | 'cost';
export type AnalyticsSortDirection = 'asc' | 'desc';
export type AnalyticsAggregateResponse = Extract<AnalyticsResponse, { readonly kind: 'aggregate' }>;

export interface AnalyticsTableRow {
  readonly key: string;
  readonly group: string;
  readonly sessions: number;
  readonly input: AnalyticsMeasure;
  readonly output: AnalyticsMeasure;
  readonly cacheRead: AnalyticsMeasure;
  readonly cacheWrite: AnalyticsMeasure;
  readonly total: AnalyticsMeasure;
  readonly cost: AnalyticsMeasure;
}

interface Column {
  readonly key: AnalyticsSortKey;
  readonly header: string;
  readonly hint?: string;
  readonly numeric: boolean;
}

export const ANALYTICS_TABLE_COLUMNS: readonly Column[] = [
  { key: 'group', header: 'Group', numeric: false },
  { key: 'sessions', header: 'Sessions', numeric: true },
  { key: 'input', header: 'Input', hint: 'gross input, including cache reads and writes', numeric: true },
  { key: 'output', header: 'Output', numeric: true },
  { key: 'cacheRead', header: 'Cache read', numeric: true },
  { key: 'cacheWrite', header: 'Cache write', numeric: true },
  { key: 'total', header: 'Total', numeric: true },
  { key: 'cost', header: 'Equivalent API cost', numeric: true },
];

const UNKNOWN_MEASURE: AnalyticsMeasure = { value: null, known: 0, total: 0 };
const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

const groupName = (result: AnalyticsAggregateResult): string => {
  const parts = Object.entries(result.labels).map(([key, value]) => `${key}=${value ?? 'unknown'}`);
  return parts.join(' · ') || 'All sessions';
};

/** Flattens a daemon response without inventing a value for missing pricing. */
export const analyticsTableRows = (response: AnalyticsAggregateResponse): AnalyticsTableRow[] =>
  response.results.map((result, index) => ({
    key: `${index}:${groupName(result)}`,
    group: groupName(result),
    sessions: result.sessions,
    input: result.inputTokens,
    output: result.outputTokens,
    cacheRead: result.cachedInputTokens,
    cacheWrite: result.cacheWriteInputTokens,
    total: result.tokens,
    cost: result.equivalentApiCostUsdMicros,
  }));

const measureFor = (row: AnalyticsTableRow, key: AnalyticsSortKey): AnalyticsMeasure | undefined =>
  key === 'group' || key === 'sessions' ? undefined : row[key];

/** Unknown numeric values remain last in either order; they are never zero. */
export const sortAnalyticsRows = (
  rows: readonly AnalyticsTableRow[],
  key: AnalyticsSortKey,
  direction: AnalyticsSortDirection,
): AnalyticsTableRow[] => {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      if (key === 'group') return sign * left.row.group.localeCompare(right.row.group) || left.index - right.index;
      const a = key === 'sessions' ? left.row.sessions : (measureFor(left.row, key)?.value ?? null);
      const b = key === 'sessions' ? right.row.sessions : (measureFor(right.row, key)?.value ?? null);
      if (a === null && b === null) return left.index - right.index;
      if (a === null) return 1;
      if (b === null) return -1;
      return sign * (a - b) || left.index - right.index;
    })
    .map(item => item.row);
};

const sumMeasures = (measures: readonly AnalyticsMeasure[]): AnalyticsMeasure => {
  let value: number | null = 0;
  let known = 0;
  let total = 0;
  for (const measure of measures) {
    known += measure.known;
    total += measure.total;
    if (value !== null && (measure.value === null || measure.known !== measure.total)) value = null;
    else if (value !== null && measure.value !== null) value += measure.value;
  }
  return { value, known, total };
};

/** A roll-up is honest only when every group contributed a complete measure. */
export const analyticsTotalRow = (rows: readonly AnalyticsTableRow[]): AnalyticsTableRow => ({
  key: 'total',
  group: 'Total',
  sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
  input: sumMeasures(rows.map(row => row.input)),
  output: sumMeasures(rows.map(row => row.output)),
  cacheRead: sumMeasures(rows.map(row => row.cacheRead)),
  cacheWrite: sumMeasures(rows.map(row => row.cacheWrite)),
  total: sumMeasures(rows.map(row => row.total)),
  cost: sumMeasures(rows.map(row => row.cost)),
});

export const formatTokenMeasure = (measure: AnalyticsMeasure | undefined): string =>
  measure?.value === null || measure === undefined ? '—' : NUMBER_FORMAT.format(measure.value);

/** Whole dollars and fractional micros are formatted without a floating dollar value. */
export const formatUsdMicros = (value: bigint): string => {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '').padEnd(2, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${fraction}`;
};

export const formatEquivalentCost = (measure: AnalyticsMeasure | undefined): string =>
  measure?.value === null || measure === undefined
    ? 'Cost unknown'
    : formatUsdMicros(BigInt(Math.round(measure.value)));

export const coverageNote = (measure: AnalyticsMeasure | undefined): string | undefined => {
  const resolved = measure ?? UNKNOWN_MEASURE;
  return resolved.value === null && resolved.total > 0 ? `${resolved.known}/${resolved.total}` : undefined;
};

export const analyticsColumnsFor = (aggregation: AnalyticsAggregateResponse['aggregation']): readonly Column[] =>
  aggregation === 'count'
    ? ANALYTICS_TABLE_COLUMNS.filter(column => column.key === 'group' || column.key === 'sessions')
    : ANALYTICS_TABLE_COLUMNS;

export const defaultAnalyticsSort = (aggregation: AnalyticsAggregateResponse['aggregation']) =>
  aggregation === 'count'
    ? ({ key: 'sessions', direction: 'desc' } as const)
    : ({ key: 'cost', direction: 'desc' } as const);

const nextDirection = (column: AnalyticsSortKey, current: AnalyticsSortKey, direction: AnalyticsSortDirection) =>
  column !== current ? (column === 'group' ? 'asc' : 'desc') : direction === 'desc' ? 'asc' : 'desc';

function MeasureCell({ measure, cost = false }: { readonly measure: AnalyticsMeasure; readonly cost?: boolean }) {
  const coverage = coverageNote(measure);
  return (
    <td className="whitespace-nowrap px-cell-x py-row-y text-right font-mono tabular-nums text-fg">
      <span className={cost && measure.value !== null ? 'font-semibold' : undefined}>
        {cost ? formatEquivalentCost(measure) : formatTokenMeasure(measure)}
      </span>
      {coverage && (
        <span className="ml-1 text-2xs text-faint" title={`known for ${coverage} sessions`}>
          [{coverage}]
        </span>
      )}
    </td>
  );
}

function Row({
  row,
  columns,
  emphasis = false,
}: {
  readonly row: AnalyticsTableRow;
  readonly columns: readonly Column[];
  readonly emphasis?: boolean;
}) {
  return (
    <tr className={cn('kt-row', emphasis && 'border-t border-border font-semibold')}>
      {columns.map(column => {
        if (column.key === 'group')
          return (
            <th
              key={column.key}
              scope="row"
              className="sticky left-0 z-10 max-w-[16rem] truncate bg-surface px-cell-x py-row-y text-left font-normal text-fg"
              title={row.group}
            >
              {row.group}
            </th>
          );
        if (column.key === 'sessions')
          return (
            <td
              key={column.key}
              className="whitespace-nowrap px-cell-x py-row-y text-right font-mono tabular-nums text-muted"
            >
              {NUMBER_FORMAT.format(row.sessions)}
            </td>
          );
        return <MeasureCell key={column.key} measure={row[column.key]} cost={column.key === 'cost'} />;
      })}
    </tr>
  );
}

export interface AnalyticsResultTableProps {
  readonly response: AnalyticsAggregateResponse;
  readonly caption?: string;
}

/** A responsive, sortable aggregate ledger from one daemon-bound response. */
export function AnalyticsResultTable({ response, caption = 'Analytics aggregate result' }: AnalyticsResultTableProps) {
  const [sort, setSort] = useState<{ key: AnalyticsSortKey; direction: AnalyticsSortDirection } | null>(null);
  const columns = analyticsColumnsFor(response.aggregation);
  const activeSort =
    sort && columns.some(column => column.key === sort.key) ? sort : defaultAnalyticsSort(response.aggregation);
  const rows = useMemo(() => analyticsTableRows(response), [response]);
  const sorted = useMemo(
    () => sortAnalyticsRows(rows, activeSort.key, activeSort.direction),
    [activeSort.direction, activeSort.key, rows],
  );
  const total = response.aggregation === 'sum' && rows.length > 1 ? analyticsTotalRow(rows) : null;

  if (rows.length === 0)
    return (
      <p className="m-0 text-cell text-muted" role="status">
        No groups matched. Nothing was assumed to be zero.
      </p>
    );

  return (
    <div className="grid min-w-0 gap-2">
      <div className="kt-panel min-w-0 max-w-full overflow-x-auto overscroll-x-contain scroll-thin">
        <table className="w-full min-w-[44rem] border-collapse text-cell">
          <caption className="sr-only">
            {caption}. Sorted by {columns.find(column => column.key === activeSort.key)?.header}{' '}
            {activeSort.direction === 'desc' ? 'descending' : 'ascending'}.
          </caption>
          <thead>
            <tr>
              {columns.map(column => {
                const active = column.key === activeSort.key;
                const direction = nextDirection(column.key, activeSort.key, activeSort.direction);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (activeSort.direction === 'desc' ? 'descending' : 'ascending') : 'none'}
                    className={cn(
                      'kt-label border-b border-border bg-surface-2 p-0',
                      column.key === 'group' && 'sticky left-0 z-20',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSort({ key: column.key, direction })}
                      title={column.hint}
                      aria-label={`${column.header}: sort ${direction === 'desc' ? 'descending' : 'ascending'}`}
                      className={cn(
                        'flex min-h-[44px] w-full items-center gap-1 whitespace-nowrap px-cell-x py-row-y',
                        column.numeric ? 'justify-end text-right' : 'justify-start text-left',
                        active ? 'text-accent' : 'text-muted hover:text-fg',
                      )}
                    >
                      {column.header}
                      {active ? (
                        activeSort.direction === 'desc' ? (
                          <ArrowDown size={12} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={12} aria-hidden="true" />
                        )
                      ) : (
                        <ArrowDownUp size={12} className="opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <Row key={row.key} row={row} columns={columns} />
            ))}
          </tbody>
          {total && (
            <tfoot>
              <Row row={total} columns={columns} emphasis />
            </tfoot>
          )}
        </table>
      </div>
      {columns.some(column => column.key === 'cost') && (
        <p className="m-0 text-2xs leading-base text-faint">
          Equivalent API cost is a comparison from the daemon's historical pricing snapshot, not a billing claim. Input
          is gross and includes cache reads and writes; unpriced models remain visible as cost unknown.
        </p>
      )}
    </div>
  );
}

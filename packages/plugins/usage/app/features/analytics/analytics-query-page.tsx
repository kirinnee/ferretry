/**
 * INSIGHTS › QUERY — ask the ledger any question in the insights query language.
 *
 * The page is one editor (text box plus helpers that rewrite the text), the answer as a chart and a
 * table, the reader's saved queries and a handful of examples. The text is the source of truth: the
 * link a query is run from carries it (`onQueryChange`, mirrored into `?q=` by the shell), a saved query
 * is that text under a name, and nothing is parsed here — the protocol grammar owns that.
 *
 * Everything below the frame is keyed by the daemon, so switching daemons mounts a fresh body and a late
 * answer from the previous one cannot reach the screen.
 */

import type { AnalyticsResponse } from '../../../contract/index.ts';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@ferretry/app/ui';
import { browserClock, type DaemonConnection, daemonFerretPath, type UsageClient } from '../../shell.ts';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Segmented } from '../../shell/segmented.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import { ANALYTICS_QUERY_DEFAULT, AnalyticsQueryEditor, type AnalyticsRequest } from './analytics-custom-query.tsx';
import { AnalyticsFleetError, asSentence, type FleetAnswer, type MachineFailure } from './analytics-fanout.ts';
import { ANALYTICS_QUERY_EXAMPLES } from './analytics-query-examples.ts';
import { readAnalyticsQuery } from './analytics-query-text.ts';
import { type QueryView, type TrendBucket, trendPlan } from './analytics-query-trend.ts';
import { queryViewPreference } from './analytics-query-view-preference.ts';
import { AnalyticsResponseView, analyticsErrorMessage } from './analytics-response-view.tsx';
import {
  addSavedQuery,
  browserSavedQueriesStorage,
  loadSavedQueries,
  persistSavedQueries,
  removeSavedQuery,
  type SavedAnalyticsQuery,
  type SavedQueriesStorage,
} from './analytics-saved-queries.ts';

export interface AnalyticsQueryPageProps {
  readonly connection: DaemonConnection;
  /** This daemon's client; the default reads go through it. */
  readonly client: UsageClient;
  /** Every connected machine; only said in the caption — fan-out belongs to `requestRun`. */
  readonly connections?: readonly DaemonConnection[];
  /** Reads one answer, for value suggestions; injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: AnalyticsRequest;
  /**
   * Runs the query the reader asked: one answer, the machines missing from it and where each session
   * lives. Defaults to asking `requestAnalytics` on this machine alone.
   */
  readonly requestRun?: (query: string | undefined) => Promise<FleetAnswer>;
  /**
   * The zone the requests were made in. A change re-runs the answer on screen, so the days it shows are
   * never the old zone's.
   */
  readonly timeZone?: string;
  /** The clock "ran at" reads. */
  readonly now?: () => Date;
  /** A query handed in by a link; it is run at once. */
  readonly initialQuery?: string | null;
  /** Called with the canonical query after each run, so the shell can mirror it into `?q=`. */
  readonly onQueryChange?: (query: string) => void;
  /** Injectable browser storage for saved queries. */
  readonly savedStorage?: SavedQueriesStorage;
}

const newId = (): string => globalThis.crypto.randomUUID();

export function AnalyticsQueryPage({
  connection,
  client,
  connections,
  requestAnalytics: injected,
  requestRun: injectedRun,
  timeZone,
  now,
  initialQuery,
  onQueryChange,
  savedStorage,
}: AnalyticsQueryPageProps) {
  const requestAnalytics = useMemo<AnalyticsRequest>(
    () => injected ?? ((_daemon, query) => fetchAnalytics(client, query, timeZone)),
    [client, injected, timeZone],
  );
  const requestRun = useMemo(
    () =>
      injectedRun ??
      (async (query: string | undefined): Promise<FleetAnswer> => ({
        response: await requestAnalytics(connection, query),
        failed: [],
        daemonOf: () => connection.daemonId,
      })),
    [connection, injectedRun, requestAnalytics],
  );
  return (
    <main
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      aria-label="Insights query"
      data-daemon={connection.daemonId}
    >
      <QueryBody
        key={connection.daemonId}
        connection={connection}
        machines={connections?.length ?? 1}
        requestAnalytics={requestAnalytics}
        requestRun={requestRun}
        timeZone={timeZone}
        now={now ?? browserClock.now}
        initialQuery={initialQuery ?? null}
        onQueryChange={onQueryChange}
        savedStorage={savedStorage}
      />
    </main>
  );
}

function QueryBody({
  connection,
  machines,
  requestAnalytics,
  requestRun,
  timeZone,
  now,
  initialQuery,
  onQueryChange,
  savedStorage,
}: {
  readonly connection: DaemonConnection;
  readonly machines: number;
  readonly requestAnalytics: AnalyticsRequest;
  readonly requestRun: (query: string | undefined) => Promise<FleetAnswer>;
  readonly timeZone: string | undefined;
  readonly now: () => Date;
  readonly initialQuery: string | null;
  readonly onQueryChange: ((query: string) => void) | undefined;
  readonly savedStorage: SavedQueriesStorage | undefined;
}) {
  const [text, setText] = useState(initialQuery || ANALYTICS_QUERY_DEFAULT);
  // The result, the machines missing from it and where its sessions live are ONE value, set together
  // under the run's serial, so a banner can never describe a different run than the result it sits on.
  const [answer, setAnswer] = useState<FleetAnswer | null>(null);
  // The run's failure: one sentence, or — when several machines all refused — each machine's own reason.
  const [error, setError] = useState<RunFailure | null>(null);
  const [querying, setQuerying] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);
  // One result, or the same question day by day. Kept on this device; the bucket is per visit.
  const view = queryViewPreference.use();
  const [bucket, setBucket] = useState<TrendBucket>('day');
  // Why there is no trend of the text, and the window a trend added; neither is a failed query.
  const [trendNote, setTrendNote] = useState<string | null>(null);
  const [trendRefusal, setTrendRefusal] = useState<string | null>(null);
  const serial = useRef(0);
  const lastResult = useRef<AnalyticsResponse | null>(null);
  /**
   * The text last SUBMITTED (not whatever is being typed), noted before its answer is awaited, so a zone
   * change asks it again even while the first run is still pending. Null until something is run.
   */
  const submitted = useRef<string | null>(null);
  // The same text as state, so the result controls follow the query a rerun asks, never the draft.
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const run = useCallback(
    async (source: string, automatic = false) => {
      const mine = ++serial.current;
      // What was submitted (not what is being typed) is what a zone, view or bucket change asks again.
      submitted.current = source;
      setSubmittedText(source);
      setError(null);
      const plan = view === 'trend' ? trendPlan(source, bucket) : null;
      if (plan !== null && !plan.ok) {
        setAnswer(null);
        setTrendNote(null);
        setTrendRefusal(plan.reason);
        setQuerying(false);
        return;
      }
      setTrendRefusal(null);
      setTrendNote(
        plan?.ok && plan.addedRange !== undefined
          ? `No range was given, so this trend covers the last ${plan.addedRange}. Add a range such as [90d] to change it.`
          : null,
      );
      setQuerying(true);
      try {
        const fleet = await requestRun((plan?.query ?? source).trim() || undefined);
        if (mine !== serial.current) return;
        const response = fleet.response;
        lastResult.current = response;
        // A trend asks a DERIVED query; the editor keeps the reader's own, in its canonical spelling.
        const read = plan === null ? null : readAnalyticsQuery(source);
        const shown = read?.ok ? read.parsed.canonical : plan === null ? response.query : source;
        // A rerun the reader did not ask for (view, bucket, zone) never overwrites a draft they are still typing.
        if (!automatic || textRef.current === source) setText(shown);
        submitted.current = shown;
        setSubmittedText(shown);
        setAnswer(fleet);
        setRanAt(now().toISOString().slice(11, 16));
        onQueryChange?.(shown);
      } catch (reason) {
        if (mine === serial.current) {
          setAnswer(null);
          setError(runFailure(reason));
        }
      } finally {
        if (mine === serial.current) setQuerying(false);
      }
    },
    [bucket, now, onQueryChange, requestRun, view],
  );

  // A link's query runs once, when it arrives — not again each time `run` is rebuilt.
  const runLatest = useRef(run);
  runLatest.current = run;
  useEffect(() => {
    if (initialQuery) void runLatest.current(initialQuery);
    return () => {
      serial.current += 1;
    };
  }, [initialQuery]);

  // A new zone changes what every day in the answer means, and a new view or bucket changes the question
  // itself, so the answer on screen is asked again. The first render is not a change, and a page that has
  // run nothing has nothing to refresh.
  const shown = `${timeZone ?? ''}|${view}|${bucket}`;
  const shownRef = useRef(shown);
  useEffect(() => {
    if (shownRef.current === shown) return;
    shownRef.current = shown;
    if (submitted.current !== null) void runLatest.current(submitted.current, true);
  }, [shown]);

  // The controls describe the submitted query (what reruns ask), not the draft being typed.
  const trend = view === 'trend' ? trendPlan(submittedText ?? text, bucket) : null;

  const runText = useCallback(
    (source: string) => {
      setText(source);
      void run(source);
    },
    [run],
  );

  const loadValues = useCallback(
    async (label: string): Promise<readonly string[]> => {
      const response = (lastResult.current?.parsed.groupBy as readonly string[] | undefined)?.includes(label)
        ? lastResult.current
        : await requestAnalytics(connection, `count by (${label})`);
      if (response?.kind !== 'aggregate') return [];
      return [
        ...new Set(
          response.results
            .map(row => row.labels[label])
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
        ),
      ].sort();
    },
    [connection, requestAnalytics],
  );

  return (
    <div className={`${INSIGHTS_COLUMN_CLASS} grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 pb-8 pt-3`}>
      <p className="m-0 text-meta text-muted">
        Ask any question of the session ledger · {machines > 1 ? `across ${machines} machines` : 'this machine'}
      </p>

      <AnalyticsQueryEditor
        value={text}
        onValueChange={setText}
        onRun={() => void run(text)}
        querying={querying}
        loadValues={loadValues}
      />

      <ResultView
        view={view}
        onView={queryViewPreference.write}
        // The plan is the source of truth for the bucket: a time label the query already names wins.
        bucket={trend?.ok ? trend.bucket : bucket}
        fixed={trend?.ok === true && trend.fixed}
        onBucket={setBucket}
      />

      <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-4" data-analytics-query-result="">
        {querying && (
          <p role="status" className="m-0 py-3 text-cell text-muted">
            Running the query…
          </p>
        )}
        {error && <RunFailureNotice failure={error} />}
        {trendRefusal && (
          <p role="status" className="m-0 text-cell text-muted" data-analytics-trend-refusal="">
            {trendRefusal}
          </p>
        )}
        {!querying && !error && !answer && !trendRefusal && (
          <p className="m-0 text-cell text-muted">Run a query, or start from an example below.</p>
        )}
        {answer && (
          <>
            {trendNote && (
              <p className="m-0 text-meta text-muted" data-analytics-trend-note="">
                {trendNote}
              </p>
            )}
            <MissingMachines failed={answer.failed} />
            <AnalyticsResponseView
              response={answer.response}
              chart
              sessionHref={row => daemonFerretPath(answer.daemonOf(row.id) ?? connection.daemonId, row.id)}
            />
            {ranAt && <p className="m-0 text-2xs text-faint">Ran at {ranAt} UTC</p>}
          </>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 sm:grid-cols-2">
        <SavedQueries text={text} onRun={runText} storage={savedStorage} />
        <Examples onRun={runText} />
      </div>
    </div>
  );
}

/** Why a run has no result: one reason, or every machine's when more than one was asked and none answered. */
type RunFailure =
  | { readonly kind: 'one'; readonly message: string }
  | { readonly kind: 'every'; readonly failed: readonly MachineFailure[] };

const runFailure = (reason: unknown): RunFailure =>
  reason instanceof AnalyticsFleetError && reason.failed.length > 1
    ? { kind: 'every', failed: reason.failed }
    : { kind: 'one', message: analyticsErrorMessage(reason) };

/**
 * A run no machine answered, said so a person can act on it: with several machines, EACH ONE NAMED with
 * its own reason. Showing only the first machine's reason hid a readable refusal behind another
 * machine's bare 500 (B149).
 */
function RunFailureNotice({ failure }: { readonly failure: RunFailure }) {
  const box = 'm-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-cell text-err';
  if (failure.kind === 'one')
    return (
      <p role="alert" className={box}>
        The query failed: {failure.message}
      </p>
    );
  return (
    <div role="alert" className={`${box} grid gap-xs`} data-analytics-run-failed="">
      <p className="m-0">The query failed on every machine:</p>
      <ul className="m-0 grid list-disc gap-xs pl-5">
        {failure.failed.map(outcome => (
          <li key={outcome.machine.connection.daemonId} className="break-words">
            {outcome.machine.name}: {asSentence(outcome.error)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIEW_OPTIONS = [
  { id: 'single', label: 'Single', title: 'One result for the whole query' },
  { id: 'trend', label: 'Trend', title: 'The same result over time' },
] as const satisfies readonly { readonly id: QueryView; readonly label: string; readonly title: string }[];

const BUCKET_OPTIONS = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
] as const satisfies readonly { readonly id: TrendBucket; readonly label: string }[];

/** Single result or trend; a trend also says how finely it is cut. Choosing re-asks the answer on screen. */
function ResultView({
  view,
  onView,
  bucket,
  fixed,
  onBucket,
}: {
  readonly view: QueryView;
  readonly onView: (view: QueryView) => void;
  readonly bucket: TrendBucket;
  /** The query itself groups by this bucket, so the other choice is not on offer. */
  readonly fixed: boolean;
  readonly onBucket: (bucket: TrendBucket) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-md gap-y-sm" data-analytics-result-view="">
      <div className="w-44">
        <Segmented<QueryView>
          label="Result view"
          name="analytics-result-view"
          options={VIEW_OPTIONS}
          value={view}
          onChoose={onView}
        />
      </div>
      {view === 'trend' && (
        <>
          <div className="w-44">
            <Segmented<TrendBucket>
              label="Trend bucket"
              name="analytics-trend-bucket"
              options={BUCKET_OPTIONS.map(option => ({
                ...option,
                ...(fixed && option.id !== bucket
                  ? { disabled: true, title: `The query groups by ${bucket} itself` }
                  : {}),
              }))}
              value={bucket}
              onChoose={onBucket}
            />
          </div>
          {fixed && (
            <p className="m-0 text-meta text-muted" data-analytics-bucket-locked="">
              The query groups by {bucket} itself.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The machines a result leaves out, named under it — never a silent zero for them. */
function MissingMachines({ failed }: { readonly failed: readonly MachineFailure[] }) {
  if (failed.length === 0) return null;
  return (
    <ul role="status" className="m-0 grid list-none gap-xs p-0 text-meta text-warn" data-analytics-failed="">
      {failed.map(outcome => (
        <li key={outcome.machine.connection.daemonId}>
          {outcome.machine.name} did not answer: {asSentence(outcome.error)} Its sessions are not in this result.
        </li>
      ))}
    </ul>
  );
}

function SavedQueries({
  text,
  onRun,
  storage,
}: {
  readonly text: string;
  readonly onRun: (query: string) => void;
  readonly storage: SavedQueriesStorage | undefined;
}) {
  const nameId = useId();
  const store = useMemo(() => storage ?? browserSavedQueriesStorage(), [storage]);
  const [saved, setSaved] = useState<readonly SavedAnalyticsQuery[]>(() => loadSavedQueries(store));
  const [name, setName] = useState('');
  const [kept, setKept] = useState(true);
  const valid = readAnalyticsQuery(text).ok && text.trim() !== '' && name.trim() !== '';

  const commit = (next: readonly SavedAnalyticsQuery[]) => {
    setSaved(next);
    setKept(persistSavedQueries(store, next));
  };

  return (
    <section
      aria-labelledby={`${nameId}-title`}
      className="kt-panel grid min-w-0 content-start gap-3 p-3"
      data-analytics-saved=""
    >
      <h3 id={`${nameId}-title`} className="m-0 text-cell font-semibold text-fg">
        Saved queries
      </h3>
      <form
        className="flex min-w-0 gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (!valid) return;
          commit(addSavedQuery(saved, name, text, newId));
          setName('');
        }}
      >
        <label htmlFor={nameId} className="sr-only">
          Name for the current query
        </label>
        <input
          id={nameId}
          className="kt-input min-h-[44px] min-w-0 flex-1"
          value={name}
          maxLength={80}
          placeholder="Name this query"
          onChange={event => setName(event.currentTarget.value)}
        />
        <Button type="submit" variant="outline" disabled={!valid} className="min-h-[44px] shrink-0">
          Save
        </Button>
      </form>
      {!kept && (
        <p role="status" className="m-0 text-2xs text-warn">
          This browser would not keep the list; it lasts until the page closes.
        </p>
      )}
      {saved.length === 0 ? (
        <p className="m-0 text-cell text-muted">Nothing saved yet. Name the query above and save it.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {saved.map(item => (
            <li key={item.id} className="flex min-w-0 items-center gap-2" data-analytics-saved-item={item.name}>
              <button
                type="button"
                onClick={() => onRun(item.query)}
                className="grid min-h-[44px] min-w-0 flex-1 content-center text-left"
                title={item.query}
              >
                <span className="truncate text-cell font-medium text-fg">{item.name}</span>
                <span className="mono truncate text-2xs text-muted">{item.query}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete saved query ${item.name}`}
                onClick={() => commit(removeSavedQuery(saved, item.id))}
                className="kt-btn kt-btn--sm min-h-[44px] min-w-[44px] shrink-0 text-muted"
                data-variant="ghost"
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Examples({ onRun }: { readonly onRun: (query: string) => void }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="kt-panel grid min-w-0 content-start gap-2 p-3"
      data-analytics-examples=""
    >
      <h3 id={titleId} className="m-0 text-cell font-semibold text-fg">
        Examples
      </h3>
      <ul className="m-0 grid list-none gap-1 p-0">
        {ANALYTICS_QUERY_EXAMPLES.map(example => (
          <li key={example.id}>
            <button
              type="button"
              onClick={() => onRun(example.query)}
              title={example.hint}
              className="grid min-h-[44px] w-full min-w-0 content-center text-left"
            >
              <span className="truncate text-cell font-medium text-fg">{example.title}</span>
              <span className="mono truncate text-2xs text-muted">{example.query}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

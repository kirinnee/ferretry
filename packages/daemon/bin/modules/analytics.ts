import type { ModelCatalog } from '@ferretry/fleet';
import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import {
  HttpAnalyticsPricingFeed,
  readAnalyticsTranscriptEvidence,
  WorkerTranscriptFolds,
} from '../../src/adapters/analytics/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  type ActivityLedger,
  ANALYTICS_BACKSTOP_MS,
  type AnalyticsIngestCandidate,
  type AnalyticsIngestCandidateSource,
  AnalyticsIngestionService,
  type AnalyticsTranscriptEvidenceSource,
  type AnalyticsTranscriptFoldSource,
  type ClockPort,
  effectiveAnalyticsPricing,
  modelCatalogPricingRates,
  type OpenedAnalyticsIndexStore,
  parseSessionId,
  PassTrigger,
  type PassTriggerTimers,
  type SerialExecutor,
  type SessionId,
  TERMINAL_ANALYTICS_STATUSES,
  type TranscriptFileResolver,
  type TranscriptSource,
} from '../../src/lib/index.ts';
import {
  type AnalyticsPricingConfigurationPort,
  AnalyticsPricingService,
} from '../../src/lib/analytics/pricing-service.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { analyticsContribution } from '../../src/lib/runtime/mounts/analytics.ts';

/**
 * Analytics: the fleet-wide spend read, the operator's rate catalog and the ingestion that materialises both.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries: the opened store arrives as a need, because `start()` opens it under the state
 * home's lock and releases it with the boot's other acquisitions) and no releases: the transcript-fold worker and
 * the state-write listener were never released, and still are not.
 *
 * ONE JOB, armed by `start()`: the ingestion's trigger, whose `arm()` returns its disarm synchronously. Its first
 * pass is queued on the housekeeping lane by `start()`, as it always was.
 */

/**
 * How many finished sessions may have their transcripts folded at once.
 *
 * Small on purpose. Each read is individually bounded, so the risk is never one enormous file — it
 * is a fleet's worth of bounded reads resident at the same instant.
 */
const ANALYTICS_FOLD_CONCURRENCY = 4;

/**
 * How many transcripts one ingestion pass may read; the rest wait for the catch-up pass, a minute later.
 *
 * A rebuild used to read every finished transcript in one pass, every boot — on a large Mac fleet,
 * hundreds of megabytes parsed while the daemon was trying to answer its first requests.
 */
const ANALYTICS_READS_PER_PASS = 8;

/**
 * One-shot timers for a {@link PassTrigger}, fired OUTSIDE every activity: the timer is armed by the pass
 * before, and would otherwise count the next pass inside it. Unreferenced, so a pending pass never holds
 * the process open.
 */
function outsideActivityTimers(activities: ActivityLedger | undefined): PassTriggerTimers {
  return {
    setTimeout: (callback, ms) => {
      const handle = setTimeout(() => (activities === undefined ? callback() : activities.outside(callback)), ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Every session the daemon holds durable documents for, as ingestion candidates.
 *
 * IT DOES NOT DECIDE ANYTHING. No gate, no fold, no pricing: it parses the two documents and hands
 * over what they say, including whether they say a session ended. Pre-filtering here would put a
 * second, unstated copy of the terminal-state rule in the composition root, where nothing tests it.
 *
 * Both documents are PARSED, and a session whose pair does not parse is left out entirely rather than
 * contributed with holes: an analytics row assembled from a config the schema rejected is a row whose
 * provenance nobody can state.
 */
function createAnalyticsCandidateSource(storage: DaemonStorage): AnalyticsIngestCandidateSource {
  const candidate = async (id: SessionId): Promise<AnalyticsIngestCandidate | undefined> => {
    const [rawConfig, rawState] = await Promise.all([storage.readConfig(id), storage.readState(id)]);
    const config = SessionConfigSchema.safeParse(rawConfig);
    const state = SessionStateSchema.safeParse(rawState);
    if (!config.success || !state.success) return undefined;
    return {
      id,
      transcriptHarness: config.data.harness === 'codex' ? 'codex' : 'claude',
      agent: config.data.agent,
      // The SELECTED model only. `observedModel` is transcript evidence, and the record's own
      // contract forbids substituting it for what the operator asked for.
      selectedModel: config.data.model ?? null,
      contextWindow: state.data.contextWindow ?? null,
      harness: config.data.harness,
      mode: config.data.mode,
      label: config.data.label ?? null,
      cwd: config.data.cwd,
      parent: config.data.parent ?? null,
      createdAt: config.data.createdAt,
      startedAt: state.data.startedAt ?? null,
      finishedAt: state.data.finishedAt ?? null,
      status: state.data.status,
      // Time-to-first-output is transcript evidence the daemon does not index; a launch instant is
      // not an output, so reporting one here would mismeasure every session.
      firstOutputAt: null,
      turns: state.data.turn,
      contextEndPercent: state.data.contextPercent ?? null,
      migrated: config.data.migration !== undefined,
    };
  };
  return {
    // Finished sessions the archive took out of the list keep the rows ingested when they ended; one never ingested is read on demand.
    archived: () => storage.listArchivedSessions().map(session => session.id),
    candidate: async id => await candidate(parseSessionId(id)),
    listCandidates: async () => {
      // Read in bounded batches rather than all at once. Each document read is small, but a fleet with
      // hundreds of sessions would hold every one of them resident under an unbounded `Promise.all`.
      //
      // FROM THE INDEX FIRST. Its status is written with every state document, and a session it says is
      // still running is one the gate refuses anyway — so only an ended session, or one whose status the
      // index does not know, has its two documents read and parsed.
      const ids = storage
        .listSessions()
        .filter(
          session =>
            session.status === undefined || (TERMINAL_ANALYTICS_STATUSES as ReadonlySet<string>).has(session.status),
        )
        .map(session => session.id);
      const candidates: AnalyticsIngestCandidate[] = [];
      for (let start = 0; start < ids.length; start += ANALYTICS_FOLD_CONCURRENCY) {
        const batch = await Promise.all(ids.slice(start, start + ANALYTICS_FOLD_CONCURRENCY).map(id => candidate(id)));
        candidates.push(...batch.filter((entry): entry is AnalyticsIngestCandidate => entry !== undefined));
      }
      return candidates;
    },
  };
}

/**
 * Analytics ingestion, over this daemon's own state home.
 *
 * WHY INGESTION EXISTS AT ALL. The read used to derive everything per request — every session's
 * documents parsed and its whole transcript folded, on every question — so the cost of one query grew
 * with the entire history of the fleet, and nothing richer could be built on top of it. A session is
 * now folded and priced ONCE, when it reaches a durable terminal state, and the query reads the result.
 *
 * THE STORE IS THIS DAEMON'S ALONE. It lives under this state home, and the file records the home it
 * was built for; a copied or restored index naming another home is discarded on open rather than
 * served, because one daemon's spend reported as another's is a wrong answer, not a stale one.
 *
 * THE PRICING CATALOG is this daemon's validated operator rates laid over the list prices the model
 * catalogs in effect carry (docs/model-catalog.md § Prices), read per pass, so an operator's edit or a
 * newer published catalog takes effect on the next ingestion — and, because the catalog's fingerprint
 * is part of every row's ingest signature, re-prices the rows it changes. An operator rate wins for its
 * whole model. A model neither prices stays `unpriced` with a reason — the honest answer; a zero would
 * read as free.
 */
function createAnalyticsIngestion(
  storage: DaemonStorage,
  opened: OpenedAnalyticsIndexStore,
  pricingConfiguration: AnalyticsPricingConfigurationPort,
  modelCatalogs: () => Promise<Readonly<Record<string, ModelCatalog>>>,
  evidence: AnalyticsTranscriptEvidenceSource,
  folds: AnalyticsTranscriptFoldSource,
  clock: ClockPort,
  activities: ActivityLedger | undefined,
): AnalyticsIngestionService {
  return new AnalyticsIngestionService({
    candidates: createAnalyticsCandidateSource(storage),
    evidence,
    folds,
    store: opened.store,
    pricing: async () => {
      const read = await pricingConfiguration.readPricing();
      if (read.kind === 'unavailable') throw new Error(`analytics ingestion refused because ${read.message}`);
      return effectiveAnalyticsPricing(read.configuration.catalog, await modelCatalogs());
    },
    clock,
    concurrency: ANALYTICS_FOLD_CONCURRENCY,
    readsPerPass: ANALYTICS_READS_PER_PASS,
    rebuildRequired: opened.rebuildRequired,
    trigger: new PassTrigger({
      backstopMs: ANALYTICS_BACKSTOP_MS,
      timers: outsideActivityTimers(activities),
      now: () => performance.now(),
    }),
  });
}

/**
 * A finished session's whole transcript, read once, for the analytics token total.
 *
 * It is a SEPARATE read from the session transcript tail because the two want opposite things:
 * a tail wants the last few events and does not care what it skipped, while a bill has to account
 * for every request the session made. This one therefore reports how the read ENDED — the issues
 * raised and the bytes still pending — so the fold can refuse a total it cannot prove complete
 * instead of returning a smaller number that looks like a cheaper session.
 *
 * The parsed events are NOT retained. The subsystem memoizes the small folded total instead, so a
 * transcript's bytes live only as long as the fold that consumes them; holding the event list per
 * session is how a daemon with a busy fleet runs itself out of memory.
 */
function createAnalyticsTranscriptEvidence(
  resolver: TranscriptFileResolver,
  transcriptSources: readonly TranscriptSource[],
): AnalyticsTranscriptEvidenceSource {
  return {
    evidenceFor: async (sessionId, harness) => {
      const file = await resolver.file(sessionId).catch(() => undefined);
      if (file === undefined) return { kind: 'unresolved' };
      const source = transcriptSources.find(candidate => candidate.harness === harness);
      if (source === undefined) return { kind: 'unreadable' };
      return await readAnalyticsTranscriptEvidence(source, file, sessionId, harness);
    },
  };
}

/** What the analytics module is built from. */
export interface AnalyticsNeeds {
  /** The storage this boot opened. */
  readonly storage: DaemonStorage;
  /** The analytics materialization, opened by `start()` under the state home's lock. */
  readonly analyticsStore: OpenedAnalyticsIndexStore;
  /** The daemon's configuration document, as far as the operator's rates: read and written through it. */
  readonly config: AnalyticsPricingConfigurationPort;
  /** The serial executor every write to that document goes through. */
  readonly configMutations: SerialExecutor;
  /**
   * The model catalogs in effect, for their list prices. Read lazily: the catalog service is built after this
   * module, and nothing prices a session before the subsystems mount.
   */
  readonly modelCatalogs: () => Promise<Readonly<Record<string, ModelCatalog>>>;
  /** A session's own transcript resolver, per opened storage; asked once for the fold and once for the evidence. */
  readonly transcriptFiles: () => TranscriptFileResolver;
  readonly transcriptSources: readonly TranscriptSource[];
  readonly clock: ClockPort;
  readonly activities: ActivityLedger | undefined;
  /** The name this machine is known by, stamped on analytics rows as the `machine` label. */
  readonly machineName: () => string | null;
}

/** What other code uses of analytics. */
export interface AnalyticsProvides {
  /** ONE ingestion service for this opened store, shared by the loop that writes rows and the route that reads them. */
  readonly ingestion: AnalyticsIngestionService;
  /** The operator's rates; a write through it re-prices what it moved at the next pass. */
  readonly pricing: AnalyticsPricingService;
  /** Read and folded on a worker thread: held so a performance profile can sample how many folds the thread holds. */
  readonly folds: WorkerTranscriptFolds;
}

/** What `start()` arms. `arm` keeps the ingestion trigger's own signature: synchronous, returning the disarm. */
export interface AnalyticsJobs {
  readonly arm: (due: () => void) => () => void;
}

export const analyticsModule: DaemonModule<void, AnalyticsNeeds, AnalyticsProvides, AnalyticsJobs> = {
  id: 'analytics',
  build: needs => {
    const { storage, analyticsStore, config, configMutations, modelCatalogs, clock, activities } = needs;
    // ONE ingestion service for this opened store, shared by the loop that writes rows and the route
    // that reads them. Two would each hold their own account of whether a pass is in flight, and the
    // read would report `refreshing: false` while the loop was mid-pass.
    // Read and folded on a worker thread: the event loop only resolves which file to read. Held here
    // so a performance profile can sample how many folds the thread holds.
    const transcriptFolds = new WorkerTranscriptFolds(
      (
        resolver => async (sessionId: string) =>
          await resolver.file(sessionId)
      )(needs.transcriptFiles()),
    );
    const analyticsIngestion = createAnalyticsIngestion(
      storage,
      analyticsStore,
      config,
      modelCatalogs,
      createAnalyticsTranscriptEvidence(needs.transcriptFiles(), needs.transcriptSources),
      transcriptFolds,
      clock,
      activities,
    );
    // A session that ends — or a revived one the index still holds — is what moves analytics, and
    // storage says so as it writes (docs/design/housekeeping-worker.md §4 PR 4). For as long as the
    // storage is open: closing it drops every listener, this one included.
    storage.subscribeStates((id, state) => analyticsIngestion.stateWritten(id, state));
    const analyticsPricing = new AnalyticsPricingService(
      // The operator's rates: a write through here re-prices what it moved at the next pass.
      {
        readPricing: async () => await config.readPricing(),
        writePricing: async input => {
          const written = await config.writePricing(input);
          analyticsIngestion.pricingChanged();
          return written;
        },
      },
      new HttpAnalyticsPricingFeed(),
      configMutations,
      clock,
      { next: () => crypto.randomUUID() },
      { modelCatalogRates: async () => modelCatalogPricingRates(await modelCatalogs()) },
    );
    return {
      id: 'analytics',
      provides: { ingestion: analyticsIngestion, pricing: analyticsPricing, folds: transcriptFolds },
      // A lambda, not `ingestion.arm.bind(...)`: the trigger is looked up at the moment `start()` arms it.
      jobs: { arm: due => analyticsIngestion.arm(due) },
      contributes: analyticsContribution(
        { index: () => analyticsIngestion.read(), machine: needs.machineName },
        analyticsPricing,
      ),
    };
  },
};

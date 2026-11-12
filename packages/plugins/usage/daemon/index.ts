import type { FerretId, FerretSummary } from '@ferretry/core-ferrets/contract';
import { ferretOf } from '@ferretry/core-gate/contract';
import { type ApiResponse, errorResponse, jsonResponse, textResponse } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { LoginId } from '@ferretry/plugin-logins/contract';
import { type Instant, instantFromEpochMs, milliseconds } from '@ferretry/std';
import { platform } from 'node:os';
import manifest from '../manifest.ts';
import {
  BudgetReached,
  type BudgetsView,
  INSIGHTS_STATE,
  LoginIdSchema,
  InsightsChanged,
  LoginPaused,
  LoginResumed,
  type LoginPause,
  type Pause,
  pausePhrase,
  QUOTAS_STATE,
  USAGE_CONFIG,
  type UsageFeedView,
  type UsageAccountView,
} from '../contract/index.ts';
import { FerretBudgetSessions, PausesStore, ToldStore } from './adapters/budget/ports.ts';
import { HttpAnalyticsPricingFeed } from './adapters/analytics/pricing-feed-source.ts';
import { openAnalyticsIndexStore } from './adapters/analytics/sqlite-analytics-store.ts';
import { StatePricingConfiguration } from './adapters/pricing/pricing-state.ts';
import { CachedUsageFeed } from './adapters/usage/cached-usage-feed.ts';
import { AnalyticsTranscriptSpend } from './adapters/usage/provider-quota/analytics-spend.ts';
import { effectiveAnalyticsPricing } from './lib/analytics/model-catalog-rates.ts';
import { AnalyticsIngestionService, type AnalyticsIngestCandidate } from './lib/analytics/ingestion.ts';
import { type AnalyticsPricingRate, snapshotAnalyticsUsagePricing } from './lib/analytics/pricing.ts';
import { AnalyticsPricingService } from './lib/analytics/pricing-service.ts';
import { foldAnalyticsTurns } from './lib/analytics/turn-fold.ts';
import { BudgetService, type BudgetNotice } from './lib/budget/service.ts';
import { SpendMeter } from './lib/budget/meter.ts';
import { budgetAlternative, budgetedLogins } from './lib/budget/state.ts';
import { budgetNoticeText } from './lib/budget/notice.ts';
import { serialExecutor, type TurnUsageSource } from './lib/ports.ts';
import { PerformanceProfiler, type ProcessReading } from './lib/performance/profiler.ts';
import { PerformanceRecorder } from './lib/performance/recorder.ts';
import { IDLE_DAEMON_BUDGETS } from './lib/performance/budgets.ts';
import {
  CredentialUsageSource,
  providerQuotaLogins,
  ProviderQuotaService,
  renderUsageMetrics,
  type UsageFeedPort,
  WatchedUsageFeed,
  unattendedUsageFeed,
} from './lib/usage/index.ts';
import { performanceHandlers } from './routes/performance.ts';
import { pricingHandlers } from './routes/pricing.ts';
import { insightsAnswer, insightsForPort } from './routes/insights.ts';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** How often the budgets are measured. */
const BUDGET_TICK = milliseconds(60_000);
/** The slow backstop under the ingestion trigger: a pass is also owed after any turn that ended. */
const INGEST_BACKSTOP = milliseconds(15 * 60_000);
/** How long after a turn ended its ferret's last records are settled enough to read once. */
const INGEST_SETTLE_MS = 30_000;

const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The terminal status the insights index records for a stopped ferret, from how its last turn ended. */
const STATUS_OF_OUTCOME = { completed: 'completed', interrupted: 'stopped', failed: 'failed' } as const;

/** The tighter of the two windows' headroom, in percent. */
function headroomOf(row: UsageAccountView | undefined): number | undefined {
  if (row === undefined) return undefined;
  const used = [row.fiveHourPercent, row.weeklyPercent].filter((value): value is number => value !== undefined);
  return used.length === 0 ? undefined : Math.max(0, 100 - Math.max(...used));
}

/**
 * Usage (§2.3): what each login spent and has left, and a pause at the owner's budget.
 *
 * NOTHING HERE SPENDS A FERRET. A pause is read by `start.decide` (a refusal that names the reset). The only ferrets Usage
 * ever stops are those on a login past its HARD limit, through Ferrets' own stop. The provider's key is never held, and
 * Usage does not need the Vault and cannot name a secret: a quota read names a LOGIN (Logins' `authorizeFetch`), and
 * Logins resolves the key from that login's own record and has the Vault place it on one request to an allowlisted host.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs }) {
    const nowMs = (): number => kernel.clock.nowMs();

    // ── what a ferret's harness says it spent ────────────────────────────────────────────────────────────────────────
    // Ferrets owns which harness a ferret runs and reads that harness's usage (token counts only, never transcript text).
    // `undefined` is PARTIAL (an unknown ferret, a harness that is off, a reader that threw): an unreadable ferret is
    // never counted as a free one.
    const turnUsage: TurnUsageSource = {
      turns: async (ferret, since) => await needs.ferrets.turnUsage(ferret as FerretId, since as Instant | undefined),
    };

    // ── pricing: the owner's rate catalog, plus list prices once Logins publishes them whole ──────────────────────────────
    const pricingConfiguration = new StatePricingConfiguration(kernel.state);
    const catalogRates = async (): Promise<readonly AnalyticsPricingRate[]> => [];
    const pricingFeed = new HttpAnalyticsPricingFeed({
      fetcher: async (url, init) => await kernel.fetch.request(url, init),
      scheduleTimeout: (onTimeout, timeoutMs) => kernel.clock.after(milliseconds(timeoutMs), onTimeout),
    });
    const pricing = new AnalyticsPricingService(
      pricingConfiguration,
      pricingFeed,
      serialExecutor(),
      { now: () => kernel.clock.now() },
      { next: () => kernel.ids.mint('preview') },
      { modelCatalogRates: catalogRates },
    );
    const effectiveRates = async (): Promise<readonly AnalyticsPricingRate[]> => {
      const read = await pricingConfiguration.readPricing();
      if (read.kind !== 'read') throw new Error(read.message);
      return effectiveAnalyticsPricing(read.configuration.catalog, await catalogRates());
    };

    // ── insights: one row per stopped ferret, in a cache the kernel drops and the daemon rebuilds ─────────────────────────
    const opened = openAnalyticsIndexStore(kernel.state.sqlite(INSIGHTS_STATE));
    const outcomes = new Map<string, 'completed' | 'interrupted' | 'failed'>();
    const candidateOf = (ferret: FerretSummary): AnalyticsIngestCandidate => ({
      id: ferret.id,
      agent: ferret.login ?? null,
      selectedModel: null,
      harness: ferret.harness,
      mode: ferret.role,
      label: ferret.name,
      cwd: ferret.folder,
      parent: ferret.parent ?? null,
      createdAt: ferret.createdAt,
      finishedAt: ferret.state === 'stopped' ? ferret.stateAt : null,
      status: ferret.state === 'stopped' ? STATUS_OF_OUTCOME[outcomes.get(ferret.id) ?? 'interrupted'] : 'running',
    });
    let ingestSoon: (() => void) | undefined;
    const ingestion = new AnalyticsIngestionService({
      candidates: { listCandidates: async () => (await needs.ferrets.list()).map(candidateOf) },
      folds: {
        foldFor: async (ferret, aliasGroups) =>
          foldAnalyticsTurns(await turnUsage.turns(ferret).catch(() => undefined), aliasGroups),
      },
      store: opened.store,
      pricing: effectiveRates,
      clock: { now: () => kernel.clock.now() },
      concurrency: 2,
      readsPerPass: 200,
      rebuildRequired: opened.rebuildRequired,
      trigger: {
        nudge: delayMs => {
          kernel.clock.after(milliseconds(delayMs), () => ingestSoon?.());
        },
      },
    });

    // ── budgets: measured each minute from each ferret's turns; a pause is a hold on a login ───────────────────────────────
    const sessions = new FerretBudgetSessions(needs.ferrets);
    const pauses = new PausesStore(kernel.state);
    const told = new ToldStore(kernel.state);
    const meter = new SpendMeter({
      ferrets: async sinceMs => await sessions.metered(sinceMs),
      turns: async (ferret, sinceIso) => await turnUsage.turns(ferret, sinceIso),
      pricing: async () => {
        const rates = await effectiveRates();
        return usage => {
          const snapshot = snapshotAnalyticsUsagePricing(usage, rates);
          return snapshot.kind === 'priced' ? snapshot.equivalentApiCostUsdMicros : undefined;
        };
      },
    });
    let published: Readonly<Record<string, Pause>> = {};
    let pauseRecordDamaged = false;
    const budget = new BudgetService({
      config: async () => {
        const file = kernel.config.file(USAGE_CONFIG);
        return {
          ...(file?.timeZone === undefined ? {} : { timeZone: file.timeZone }),
          logins: budgetedLogins(file?.budgets ?? {}),
        };
      },
      hostTimeZone,
      meter,
      nowMs,
      republish: async () => {
        const holds = budget.holds();
        for (const [login, pause] of Object.entries(holds)) {
          if (published[login]?.level !== pause.level)
            kernel.events.publish(LoginPaused, { login, level: pause.level, period: pause.period });
        }
        for (const login of Object.keys(published))
          if (holds[login] === undefined) kernel.events.publish(LoginResumed, { login });
        published = holds;
      },
      liveSessions: async logins => await sessions.live(logins),
      stop: async session => await sessions.stop(session),
      recentSession: async logins => await sessions.recent(logins),
      alternative: async (login, holds) => {
        const list = await needs.logins.list().catch(() => undefined);
        const current = list?.logins.find(candidate => candidate.id === login);
        const usable = list?.logins.filter(
          candidate => candidate.disabled === undefined && candidate.harness === current?.harness,
        );
        return budgetAlternative(usable?.map(candidate => candidate.id) ?? [], login, nowMs(), holds);
      },
      notify: async (notice: BudgetNotice) => {
        const text = budgetNoticeText(
          notice,
          'fy',
          (await needs.logins.list().catch(() => undefined))?.machine ?? 'this machine',
        );
        kernel.events.publish(BudgetReached, {
          ref: text.ref,
          login: notice.login,
          period: notice.period,
          ferret: notice.anchor.id,
          title: text.title,
          summary: text.summary,
          body: text.body,
        });
      },
      remember: async holds => {
        await pauses.write(holds);
        pauseRecordDamaged = false;
      },
      told,
    });

    // ── quotas: read only while somebody watches, at most once a minute per login, through the Vault ──────────────────────
    const quota = new ProviderQuotaService({
      logins: async () => providerQuotaLogins(await needs.logins.list(), await needs.logins.presets()),
      authorizer: {
        send: async (loginId, variable, hosts, request, placement) =>
          await needs.logins.authorizeFetch(loginId as LoginId, variable, hosts, request, placement),
      },
      spend: new AnalyticsTranscriptSpend(ingestion),
      clock: { nowMs },
    });

    // ── the feed: one reading per daemon, shared by every reader ───────────────────────────────────────────────────────────
    const inner = new CachedUsageFeed(
      [
        new CredentialUsageSource({
          enabled: async () => true,
          credentials: async () => (await needs.logins.list()).logins,
        }),
      ],
      { now: nowMs },
    );
    const feed: UsageFeedPort = new WatchedUsageFeed(inner, () => quota);
    const feedView = async (port: UsageFeedPort): Promise<UsageFeedView> => {
      let accounts: readonly import('../contract/index.ts').AccountUsage[] | undefined;
      try {
        accounts = await port.accounts();
      } catch {
        accounts = undefined;
      }
      const at = port.snapshotAt();
      const rows = accounts ?? [];
      return {
        ...(at === undefined ? {} : { at: instantFromEpochMs(at) }),
        stale: at === undefined,
        accounts: rows.map(({ ok: _ok, ...row }) => ({
          ...row,
          ...(row.retryAt === null ? { retryAt: undefined } : {}),
        })) as UsageAccountView[],
      };
    };
    const snapshotOf = async (port: UsageFeedPort) => {
      try {
        const accounts = await port.accounts();
        const at = port.snapshotAt();
        return at === undefined ? undefined : { at, accounts };
      } catch {
        return undefined;
      }
    };
    const scraped = unattendedUsageFeed(feed);

    // ── performance: a window onto the daemon's own counters ───────────────────────────────────────────────────────────────
    const recorder = new PerformanceRecorder();
    const profiler = new PerformanceProfiler({
      recorder,
      gauges: {
        read: async (): Promise<ProcessReading> => {
          const cpu = process.cpuUsage();
          const memory = process.memoryUsage();
          const resource = process.resourceUsage();
          return {
            cpuUserMicros: cpu.user,
            cpuSystemMicros: cpu.system,
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            voluntaryContextSwitches: resource.voluntaryContextSwitches,
            involuntaryContextSwitches: resource.involuntaryContextSwitches,
          };
        },
      },
      workers: [],
      clock: { now: nowMs },
      timers: {
        every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
        after: (delayMs, fire) => kernel.clock.after(milliseconds(delayMs), fire),
      },
      context: {
        daemon: { version: manifest.version, platform: platform(), arch: process.arch, runtime: 'bun' },
        uptimeSeconds: () => Math.round(process.uptime()),
        fleet: async () => {
          const all = await needs.ferrets.list().catch(() => undefined);
          return all === undefined
            ? undefined
            : { sessions: all.length, running: all.filter(ferret => ferret.state !== 'stopped').length };
        },
        limitations: () => [
          'The kernel does not yet hand Usage the routes, child processes, file operations or event-loop stalls it sees, so this report holds the process counters and the sampled work only.',
        ],
      },
      budgets: IDLE_DAEMON_BUDGETS,
      newId: () => kernel.ids.mint('profile'),
    });
    const performance = performanceHandlers({
      start: seconds => profiler.start(seconds),
      view: id => profiler.view(id),
    });
    const pricingRoutes = pricingHandlers(pricing);

    // ── the view others read ───────────────────────────────────────────────────────────────────────────────────────────────
    const pauseOf = (login: string): LoginPause | undefined => {
      const pause = budget.holds()[login];
      const id = LoginIdSchema.safeParse(login);
      return pause === undefined || !id.success ? undefined : { login: id.data, pause, phrase: pausePhrase(pause) };
    };
    const budgetsView = (): BudgetsView => ({
      budgets: Object.keys(kernel.config.file(USAGE_CONFIG)?.budgets ?? {}).flatMap(name => {
        const standing = budget.view(name);
        const pause = pauseOf(name);
        const login = LoginIdSchema.safeParse(name);
        return standing === undefined || !login.success
          ? []
          : [{ login: login.data, budget: standing, ...(pause === undefined ? {} : { pause }) }];
      }),
    });

    // ── jobs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
    kernel.jobs.add({
      id: 'usage-restore',
      schedule: { onceAfterStart: true },
      run: async () => {
        try {
          budget.restore(await pauses.read());
        } catch {
          // A damaged record of pauses reads as "unknown", never "none": starts on a budgeted login wait for one measure.
          pauseRecordDamaged = true;
        }
      },
    });
    kernel.jobs.add({
      id: 'usage-budget',
      schedule: { every: BUDGET_TICK },
      after: ['usage-restore'],
      run: async () => await budget.tick(),
    });
    // A budget edit applies now, not at the next minute: the config loading is the trigger today too.
    kernel.config.watch(USAGE_CONFIG, () => kernel.jobs.kick('usage-budget'));
    kernel.jobs.add({
      id: 'usage-ingest',
      schedule: { every: INGEST_BACKSTOP },
      run: async () => {
        await ingestion.ingest();
        kernel.events.publish(InsightsChanged, {});
      },
    });
    ingestSoon = () => kernel.jobs.kick('usage-ingest');

    const publicFeed = (): boolean => kernel.config.file(USAGE_CONFIG)?.publicFeed === true;
    const unrouted = (method: string, path: string): ApiResponse =>
      errorResponse(404, `There is no ${method} ${path}.`, 'not_found');

    return {
      routes: {
        'GET /usage': async call =>
          publicFeed()
            ? jsonResponse(
                await (async () => {
                  const snapshot = await snapshotOf(scraped);
                  return { at: snapshot?.at ?? 0, ready: snapshot !== undefined, accounts: snapshot?.accounts ?? [] };
                })(),
              )
            : unrouted(call.request.method, call.request.path),
        'GET /metrics': async call =>
          publicFeed()
            ? textResponse(renderUsageMetrics(await snapshotOf(scraped), nowMs()), 200, PROMETHEUS_CONTENT_TYPE)
            : unrouted(call.request.method, call.request.path),
        // The app polls this while a quota is on screen: somebody is looking, so a due provider quota may be read.
        'GET /v1/usage': async () => jsonResponse(await feedView(feed)),
        'GET /v1/usage/budgets': async () => jsonResponse(budgetsView()),
        // The owner and a person read the whole fleet; a FERRET reads its own lineage only (itself and its helpers, the
        // same `mayTouch` rule Ferrets applies to every other per-ferret read). The caller is the standing Gate admitted,
        // never a header or a query value.
        'GET /v1/usage/insights': async call => {
          const caller = ferretOf(call);
          return insightsAnswer(
            { index: () => ingestion.read() },
            call.request,
            (await needs.logins.list().catch(() => undefined))?.machine ?? null,
            caller === undefined
              ? undefined
              : { mayRead: ferret => needs.ferrets.mayTouch(caller, ferret as FerretId) },
          );
        },
        'GET /v1/usage/pricing': async () => await pricingRoutes.view(),
        'PATCH /v1/usage/pricing': async call => await pricingRoutes.patch(call.request),
        'POST /v1/usage/pricing/sync/preview': async call => await pricingRoutes.preview(call.request),
        'POST /v1/usage/pricing/sync/apply': async call => await pricingRoutes.apply(call.request),
        'POST /v1/diagnostics/profile': async call => await performance.start(call.request),
        'GET /v1/diagnostics/profile/:id': async call => await performance.read(call.params),
      },
      provides: {
        usage: {
          headroomPercent: async login => headroomOf((await feedView(feed)).accounts.find(row => row.agent === login)),
          feed: async read => await feedView(read.watched ? feed : scraped),
          pauses: () => Object.keys(budget.holds()).flatMap(login => pauseOf(login) ?? []),
          pauseOf: login => pauseOf(login),
          budgets: async () => budgetsView(),
          quota: async login => {
            const live = quota.peek(login);
            if (live !== undefined) return live;
            const stored = await kernel.state.read(QUOTAS_STATE, login);
            return stored.ok ? stored.value?.reading : undefined;
          },
          insights: async request =>
            insightsForPort(
              { index: () => ingestion.read() },
              request,
              (await needs.logins.list().catch(() => undefined))?.machine ?? null,
            ),
          pricing: async () => await pricing.view(),
          patchPricing: async patch => await pricing.patch(patch),
          previewPricing: async request => await pricing.preview(request),
          applyPricing: async request => await pricing.apply(request),
          startProfile: seconds => profiler.start(seconds),
          profile: id => profiler.view(id),
        },
      },
      hooks: {
        // A pause refuses a NEW start on its login with the sentence that names the reset. A start naming no login is
        // allowed here: Ferrets picks the login and asks again. A damaged record of pauses refuses a budgeted login's
        // start until one tick has measured, never reads as "nothing paused".
        'start.decide': input => {
          const login = input.login;
          if (login === undefined) return { allow: true };
          const pause = budget.holds()[login];
          if (pause !== undefined) return { allow: false, reason: `login "${login}" is paused: ${pausePhrase(pause)}` };
          if (pauseRecordDamaged && kernel.config.file(USAGE_CONFIG)?.budgets?.[login] !== undefined) {
            return {
              allow: false,
              reason: `login "${login}" has a budget and the record of pauses is damaged; it is measured again within a minute`,
            };
          }
          return { allow: true };
        },
        // A turn ended: its ferret may now be finished, so a pass is owed after the records settle.
        'turn.ended': payload => {
          outcomes.set(payload.ferret, payload.outcome);
          kernel.clock.after(milliseconds(INGEST_SETTLE_MS), () => ingestSoon?.());
        },
      },
    };
  },
});

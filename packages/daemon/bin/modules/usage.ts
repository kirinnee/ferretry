import { join } from 'node:path';
import type { FleetManifest } from '@ferretry/fleet';
import { manifestRuntimes, wrapperNameOf } from '@ferretry/fleet';
import { AnalyticsTranscriptSpend, asActivity } from '../../src/adapters/index.ts';
import {
  type BudgetStorage,
  budgetHoldsWriter,
  claudeSubagentFiles,
  FileBudgetTold,
  readBudgetHoldsSync,
  StorageBudgetSessions,
} from '../../src/adapters/budget/ports.ts';
import { sessionStatusOf } from '../../src/adapters/fleet/account-model-files.ts';
import type { MachineAgenda } from '../../src/lib/agenda/machine-agenda.ts';
import { snapshotAnalyticsUsagePricing } from '../../src/lib/analytics/pricing.ts';
import type { AnalyticsPricingConfigurationRead } from '../../src/lib/analytics/pricing-service.ts';
import { type MeteredFile, SpendMeter } from '../../src/lib/budget/meter.ts';
import { budgetNoticeRef, budgetNoticeRequest } from '../../src/lib/budget/notice.ts';
import { BUDGET_TICK_MS, BudgetService } from '../../src/lib/budget/service.ts';
import { budgetAlternative, budgetedLogins } from '../../src/lib/budget/state.ts';
import type { ConfigFilesService } from '../../src/lib/config-files/index.ts';
import type { FleetCredentialCatalog } from '../../src/lib/fleet/credentials-service.ts';
import {
  type ActivityLedger,
  type AnalyticsIngestionService,
  effectiveAnalyticsPricing,
  type FoundationPaths,
  type ModelCatalogService,
  type OutboundAuthorizerPort,
  parseSessionId,
  type ProviderPresetService,
  ProviderQuotaService,
  type SessionId,
  type SessionSendService,
  type TranscriptFileResolver,
  type TranscriptSource,
} from '../../src/lib/index.ts';
import type { SessionControlSubsystem } from '../../src/lib/runtime/mounts/session-control.ts';
import { type DaemonModule, type LateBound, lateBound } from '../../src/lib/runtime/modules.ts';

/**
 * What an environment login's provider says is left of its quota, and what a machine's spend budgets
 * (docs/provider-quotas.md, docs/budgets.md).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries: the outbound holder is a `buildWorld` value, a need) and no routes, sockets, audit
 * rules or protocol features: the base `/usage` feed is the KERNEL's, and the budget's numbers reach a screen
 * through the fleet credentials and the fleet catalogue, which read them from here.
 *
 * NO RELEASES: the quota reader reads only when somebody watches, and the budget timer was never released
 * (its interval is `unref`ed and nothing stops it), and still is not.
 *
 * ONE STEP, called by `createSubsystems` — not by `start()` — on the line the budgets always started on:
 * `jobs.startBudgets`. The budget service is built BY that step, not by `build`: its constructor reads the clock
 * and drops the holds restored from disk whose period has already reset, so building it earlier than the old
 * line could keep a hold the old construction point would have discarded. Until that line ran nothing could read
 * it (`budgets` was a `let` assigned there), and the timer it starts must not move relative to the other minute
 * timers. So `budgets` is a {@link LateBound} that step fills, and each reader keeps the answer it had before that
 * line: no view, no holds, no tick.
 */

/** What the usage module is built from. */
export interface UsageNeeds {
  /** The state home's directories: the budget holds and the owner's told-list are two documents under `state`. */
  readonly paths: Pick<FoundationPaths, 'state'>;
  /** The slice of session storage the budgets read. */
  readonly storage: BudgetStorage;
  /** The state home's confined filesystem, which the budget holds and the told-list are kept on. */
  readonly stateFiles: ConstructorParameters<typeof FileBudgetTold>[0] & Parameters<typeof budgetHoldsWriter>[0];
  /** The configuration files in effect: the budgets and the time zone come from them. */
  readonly configFiles: Pick<ConfigFilesService, 'current'>;
  /** The published manifest, read between applies. A manifest that cannot be read is NOT "no runtimes". */
  readonly publishedManifest: () => Promise<FleetManifest | undefined>;
  /** The operator's own pricing catalog, which the budget's meter prices a transcript with. */
  readonly daemonConfigStore: { readPricing(): Promise<AnalyticsPricingConfigurationRead> };
  /** The model catalogs in effect, which that pricing lays the operator's catalog over. */
  readonly modelCatalogs: Pick<ModelCatalogService, 'catalogs'>;
  /** One transcript reader per harness. */
  readonly transcriptSources: readonly TranscriptSource[];
  /** A session's transcript file, resolved over the storage. Called once, by {@link UsageJobs.startBudgets}. */
  readonly transcriptFiles: () => TranscriptFileResolver;
  /** The wall clock in milliseconds. */
  readonly millisecondClock: { now(): number };
  /** The activity ledger the budget's minute tick runs inside. */
  readonly activities: ActivityLedger;
  /** The logins the quota reader reads. */
  readonly credentialCatalog: Pick<FleetCredentialCatalog, 'entries'>;
  /** The provider presets in effect: a login reads its quota through its preset. */
  readonly presets: Pick<ProviderPresetService, 'presets'>;
  /** The outbound holder, which a quota read is spent through. */
  readonly authorizer: OutboundAuthorizerPort;
  /** What this machine's own sessions on a login cost, from the analytics index. */
  readonly ingestion: Pick<AnalyticsIngestionService, 'read'>;
  /** Interrupts a session's turn, before it is stopped. */
  readonly sends: Pick<SessionSendService, 'interrupt'>;
  /** Stops a session. */
  readonly sessionControl: Pick<SessionControlSubsystem, 'stop'>;
  /** Where a budget notice is raised for the owner. */
  readonly machineAgenda: Pick<MachineAgenda, 'raiseOrUpdate'>;
  /** The Warden's move, filled in once the Warden is built: a ferret past its hard budget is offered to it before it is stopped. */
  readonly wardenBudgetMover: { relocate?: (sessionId: string) => Promise<boolean> };
  /** Publishes the fleet again, so a hold that moved reads as it is now. Read lazily: the fleet catalogue is built after this module. */
  readonly republishFleet: () => Promise<unknown>;
  /** The name a notice calls this machine. Read lazily: the analytics machine name is decided at boot. */
  readonly machineName: () => string;
  /** The name the daemon's clients know it by, carried on a notice. */
  readonly clientName: string;
}

/** What other code uses of the usage module. */
export interface UsageProvides {
  /** Environment logins' provider quotas: read by the credentials list, by the usage feed and by the fleet catalogue. */
  readonly providerQuota: ProviderQuotaService;
  /** The spend budgets; empty until {@link UsageJobs.startBudgets} ran. */
  readonly budgets: LateBound<BudgetService>;
}

/** What `createSubsystems` starts. */
export interface UsageJobs {
  /** Makes the budgets readable, then runs them every minute and once now. Called once. */
  readonly startBudgets: () => void;
}

export const usageModule: DaemonModule<void, UsageNeeds, UsageProvides, UsageJobs> = {
  id: 'usage',
  build: needs => {
    const {
      paths,
      storage,
      stateFiles,
      configFiles,
      publishedManifest,
      daemonConfigStore,
      modelCatalogs,
      transcriptSources,
      millisecondClock,
      activities,
      credentialCatalog,
      presets,
      authorizer,
      ingestion,
      sends,
      sessionControl,
      machineAgenda,
      wardenBudgetMover,
    } = needs;
    // Provider quotas for environment logins (docs/provider-quotas.md): read through the SAME outbound
    // holder, only when somebody watches, at most once a minute per login, and never inference. The
    // fallback is what this machine's own sessions on the login cost, from the analytics index.
    const quotaReader = new ProviderQuotaService({
      logins: async () => {
        const [{ entries }, loginPresets, manifest] = await Promise.all([
          credentialCatalog.entries(),
          presets.presets(),
          publishedManifest(),
        ]);
        const runtimes = manifest === undefined ? [] : manifestRuntimes(manifest);
        return entries
          .filter(entry => entry.credential.store === 'environment')
          .map(entry => ({
            id: entry.id,
            credential: entry.credential,
            preset: loginPresets.find(preset => preset.id === entry.credential.preset),
            agents: runtimes
              .filter(runtime => runtime.credential === entry.id)
              .map(runtime => wrapperNameOf(runtime.wrapper)),
          }));
      },
      authorizer,
      spend: new AnalyticsTranscriptSpend(ingestion),
      clock: { nowMs: () => millisecondClock.now() },
    });
    const budgets = lateBound<BudgetService>();
    return {
      id: 'usage',
      provides: { providerQuota: quotaReader, budgets },
      jobs: {
        startBudgets: () => {
          /**
           * Spend budgets (docs/budgets.md), on their own minute timer so the hard limit holds with the Warden off.
           * The meter reads this machine's transcripts — sub-agents' too — priced with the analytics catalog; a
           * login past its trigger is republished unavailable; one past its hard limit has its ferrets interrupted
           * and stopped with their turns saved, and the owner is told once per period.
           */
          const budgetSessions = new StorageBudgetSessions(storage);
          const budgetResolver = needs.transcriptFiles();
          const budgetHoldsPath = join(paths.state, 'budget-holds.json');
          /**
           * Interrupt first, so the turn in flight ends at a request boundary and its transcript is whole; a session with
           * no turn to interrupt (idle, or its pane already gone) refuses, which is fine. Then wait for it to settle.
           */
          const settleBudgetSession = async (id: SessionId): Promise<void> => {
            await sends.interrupt(id).catch(() => undefined);
            for (let waited = 0; waited < 15_000; waited += 500) {
              const status = sessionStatusOf(await storage.readState(id).catch(() => undefined));
              if (status === undefined || !['running', 'thinking', 'tool_running', 'retrying'].includes(status)) break;
              await Bun.sleep(500);
            }
          };
          const budgetService = new BudgetService(
            {
              config: async () => {
                const effective = configFiles.current().evaluation.effective;
                // A manifest that cannot be read is NOT "no runtimes": that would read every budget as $0 spent and
                // publish every hold lifted. The read throws instead, and the tick keeps what it had.
                const manifest = await publishedManifest();
                const logins = budgetedLogins(effective.model, manifest);
                if (manifest === undefined && logins.length > 0)
                  throw new Error('no fleet manifest is published yet; budgets are judged once one is');
                return {
                  ...(effective.model.machine.timeZone === undefined
                    ? {}
                    : { timeZone: effective.model.machine.timeZone }),
                  logins,
                };
              },
              hostTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
              meter: new SpendMeter({
                sessions: async sinceMs => await budgetSessions.sessions(sinceMs),
                files: async session => {
                  const files: MeteredFile[] = [];
                  const file = await budgetResolver.file(session.id);
                  if (file !== undefined) {
                    files.push({ path: file, harness: session.harness });
                    if (session.harness === 'claude')
                      for (const path of await claudeSubagentFiles(file)) files.push({ path, harness: 'claude' });
                  }
                  // A converted conversation was rewritten without its usage records: what it spent is in the old file.
                  const converted = await budgetSessions.convertedFrom(session.id);
                  if (converted !== undefined && converted.path !== file) files.push(converted);
                  return files;
                },
                window: (file, harness, sinceIso) => {
                  const source = transcriptSources.find(candidate => candidate.harness === harness);
                  if (source === undefined) throw new Error(`no transcript reader for ${harness}`);
                  return source.window(file, { start: { at: 'since', instant: sinceIso } });
                },
                pricing: async () => {
                  const read = await daemonConfigStore.readPricing();
                  const rates = effectiveAnalyticsPricing(
                    read.kind === 'unavailable' ? [] : read.configuration.catalog,
                    await modelCatalogs.catalogs(),
                  );
                  return usage => {
                    const priced = snapshotAnalyticsUsagePricing(usage, rates);
                    return priced.kind === 'priced' ? priced.equivalentApiCostUsdMicros : undefined;
                  };
                },
              }),
              nowMs: () => millisecondClock.now(),
              republish: async () => {
                await needs.republishFleet();
              },
              liveSessions: async agents => await budgetSessions.live(agents),
              recentSession: async agents => await budgetSessions.recent(agents),
              // The Warden moves it only when the owner switched `autoMigrate` on for budgets; it answers `false` otherwise.
              relocate: async session => {
                const relocate = wardenBudgetMover.relocate;
                if (relocate === undefined) return false;
                await settleBudgetSession(parseSessionId(session.id));
                return await relocate(session.id);
              },
              stop: async (session, reason) => {
                await settleBudgetSession(parseSessionId(session.id));
                await sessionControl.stop(session.id, reason);
              },
              alternative: async (login, holds) =>
                budgetAlternative(
                  configFiles.current().evaluation.effective.model,
                  login,
                  millisecondClock.now(),
                  holds,
                ),
              notify: async notice => {
                const {
                  source: _source,
                  sourceRef,
                  ...request
                } = budgetNoticeRequest(
                  notice,
                  needs.clientName,
                  needs.machineName(),
                  new Date(millisecondClock.now()).toISOString(),
                );
                await machineAgenda.raiseOrUpdate(sourceRef ?? budgetNoticeRef(notice), request);
              },
              told: new FileBudgetTold(stateFiles, join(paths.state, 'budget-told.json')),
              remember: budgetHoldsWriter(stateFiles, budgetHoldsPath),
            },
            readBudgetHoldsSync(budgetHoldsPath),
          );
          budgets.bind(budgetService);
          const budgetTick = asActivity(activities, 'spend budgets', async () => await budgets.current()?.tick());
          setInterval(budgetTick, BUDGET_TICK_MS).unref();
          budgetTick();
        },
      },
      contributes: {},
    };
  },
};

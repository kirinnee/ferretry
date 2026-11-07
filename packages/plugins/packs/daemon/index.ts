import type { FerretId, FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { SecretName } from '@ferretry/core-vault/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import {
  DEFAULT_ROUTING_FILE,
  type FerretPackPatchResult,
  type FerretResult,
  PACKS_CONFIG,
  type PackCleanUpRequest,
  type PackConfig,
  type PacksFile,
  packConfigFromFile,
  type PackTable,
  type PackView,
  type RuntimeFactsApi,
  type UsageQuotaApi,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { NamedCardOnly } from './adapters/cards.ts';
import { FleetFacts } from './adapters/fleet-facts.ts';
import { PackFerrets } from './adapters/ferrets.ts';
import { RuntimeLaunchProbe } from './adapters/launch-probe.ts';
import { StateReplacedRouting } from './adapters/replaced.ts';
import { StateCleanUpRunStore } from './adapters/run-store.ts';
import { StatePackSpendLedger } from './adapters/spend-ledger.ts';
import { StatePackSwitches } from './adapters/switches.ts';
import { packInstructed } from './lib/admission.ts';
import type { ModelCatalogView } from './lib/catalog.ts';
import { CleanUpService } from './lib/cleanup/service.ts';
import { GuideFileService } from './lib/cleanup/file.ts';
import { launchEnvironment, startDecision } from './lib/hooks.ts';
import { JevPackRanker } from './lib/jev.ts';
import { ProbeCache } from './lib/probe.ts';
import { PACK_ROUTING_MAX_AGE_MS, PackRoutingKeep } from './lib/routing-keep.ts';
import { readFerretResult } from './lib/result.ts';
import { packRoutes } from './lib/routes.ts';
import { COMMON_SCRATCH_ROOTS, isScratchPath } from './lib/scratch.ts';
import { PackService } from './lib/service.ts';
import { buildPackTable, packMembers } from './lib/table.ts';

/** The shipped command name every printed command uses. */
const BIN = 'fy';

/** Today's `warden.guard.usdPerMillionInputTokens` default: what Jev charges per million input tokens. */
const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

/** The summary a `signal done` with no message writes: not a result, so it reads as none. */
const DEFAULT_COMPLETION_SUMMARY = 'Task completed; inspect chat and repository diff.\n';
const SUMMARY_FILE = 'summary.md';

type RuntimesWithFacts = RuntimesApi &
  Partial<RuntimeFactsApi> & { modelCatalogs?(): Promise<readonly ModelCatalogView[]> };

/**
 * Packs (daemon half, §2.3): Pack mode. `fy new` (admission, the candidate order, the probe, the start), `recommend`,
 * the pack table, the routing prompt and its clean-up ferret, Jev's ranking and spend, each ferret's own switch.
 *
 * It takes `start.decide` (a child's depth and width, whichever command started it) and `launch.parts` (whether a ferret
 * is TOLD about Pack mode, and the routing line it reads). Jev's key is only ever named: the Vault places it on the one
 * request to the one host.
 */
export default implementDaemon(manifest, {
  build: ({ needs, uses, kernel }) => {
    const file = (): PacksFile => kernel.config.file(PACKS_CONFIG) ?? {};
    const config = (): PackConfig => packConfigFromFile(file());
    const switches = new StatePackSwitches(kernel.state);
    const ledger = new StatePackSpendLedger(kernel.state, () => kernel.clock.now().slice(0, 10));
    const ferrets = (): FerretsApi => needs.ferrets;
    const packFerrets = new PackFerrets(
      ferrets,
      async id => await switches.get(id),
      async () => config().limits,
    );
    const runtimes = (): RuntimesWithFacts | undefined => uses.runtimes.current() as RuntimesWithFacts | undefined;
    const fleet = new FleetFacts(
      runtimes,
      () => uses.usage.current() as UsageQuotaApi | undefined,
      () => kernel.clock.now(),
    );
    const probes = new ProbeCache(new RuntimeLaunchProbe(runtimes, () => kernel.clock.nowMs()), () =>
      kernel.clock.nowMs(),
    );
    const jev = new JevPackRanker(
      async (name, hosts, request) => await needs.vault.authorizeFetch(name as SecretName, hosts, request),
    );
    const catalogs = async (): Promise<readonly ModelCatalogView[]> => (await runtimes()?.modelCatalogs?.()) ?? [];
    const home = (): string => {
      const resolved = kernel.roots.root('agent-homes').resolve('.');
      return resolved.ok ? resolved.value : '';
    };

    const service = new PackService({
      settings: async () => ({
        config: config(),
        routingFile: file().routing ?? DEFAULT_ROUTING_FILE,
        jevUsdPerMillionInputTokens: JEV_USD_PER_MILLION_INPUT_TOKENS,
      }),
      catalogs,
      facts: async () => await fleet.facts(),
      parent: async id => await packFerrets.parent(id),
      scratch: async cwd => isScratchPath(cwd, COMMON_SCRATCH_ROOTS),
      probe: async (request, ttlMs) => await probes.probe(request, ttlMs),
      start: async (request, delegation) => await packFerrets.start(request, delegation),
      cards: new NamedCardOnly(),
      jev,
      spend: { today: async () => await ledger.spent(), record: async usd => await ledger.record(usd) },
      bin: BIN,
      now: () => kernel.clock.now(),
    });

    const result = async (ferret: string): Promise<FerretResult | undefined> => {
      const summary = await ferrets().get(ferret as FerretId);
      if (summary === undefined) return undefined;
      return await readFerretResult(
        summary,
        async () => {
          try {
            const root = kernel.roots.root('agent-homes', { ferret: ferret as FerretId });
            const path = root.resolve(SUMMARY_FILE);
            return path.ok ? await root.readText(path.value) : undefined;
          } catch {
            return undefined;
          }
        },
        DEFAULT_COMPLETION_SUMMARY,
      );
    };

    const cleanUp = new CleanUpService({
      inventory: async () => await service.inventory(),
      runtime: async name => {
        const found = (await runtimes()?.catalog?.())?.find(row => row.name === name || row.wrapper === name);
        return found === undefined
          ? undefined
          : { wrapper: found.wrapper, harness: found.harness, defaultModel: found.models?.default };
      },
      probeSettings: async () => config().probe,
      probe: async (request, ttlMs) => await probes.probe(request, ttlMs),
      start: async request => await packFerrets.startBuilder(request),
      status: async id => await packFerrets.state(id),
      result: async id => (await result(id))?.summary,
      stop: async (id, reason) => await packFerrets.stop(id, reason),
      runs: new StateCleanUpRunStore(kernel.state),
      now: () => kernel.clock.now(),
      newId: () => kernel.ids.mint('run'),
      home: home(),
      bin: BIN,
    });

    const guideFile = new GuideFileService({
      read: async () => ({ file: file(), etag: JSON.stringify(file()) }),
      // GAP: the kernel's config WRITE port (`kernel.config.write`) is not on this base; Gate's config route is the only
      // writer, and it is not a port a plugin may call. Until it lands, accepting or undoing says so and writes nothing.
      write: async () => {
        throw new ApiError(
          503,
          'The configuration writer is not available to Pack mode yet; edit config/packs.yaml by hand.',
          'config_write_unavailable',
        );
      },
      replaced: new StateReplacedRouting(kernel.state),
      now: () => kernel.clock.now(),
    });

    /** The routing line, derived once per configuration (`routing-keep.ts`). */
    const routingKeep = new PackRoutingKeep({
      generation: async () => kernel.config.file(PACKS_CONFIG),
      derive: async () => await service.routingLine(),
      now: () => kernel.clock.nowMs(),
      maxAgeMs: PACK_ROUTING_MAX_AGE_MS,
    });

    const instructed = async (ferret: string): Promise<boolean> => {
      const summary = await ferrets().get(ferret as FerretId);
      if (summary === undefined) return false;
      return packInstructed(config(), await switches.get(ferret), await packFerrets.depth(ferret));
    };

    const table = async (ferret: string, caller?: string): Promise<PackTable | undefined> => {
      const api = ferrets();
      const root = await api.get(ferret as FerretId);
      if (root === undefined) return undefined;
      if (caller !== undefined && !api.mayTouch(caller as FerretId, ferret as FerretId))
        throw new ApiError(403, 'a ferret reads only its own pack', 'forbidden');
      const all = await api.list();
      const nowMs = kernel.clock.nowMs();
      const members = packMembers(all, ferret, nowMs);
      const sitreps = new Map(
        await Promise.all(members.map(async ({ ferret: member }) => [member.id, await api.sitrep(member.id)] as const)),
      );
      return buildPackTable({
        root,
        ferrets: all,
        lines: id => sitreps.get(id as FerretId)?.lines ?? [],
        blockers: id => sitreps.get(id as FerretId)?.blockers.length ?? 0,
        nowMs,
      });
    };

    const setSwitch = async (ferret: string, enabled: boolean): Promise<FerretPackPatchResult | undefined> => {
      const summary: FerretSummary | undefined = await ferrets().get(ferret as FerretId);
      if (summary === undefined) return undefined;
      await switches.set(ferret, enabled, kernel.clock.now());
      return {
        ferret: summary,
        restartRequired: summary.state !== 'stopped',
        note: enabled
          ? 'Pack mode is on for this ferret; it hears about it the next time it launches.'
          : 'Pack mode is off for this ferret; it stops hearing about it the next time it launches.',
      };
    };

    const view = async (): Promise<PackView> => {
      const [base, undo, status] = await Promise.all([service.view(), guideFile.undoable(), cleanUp.status()]);
      return { ...base, ...(undo === undefined ? {} : { undo }), cleanUp: status };
    };

    return {
      routes: packRoutes(
        {
          service,
          routing: {
            cleanUp: {
              status: async () => await cleanUp.status(),
              start: async (request: PackCleanUpRequest) => await cleanUp.start(request),
              job: async id => await cleanUp.job(id),
            },
            file: {
              undoable: async () => await guideFile.undoable(),
              accept: async request => await guideFile.accept(request),
              undo: async () => await guideFile.undo(),
            },
          },
          result,
          table,
          setSwitch,
        },
        kernel.redaction,
      ),
      provides: {
        packs: {
          view,
          recommend: async input => await service.recommend(input),
          newHelper: async (request, caller) => await service.newChild(request, caller),
          routingLine: async () => await routingKeep.line(),
          instructed: async ferret => await instructed(ferret),
          result: async ferret => await result(ferret),
          table: async (ferret, caller) => await table(ferret, caller),
          setSwitch,
        },
      },
      hooks: {
        // Admission: a child's depth and how many its parent may have, whichever command started it.
        'start.decide': async input =>
          startDecision(
            input.parent === undefined ? undefined : await packFerrets.parent(input.parent),
            config().limits,
          ),
        // What a ferret is TOLD about Pack mode, decided at every launch.
        'launch.parts': () => [
          {
            id: 'packs',
            item: {
              parts: async spec => {
                const summary = await ferrets().get(spec.ferret);
                const env = await launchEnvironment(
                  config(),
                  {
                    eligible: summary?.provenance?.wardenLineage !== true,
                    ownSwitch: await switches.get(spec.ferret),
                    depth: await packFerrets.depth(spec.ferret),
                  },
                  async () => await routingKeep.line(),
                );
                return [{ kind: 'env' as const, env }];
              },
            },
          },
        ],
      },
    };
  },
});

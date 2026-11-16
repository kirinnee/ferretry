import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { RuntimeIdSchema, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
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
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { FleetFacts } from './adapters/fleet-facts.ts';
import { ConfigGuideWriter } from './adapters/guide-config.ts';
import { LoginQuotaFacts } from './adapters/login-quota.ts';
import { PackFerrets } from './adapters/ferrets.ts';
import { RuntimeLaunchProbe } from './adapters/launch-probe.ts';
import { StateReplacedRouting } from './adapters/replaced.ts';
import { StateCleanUpRunStore } from './adapters/run-store.ts';
import { StatePackSwitches } from './adapters/switches.ts';
import { packInstructed } from './lib/admission.ts';
import type { ModelCatalogView } from './lib/catalog.ts';
import { CleanUpService } from './lib/cleanup/service.ts';
import { GuideFileService } from './lib/cleanup/file.ts';
import { launchEnvironment, limitedParent, startDecision } from './lib/hooks.ts';
import { ProbeCache } from './lib/probe.ts';
import { PACK_ROUTING_MAX_AGE_MS, PackRoutingKeep } from './lib/routing-keep.ts';
import { readFerretResult, ResultUncheckedError } from './lib/result.ts';
import { packRoutes } from './lib/routes.ts';
import { PackService } from './lib/service.ts';
import { packSwitchOutcome } from './lib/switch.ts';
import { readPackTable } from './lib/table.ts';

/** The shipped command name every printed command uses. */
const BIN = 'fy';

/** The summary a `signal done` with no message writes: not a result, so it reads as none. */
const DEFAULT_COMPLETION_SUMMARY = 'Task completed; inspect chat and repository diff.\n';

/**
 * Packs (daemon half, §2.3): Pack mode. `recommend`, the pack table, the routing prompt and its clean-up ferret, each
 * ferret's own switch. Starting a helper is Ferrets' (`fy new`): Packs shapes a start only through the hooks it takes.
 *
 * It takes `start.decide` (a child's depth and width, whichever command started it) and `launch.parts` (whether a ferret
 * is TOLD about Pack mode, and the routing line it reads). It calls out to nothing and spends on nothing by itself.
 */
export default implementDaemon(manifest, {
  build: ({ needs, uses, kernel }) => {
    const file = (): PacksFile => kernel.config.file(PACKS_CONFIG) ?? {};
    const config = (): PackConfig => packConfigFromFile(file());
    const switches = new StatePackSwitches(kernel.state);
    const ferrets = (): FerretsApi => needs.ferrets;
    const packFerrets = new PackFerrets(ferrets);
    const runtimes = (): RuntimesApi | undefined => uses.runtimes.current();
    // The model catalogs in effect, from Logins (which owns them). A Logins that is off or fails offers none: the routing
    // prompt is then rendered from no catalog, and each runtime's own model list still names what it offers.
    const catalogs = async (): Promise<readonly ModelCatalogView[]> => {
      const logins = uses.logins.current();
      if (logins === undefined) return [];
      try {
        return (await logins.models()).catalogs;
      } catch {
        return [];
      }
    };
    // The limits live ferrets prove, read from the REAL Ferrets port (`list()` + `prompt().limit`).
    const quota = new LoginQuotaFacts(
      () => uses.logins.current(),
      () => ferrets(),
      () => kernel.clock.nowMs(),
    );
    const fleet = new FleetFacts(
      runtimes,
      () => uses.logins.current(),
      () => uses.usage.current(),
      () => kernel.clock.now(),
      () => quota,
    );
    const probes = new ProbeCache(new RuntimeLaunchProbe(runtimes, () => kernel.clock.nowMs()), () =>
      kernel.clock.nowMs(),
    );

    const service = new PackService({
      settings: async () => ({ config: config(), routingFile: file().routing ?? DEFAULT_ROUTING_FILE }),
      catalogs,
      facts: async () => await fleet.facts(),
      bin: BIN,
      now: () => kernel.clock.now(),
    });

    /**
     * Today's `pack.result`: the finished ferret's `summary.md`, read through Ferrets (`FerretsApi.summary`, NOT masked),
     * then masked whole inside ONE `Redaction.read` before anything keeps or serves it: the result route,
     * `PacksApi.result` and Clean up's rewrite all read it here. A redactor that fails withholds it: this throws
     * {@link ResultUncheckedError} rather than hand back text that was not checked.
     */
    const result = async (ferret: string): Promise<FerretResult | undefined> => {
      const summary = await ferrets().get(ferret as FerretId);
      if (summary === undefined) return undefined;
      const found = await readFerretResult(
        summary,
        async () => await ferrets().summary(ferret as FerretId),
        DEFAULT_COMPLETION_SUMMARY,
      );
      if (found.summary === undefined) return found;
      const text = found.summary;
      let masked: string;
      try {
        masked = await kernel.redaction.read(scope => scope.text(text));
      } catch {
        throw new ResultUncheckedError();
      }
      return { ...found, summary: masked };
    };

    const cleanUp = new CleanUpService({
      inventory: async () => await service.inventory(),
      runtime: async name => {
        const id = RuntimeIdSchema.safeParse(name);
        const found = id.success ? await runtimes()?.get(id.data) : undefined;
        // The check (`RuntimeLaunchProbe`) and the start both name the runtime by its name.
        return found === undefined ? undefined : { wrapper: found.id, harness: found.harness };
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
      // GAP (the WorkFolders seam, D2 #19; a ruling for britnee): today's builder ran in the Ferretry home. Ferrets starts a
      // ferret in a folder the START names (`StartRequest.workFolder` is a trusted plugin's own choice), but nothing hands
      // Pack mode a folder the KERNEL chose for a builder, and the only folders Pack mode can name are inside the state home
      // (`state.pathOf`), where an unattended model run could reach the credentials and sessions the fence keeps agents out
      // of. So Clean up refuses to start and says so (the sentence names what is missing and how to edit by hand); no side
      // door. It stays a person's act (`POST /v1/pack/routing/clean-up` is person-only): nothing in Packs checks or starts
      // a runtime unattended.
      home: undefined,
      bin: BIN,
    });

    // Accept and undo write `packs.yaml` through the kernel's config writer (the service behind `PUT /v1/config/file`),
    // against the etag read with the file; an edit the writer holds for the owner is reported held.
    const guideWriter = new ConfigGuideWriter(kernel.config);
    const guideFile = new GuideFileService({
      read: async () => await guideWriter.read(),
      write: async (routing, etag) => await guideWriter.write(routing, etag),
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
      if (!(await packFerrets.eligible(ferret))) return false;
      return packInstructed(config(), await switches.get(ferret), await packFerrets.depth(ferret));
    };

    /**
     * A lead's pack table. A ferret reads a pack in its own lineage: its own and its helpers' (`mayTouch`), and — as
     * today — its lead's (the asked ferret may touch the caller). The excerpts are masked whole inside ONE
     * `Redaction.read` before they are cut, and a redactor that fails withholds them (`readPackTable`).
     */
    const table = async (ferret: string, caller?: string): Promise<PackTable | undefined> => {
      const api = ferrets();
      const root = await api.get(ferret as FerretId);
      if (root === undefined) return undefined;
      if (
        caller !== undefined &&
        !api.mayTouch(caller as FerretId, ferret as FerretId) &&
        !api.mayTouch(ferret as FerretId, caller as FerretId)
      )
        throw new ApiError(403, 'a ferret reads only a pack in its own lineage', 'forbidden');
      return await readPackTable({
        root,
        ferrets: await api.list(),
        sitrep: async id => {
          const found = await api.sitrep(id as FerretId);
          return found === undefined ? undefined : { lines: found.lines, blockers: found.blockers.length };
        },
        redact: async texts => await kernel.redaction.read(scope => texts.map(text => scope.text(text))),
        model: async id => await api.displayModel?.(id as FerretId),
        nowMs: kernel.clock.nowMs(),
      });
    };

    const setSwitch = async (ferret: string, enabled: boolean): Promise<FerretPackPatchResult | undefined> => {
      const summary = await ferrets().get(ferret as FerretId);
      if (summary === undefined) return undefined;
      const before = await switches.get(ferret);
      await switches.set(ferret, enabled, kernel.clock.now());
      return {
        ferret: summary,
        ...packSwitchOutcome({ enabled: before, running: summary.state !== 'stopped' }, enabled),
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
        kernel.log,
      ),
      provides: {
        packs: {
          view,
          recommend: async input => await service.recommend(input),
          routingLine: async () => await routingKeep.line(),
          instructed: async ferret => await instructed(ferret),
          result: async ferret => await result(ferret),
          table: async (ferret, caller) => await table(ferret, caller),
          setSwitch,
        },
      },
      hooks: {
        // Admission (RULING #43): Packs' OWN yes here is the only thing that admits a helper; Ferrets refuses a child
        // Packs did not answer for. A started child's depth and how many its parent may have, whichever command started
        // it; a resume is answered yes without the limits, as today.
        'start.decide': async input => {
          const parent = limitedParent(input);
          return startDecision(parent === undefined ? undefined : await packFerrets.parent(parent), config().limits);
        },
        // What a ferret is TOLD about Pack mode, decided at every launch. The learning miner, the clean-up ferret and a
        // warden's lineage are never told (today's `ordinaryFerret`), so none of them can start helpers unattended.
        'launch.parts': () => [
          {
            id: 'packs',
            item: {
              parts: async spec => {
                const env = await launchEnvironment(
                  config(),
                  {
                    eligible: await packFerrets.eligible(spec.ferret),
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

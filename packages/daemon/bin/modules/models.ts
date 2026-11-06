import { join } from 'node:path';
// The hosted app's release key, the one its signed release list is checked with — and so the published
// model catalog the list vouches for (docs/model-catalog.md). Compiled in as text, from its one file.
import HOSTED_APP_RELEASE_KEY from '../../../pwa/release-signing-key.pub' with { type: 'text' };
import {
  AuthorizedProviderProbe,
  FetchEnhancementTransport,
  FileModelCatalogCache,
  HostedModelCatalog,
  type ModelCatalogCacheFiles,
} from '../../src/adapters/index.ts';
import {
  type FoundationPaths,
  HOSTED_APP_ORIGIN,
  LocalModelsService,
  modelCatalogsView,
  ModelCatalogService,
  type OutboundAuthorizerPort,
  type ProviderPresetService,
  ProviderProbeService,
  PublishedModelCatalogService,
  suggestedOllamaModel,
} from '../../src/lib/index.ts';
import type { ConfigFilesService } from '../../src/lib/config-files/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { type ModelsSubsystem, modelsContribution } from '../../src/lib/runtime/mounts/models.ts';

/**
 * The model catalogs this machine reads, the models Ollama has installed on it, and the Test a login's key is spent
 * on once (docs/model-catalog.md, docs/provider-presets.md).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the outbound holder is a `buildWorld` value, a need) and no releases: everything it builds
 * is inert until a request or the arming below, and reads nothing on a timer.
 *
 * ONE JOB, armed by `start()`: the first read of the models Ollama has installed, fired once the fleet can be
 * republished with them. It is not awaited and its failure is swallowed, on the line `start()` always had.
 */

/** What the models module is built from. */
export interface ModelsNeeds {
  /** The state home's directories: the published catalog's cache is one document under `state`. */
  readonly paths: Pick<FoundationPaths, 'state'>;
  /** The state home's confined filesystem, which the published catalog's cache reads and writes. */
  readonly stateFiles: ModelCatalogCacheFiles;
  /** The configuration files in effect: this machine's own `config/models/<id>.yaml` is read through them. */
  readonly configFiles: Pick<ConfigFilesService, 'inEffect'>;
  /** The provider presets in effect: a login reads its catalog through its preset. */
  readonly presets: Pick<ProviderPresetService, 'presets'>;
  /** The outbound holder, which a login Test spends its key through. */
  readonly authorizer: OutboundAuthorizerPort;
  /** Monotonic milliseconds for a Test's latency. */
  readonly stopwatch: { monotonicMs(): number };
  /** The wall clock a Test and a local read stamp their answers with. */
  readonly clock: { now(): string };
  /** The wall clock in milliseconds, which the published catalog's check interval is measured on. */
  readonly millisecondClock: { now(): number };
  /** Told when a newer catalog or a different set of local models moves the list prices analytics reads. */
  readonly pricingChanged: () => void;
  /** Republishes the fleet, so what every runtime offers moves with a catalog. Read lazily: the fleet catalogue is built after this module. */
  readonly republishFleet: () => Promise<unknown>;
}

/** What other code uses of the models module. */
export interface ModelsProvides {
  /** The catalogs in effect: priced by analytics and learning, read by the apply, the Pack routing line and the logins. */
  readonly catalogs: ModelCatalogService;
  /** A login's Test: one key spent once through the outbound holder. */
  readonly providerProbe: ProviderProbeService;
  /** The three calls the routes serve; the mounted field points here. */
  readonly subsystem: ModelsSubsystem;
}

/** What `start()` arms. `refreshLocal` keeps the subsystem's own signature: a read of Ollama that never throws. */
export interface ModelsJobs {
  readonly refreshLocal: () => ReturnType<ModelsSubsystem['refreshLocal']>;
}

export const modelsModule: DaemonModule<void, ModelsNeeds, ModelsProvides, ModelsJobs> = {
  id: 'models',
  build: needs => {
    const { paths, stateFiles, configFiles, presets, authorizer, stopwatch, clock, millisecondClock } = needs;
    // The model catalog Ferretry publishes with the hosted app (docs/model-catalog.md § Live updates):
    // a one-file version check, at most every six hours when something reads the catalogs, and the
    // full catalog only when the version differs — checked against the hosted app's signed release
    // list with the key compiled into this build. `FY_MODEL_CATALOG=off` follows none; the origin can
    // be pointed elsewhere with `FY_MODEL_CATALOG_ORIGIN`.
    const modelCatalogOrigin = process.env.FY_MODEL_CATALOG_ORIGIN?.trim() || HOSTED_APP_ORIGIN;
    const publishedModelCatalog = new PublishedModelCatalogService({
      ...(process.env.FY_MODEL_CATALOG === 'off' ? {} : { fetch: new HostedModelCatalog(modelCatalogOrigin) }),
      cache: new FileModelCatalogCache(stateFiles, join(paths.state, 'model-catalog.json')),
      publicKeyPem: HOSTED_APP_RELEASE_KEY,
      nowMs: () => millisecondClock.now(),
      // A newer catalog moves what every runtime offers now, not at the next change somebody makes —
      // and the list prices analytics reads.
      onUpdated: async () => {
        needs.pricingChanged();
        await needs.republishFleet().catch(() => undefined);
      },
    });
    // Model catalogs (docs/model-catalog.md): this build's, the published one over them, then this
    // machine's own config/models/<id>.yaml over both. What every runtime on a login offers and pins.
    const modelCatalogService = new ModelCatalogService({
      files: async () => (await configFiles.inEffect()).evaluation.effective.modelCatalogs,
      published: async () => {
        publishedModelCatalog.refreshIfDue();
        return await publishedModelCatalog.catalogs();
      },
      presets: async () => await presets.presets(),
      ollama: () => localModels.snapshot(),
    });
    // The models Ollama has installed on this machine (docs/model-catalog.md § Local models): read at
    // boot and whenever a person opens Settings or a login's setup — never on a timer — through the
    // same keyless, loopback-only read a login Test makes. A different set moves what runtimes offer.
    const keylessProbe = new AuthorizedProviderProbe(authorizer, new FetchEnhancementTransport());
    const localModels = new LocalModelsService({
      probe: keylessProbe,
      address: process.env.OLLAMA_HOST,
      enabled: process.env.FY_LOCAL_MODELS !== 'off',
      suggested: async () => suggestedOllamaModel(await modelCatalogService.catalogs()),
      now: () => clock.now(),
      onChanged: async () => {
        needs.pricingChanged();
        await needs.republishFleet().catch(() => undefined);
      },
    });
    const providerProbe = new ProviderProbeService({
      probe: keylessProbe,
      clock: { monotonicMs: () => stopwatch.monotonicMs(), now: () => clock.now() },
    });
    // The model catalogs in effect, and the published one this machine follows (docs/model-catalog.md).
    const subsystem: ModelsSubsystem = {
      view: async () =>
        modelCatalogsView(await modelCatalogService.catalogs(), {
          origin: modelCatalogOrigin,
          enabled: publishedModelCatalog.enabled,
          ...(await publishedModelCatalog.status()),
        }),
      refresh: async () => await publishedModelCatalog.refresh(true),
      refreshLocal: async () => await localModels.refresh(),
    };
    return {
      id: 'models',
      provides: { catalogs: modelCatalogService, providerProbe, subsystem },
      // A lambda, not `subsystem.refreshLocal.bind(...)`: the subsystem is looked up at the moment `start()` arms it.
      jobs: { refreshLocal: () => subsystem.refreshLocal() },
      contributes: modelsContribution(subsystem),
    };
  },
};

/**
 * The model catalogs this machine reads (docs/model-catalog.md): the built-in ones, the signed
 * catalog Ferretry last published (once one has been fetched), and this machine's own
 * `config/models/<id>.yaml`, each id from the most owned source that has it.
 *
 * A catalog is data — labels, model ids, tiers — and never a credential or a permission, so the whole
 * set may travel to any caller with `fleet.use`.
 */
import {
  builtInModelCatalogs,
  type ModelCatalog,
  type ModelCatalogSources,
  modelCatalogs,
  type ProviderPreset,
} from '@ferretry/fleet';

export interface ModelCatalogServiceDeps {
  /** This machine's own catalog files that check, by id. */
  files(): Promise<Readonly<Record<string, ModelCatalog>>>;
  /** The last published catalog this machine fetched and verified, when there is one. */
  published?(): Promise<Readonly<Record<string, ModelCatalog>> | undefined>;
  /** The provider presets in effect: a login reads its catalog through its preset. */
  presets(): Promise<readonly ProviderPreset[]>;
}

export class ModelCatalogService {
  readonly #builtIn: Readonly<Record<string, ModelCatalog>>;

  constructor(
    private readonly deps: ModelCatalogServiceDeps,
    builtIn: Readonly<Record<string, ModelCatalog>> = builtInModelCatalogs(),
  ) {
    this.#builtIn = builtIn;
  }

  /** Every catalog in effect, by id. */
  async catalogs(): Promise<Readonly<Record<string, ModelCatalog>>> {
    const [files, published] = await Promise.all([this.deps.files(), this.deps.published?.()]);
    return modelCatalogs({ builtIn: this.#builtIn, ...(published === undefined ? {} : { published }), files });
  }

  /** What an apply reads to decide each runtime's models. */
  async sources(): Promise<ModelCatalogSources> {
    const [catalogs, presets] = await Promise.all([this.catalogs(), this.deps.presets()]);
    return { catalogs, presets };
  }
}

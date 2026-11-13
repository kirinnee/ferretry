/**
 * PACK MODE'S APPLICATION SERVICE (docs/pack-mode.md): the view the settings page reads, what `fy recommend`
 * prints, the routing line a Pack ferret's system prompt carries, and the inventory Clean up is shown.
 *
 * ONE routing prompt drives every decision: the ferret reads it in its system prompt and in `recommend`.
 * Starting a helper is Ferrets' (`fy new`); Packs shapes a start only through its `start.decide` taker.
 */
import type {
  PackConfig,
  PackFleetModel,
  PackInventory,
  PackModelOption,
  PackRecommendation,
  PackView,
  RoutingFile,
  RoutingPromptView,
} from '../../contract/index.ts';
import type { ModelCatalogView } from './catalog.ts';
import { buildInventory } from './cleanup/inventory.ts';
import { automaticOrder, availableModels, type PackFleetFacts } from './recommend.ts';
import { defaultPrompt, effectiveRouting, fleetModels, routingLine } from './routing.ts';

/** The settings in effect, read fresh for every request. */
interface PackSettings {
  readonly config: PackConfig;
  readonly routingFile: RoutingFile;
}

export interface PackPorts {
  settings(): Promise<PackSettings>;
  catalogs(): Promise<readonly ModelCatalogView[]>;
  facts(): Promise<PackFleetFacts>;
  /** The shipped command name, so every command it prints exists after a rename. */
  readonly bin: string;
  /** Now, as an instant: when an inventory was taken. */
  now(): string;
}

/** Everything one decision reads, read once. */
interface Snapshot {
  readonly settings: PackSettings;
  readonly facts: PackFleetFacts;
  readonly models: readonly PackFleetModel[];
  readonly routing: RoutingPromptView;
  readonly available: readonly PackModelOption[];
}

export class PackService {
  constructor(private readonly ports: PackPorts) {}

  private async snapshot(): Promise<Snapshot> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    const models = fleetModels(catalogs, facts.runtimes);
    const routing = effectiveRouting(settings.routingFile, catalogs, facts.runtimes, this.ports.bin);
    return {
      settings,
      facts,
      models,
      routing,
      available: availableModels(facts, models, routing.text, this.ports.bin),
    };
  }

  /** The settings, the routing prompt in effect, the vocabulary and the models usable now. */
  async view(): Promise<Omit<PackView, 'undo' | 'cleanUp'>> {
    const { settings, models, routing, available } = await this.snapshot();
    return { config: settings.config, routing, models, available };
  }

  /** The default routing prompt, rendered from the catalogs in effect, whatever the file says. */
  async defaultPrompt(): Promise<string> {
    const [catalogs, facts] = await Promise.all([this.ports.catalogs(), this.ports.facts()]);
    return defaultPrompt(fleetModels(catalogs, facts.runtimes), this.ports.bin);
  }

  /** What the clean-up ferret is shown (`./cleanup/inventory.ts`): the harness config, names and states only. */
  async inventory(): Promise<PackInventory> {
    const { facts, models, routing } = await this.snapshot();
    return buildInventory({ facts, models, routing, now: facts.now ?? this.ports.now() });
  }

  /**
   * The routing prompt as the one line a Pack ferret's system prompt carries (`FY_PACK_ROUTING`), from the
   * prompt in effect now — derived at every launch, so a restart hears the latest saved prompt.
   */
  async routingLine(): Promise<string> {
    const [settings, catalogs, facts] = await Promise.all([
      this.ports.settings(),
      this.ports.catalogs(),
      this.ports.facts(),
    ]);
    return routingLine(effectiveRouting(settings.routingFile, catalogs, facts.runtimes, this.ports.bin).text);
  }

  /** The routing prompt and the models usable now; `next` is what `--auto` would try first. */
  async recommend(input: { readonly task?: string | undefined }): Promise<PackRecommendation> {
    const { routing, available } = await this.snapshot();
    const first = automaticOrder(available)[0];
    return {
      ...(input.task === undefined ? {} : { task: input.task }),
      routing,
      available,
      ...(first?.command === undefined ? {} : { next: first.command }),
    };
  }
}

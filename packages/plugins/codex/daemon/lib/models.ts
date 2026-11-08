/**
 * The model catalog Codex advertises, as this plugin states it.
 *
 * Codex answers `model/list` over its app-server and its picker renders exactly that list, so these are the
 * shapes the exchange, the picker driver and the switch planner all read. They are structurally the choices
 * the Runtimes catalog wire carries; Codex does not import that contract (a harness needs nothing), so the
 * fields it reads are spelled once, here.
 */

/** One reasoning level a model offers. */
export interface RuntimeReasoningChoice {
  readonly value: string;
  readonly description?: string;
}

/** One model as the live Codex account advertises it. */
export interface RuntimeModelChoice {
  /** The value a settings update carries: what `--model` takes. */
  readonly value: string;
  /** The name Codex's own picker renders the model under. */
  readonly label: string;
  readonly description?: string;
  /** Where a login's model catalog puts it; a picker groups by it. */
  readonly tier?: 'best' | 'balanced' | 'fast';
  /** The context window, in tokens, when the catalog says. */
  readonly context?: number;
  readonly isDefault?: true;
  readonly reasoningEfforts: readonly RuntimeReasoningChoice[];
  readonly defaultReasoningEffort?: string;
  /** Whether the model offers fast mode: `true` it does, `false` it does not, absent nobody can say. */
  readonly fast?: boolean;
  /** The model runs in fast mode unless told otherwise (its default service tier is the fast one). */
  readonly fastDefault?: true;
}

/** The catalog Codex's app-server advertised, restated for a surface. */
export interface RuntimeModelCatalog {
  readonly harness: 'codex';
  readonly source: 'codex-app-server';
  readonly choices: readonly RuntimeModelChoice[];
  /** The login's model catalog, when it reads one. */
  readonly catalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
}

/** What a login's catalog says about one model it serves: the tier and window a picker groups and describes by. */
interface DescribedModel {
  readonly id: string;
  readonly displayName?: string;
  readonly tier?: 'best' | 'balanced' | 'fast';
  readonly context?: number;
}

/** The account facts the restated catalog reads. */
export interface CatalogAccount {
  readonly models: readonly DescribedModel[];
  readonly defaultModel?: string | null;
  readonly modelCatalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
}

const catalogFacts = (model: DescribedModel): Pick<RuntimeModelChoice, 'tier' | 'context'> => ({
  ...(model.tier === undefined ? {} : { tier: model.tier }),
  ...(model.context === undefined ? {} : { context: model.context }),
});

/**
 * What one Codex account advertised, restated as the catalog. The app-server's list is the only one Codex's own
 * picker can switch to, so it stays the list; where the account's catalog describes an advertised id, the choice
 * gains that model's tier and label for the picker to group by.
 *
 * A runtime on a third-party provider is launched with a model catalog FILE of its login's catalog, so for it the
 * app-server's list IS the catalog's, in the catalog's order. Codex marks the first model it lists as the default;
 * the account says which one the runtime launches with, and when that model is on the list it is the one marked.
 */
export function codexRuntimeCatalog(
  choices: readonly RuntimeModelChoice[],
  account?: CatalogAccount,
): RuntimeModelCatalog {
  const described = new Map((account?.models ?? []).map(model => [model.id, model]));
  const launchesWith = choices.find(choice => choice.value === account?.defaultModel)?.value;
  return {
    harness: 'codex',
    source: 'codex-app-server',
    choices: choices.map(advertised => {
      const { isDefault: _advertisedDefault, ...rest } = advertised;
      const choice =
        launchesWith === undefined
          ? advertised
          : { ...rest, ...(advertised.value === launchesWith ? { isDefault: true as const } : {}) };
      const model = described.get(choice.value);
      return model === undefined
        ? choice
        : { ...choice, label: model.displayName ?? choice.label, ...catalogFacts(model) };
    }),
    ...(account?.modelCatalog === undefined ? {} : { catalog: { ...account.modelCatalog } }),
  };
}

/**
 * The model and effort values a Codex catalog offers, for a switch that must name an exact target.
 *
 * Read from what the app-server ADVERTISED, not from the restated catalog: `label` is the name Codex's own picker
 * renders the model under, and the driver finds the model's row by it.
 */
export function codexSwitchContext(choices: readonly RuntimeModelChoice[]): {
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
    readonly reasoningEfforts: readonly { readonly value: string }[];
    readonly defaultReasoningEffort?: string;
  }[];
} {
  return {
    choices: choices.map(choice => ({
      value: choice.value,
      label: choice.label,
      reasoningEfforts: choice.reasoningEfforts.map(effort => ({ value: effort.value })),
      ...(choice.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: choice.defaultReasoningEffort }),
    })),
  };
}

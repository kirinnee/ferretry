import type { MachineTool, RuntimeModelChoice, RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { DEFAULT_PACK_CONFIG, type PackConfig, type PackCredentialFacts } from '../../../contract/index.ts';
import type { ModelCatalogEntryView, ModelCatalogView } from '../../../daemon/lib/catalog.ts';
import type { PackFleetFacts } from '../../../daemon/lib/recommend.ts';

type Tier = ModelCatalogEntryView['tier'];

export function entry(
  id: string,
  label: string,
  tier: Tier,
  extra: Partial<Omit<ModelCatalogEntryView, 'id' | 'label' | 'tier'>> = {},
): ModelCatalogEntryView {
  return { id, label, tier, efforts: [], ...extra };
}

export function catalog(
  id: string,
  label: string,
  models: {
    readonly claude?: readonly ModelCatalogEntryView[];
    readonly codex?: readonly ModelCatalogEntryView[];
  } = {},
): ModelCatalogView {
  return {
    id,
    label,
    ...(models.claude === undefined ? {} : { claude: models.claude }),
    ...(models.codex === undefined ? {} : { codex: models.codex }),
  };
}

export function credential(id: string, overrides: Partial<PackCredentialFacts> = {}): PackCredentialFacts {
  return {
    id,
    status: { word: 'ready' },
    usage: { fiveHour: {}, weekly: {} },
    ...overrides,
  };
}

export function choice(id: string, label: string, extra: Partial<RuntimeModelChoice> = {}): RuntimeModelChoice {
  return { id, label, efforts: [], available: true, ...extra };
}

export function runtime(
  name: string,
  overrides: Partial<RuntimeView> & {
    readonly catalogId?: string;
    readonly customIds?: boolean;
    readonly choices?: readonly RuntimeModelChoice[];
  } = {},
): RuntimeView {
  const { catalogId, customIds, choices, ...rest } = overrides;
  const harness = rest.harness ?? 'claude-code';
  return {
    id: `${name}-id`,
    name,
    wrapper: `${name}-wrapper`,
    harness,
    credential: { id: `${name}-login`, store: 'ferretry' },
    profile: 'default',
    agent: true,
    stack: { harness, available: { available: true }, applied: [], skipped: [], conflicts: [], partial: [] },
    modelSet: { source: 'harness-default' },
    ...(catalogId === undefined
      ? {}
      : {
          models: {
            catalog: {
              id: catalogId,
              label: catalogId,
              origin: 'built-in' as const,
              customIds: customIds ?? false,
              docs: 'https://example.com/docs',
            },
            choices: choices ?? [],
          },
        }),
    launch: { available: true },
    sameAs: [],
    ...rest,
  } as RuntimeView;
}

export const tool = (harness: 'claude-code' | 'codex', installed: boolean): MachineTool => ({
  harness,
  label: harness === 'claude-code' ? 'Claude Code' : 'Codex',
  installed,
});

export function facts(parts: Partial<PackFleetFacts> = {}): PackFleetFacts {
  return { runtimes: [], credentials: [], tools: [], unlaunchable: {}, ...parts };
}

export function packConfig(
  overrides: {
    readonly enabled?: boolean;
    readonly decision?: PackConfig['decision'];
    readonly limits?: Partial<PackConfig['limits']>;
    readonly probe?: Partial<PackConfig['probe']>;
    readonly jev?: Partial<PackConfig['jev']>;
  } = {},
): PackConfig {
  return {
    enabled: overrides.enabled ?? DEFAULT_PACK_CONFIG.enabled,
    decision: overrides.decision ?? DEFAULT_PACK_CONFIG.decision,
    limits: { ...DEFAULT_PACK_CONFIG.limits, ...overrides.limits },
    probe: { ...DEFAULT_PACK_CONFIG.probe, ...overrides.probe },
    jev: { ...DEFAULT_PACK_CONFIG.jev, ...overrides.jev },
  };
}

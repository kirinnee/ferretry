import type {
  FleetCredentialView,
  FleetMachineTool,
  FleetRuntimeModelChoice,
  FleetRuntimeView,
  ModelCatalogEntryView,
  ModelCatalogView,
  PackConfig,
} from '@ferretry/protocol';
import { DEFAULT_PACK_CONFIG } from '@ferretry/protocol';
import type { PackFleetFacts } from '../../../src/lib/pack/recommend.ts';

type Tier = ModelCatalogEntryView['tier'];

export function entry(
  id: string,
  label: string,
  tier: Tier,
  extra: Partial<Omit<ModelCatalogEntryView, 'id' | 'label' | 'tier'>> = {},
): ModelCatalogEntryView {
  return { id, label, tier, efforts: [], default: false, ...extra };
}

export function catalog(
  id: string,
  label: string,
  models: {
    readonly claude?: readonly ModelCatalogEntryView[];
    readonly codex?: readonly ModelCatalogEntryView[];
    readonly customIds?: boolean;
  } = {},
): ModelCatalogView {
  return {
    id,
    label,
    origin: 'built-in',
    verified: '2026-10-01',
    customIds: models.customIds ?? false,
    ...(models.claude === undefined ? {} : { claude: models.claude }),
    ...(models.codex === undefined ? {} : { codex: models.codex }),
  };
}

export function credential(id: string, overrides: Partial<FleetCredentialView> = {}): FleetCredentialView {
  return {
    id,
    harness: 'claude',
    store: 'ferretry',
    needsLabel: false,
    sharedWithTerminal: false,
    status: {
      word: 'ready',
      label: 'Ready',
      reason: 'access_current',
      explanation: 'This login is present and current.',
      lastCheckInconclusive: false,
    },
    usage: { fiveHour: {}, weekly: {} },
    usedBy: [],
    signIn: { available: true },
    checkNow: { available: true },
    signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 0, signsOutTerminal: false },
    ...overrides,
  };
}

export function choice(
  id: string,
  label: string,
  extra: Partial<FleetRuntimeModelChoice> = {},
): FleetRuntimeModelChoice {
  return { id, label, efforts: [], available: true, ...extra };
}

export function runtime(
  name: string,
  overrides: Partial<FleetRuntimeView> & {
    readonly catalogId?: string;
    readonly customIds?: boolean;
    readonly choices?: readonly FleetRuntimeModelChoice[];
  } = {},
): FleetRuntimeView {
  const { catalogId, customIds, choices, ...rest } = overrides;
  const harness = rest.harness ?? 'claude';
  return {
    id: `${name}-id`,
    name,
    wrapper: `${name}-wrapper`,
    harness,
    credential: { id: `${name}-login`, store: 'ferretry' },
    profile: 'default',
    agent: true,
    stack: {
      harness,
      available: { available: true },
      applied: [],
      skipped: [],
      conflicts: [],
      partial: [],
    },
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
  };
}

export const tool = (harness: 'claude' | 'codex', installed: boolean): FleetMachineTool => ({
  harness,
  label: harness === 'claude' ? 'Claude Code' : 'Codex',
  installed,
});

export function facts(parts: Partial<PackFleetFacts> = {}): PackFleetFacts {
  return { runtimes: [], credentials: [], tools: [], ...parts };
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

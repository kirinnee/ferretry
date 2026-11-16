/** Runtime, login and fleet-facts builders for the Move's tests (the shapes `daemon/lib/foreign-pack.ts` reads). */
import type {
  FleetCredentialView,
  FleetMachineTool,
  FleetRuntimeView,
  PackFleetFacts,
} from '../../daemon/lib/foreign.ts';

export interface FleetRuntimeModelChoice {
  readonly id: string;
  readonly label: string;
  readonly efforts: readonly string[];
  readonly available: boolean;
}

export function credential(id: string, overrides: Partial<FleetCredentialView> = {}): FleetCredentialView {
  return {
    id,
    status: { word: 'ready' },
    usage: { fiveHour: {}, weekly: {} },
    ...overrides,
  };
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
    name,
    wrapper: `${name}-wrapper`,
    harness,
    credential: { id: `${name}-login`, store: 'ferretry' },
    agent: true,
    modelSet: { source: 'harness-default' },
    ...(catalogId === undefined
      ? {}
      : { models: { catalog: { id: catalogId, customIds: customIds ?? false }, choices: choices ?? [] } }),
    launch: { available: true },
    ...rest,
  };
}

export const tool = (harness: 'claude' | 'codex', installed: boolean): FleetMachineTool => ({
  harness,
  label: harness === 'claude' ? 'Claude Code' : 'Codex',
  installed,
});

export function facts(parts: Partial<PackFleetFacts> = {}): PackFleetFacts {
  return { runtimes: [], credentials: [], tools: [], unlaunchable: {}, ...parts };
}

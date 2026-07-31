import {
  parseRoutingCatalog,
  type CoreAccount,
  type RoutingCatalog,
  type RoutingCatalogInput,
} from '../../../src/lib/core/index.ts';

/**
 * A neutral routing catalog. The names are illustrative on purpose: the engine holds no knowledge
 * of any particular model or account, so the tests must not smuggle one in either.
 */
export const catalogInput: RoutingCatalogInput = {
  models: [
    {
      id: 'apex',
      label: 'Apex',
      family: 'claude',
      tier: 'frontier planner',
      speed: 'slow',
      cost: 'very-high',
      power: 100,
      roleScore: { planner: 100, researcher: 95, reviewer: 78 },
      implementerFit: { mechanical: 5, mid: 40, hard: 78 },
      note: 'maps blindspots before code exists',
    },
    {
      id: 'forge',
      label: 'Forge',
      family: 'codex',
      tier: 'top implementer',
      speed: 'slow',
      cost: 'very-high',
      power: 96,
      roleScore: { planner: 82, researcher: 80, reviewer: 86 },
      implementerFit: { mechanical: 20, mid: 80, hard: 95 },
      note: 'carries long many-checkpoint work',
    },
    {
      id: 'steady',
      label: 'Steady',
      family: 'claude',
      tier: 'generalist',
      speed: 'medium',
      cost: 'high',
      power: 88,
      roleScore: { planner: 92, researcher: 75, reviewer: 80 },
      implementerFit: { mechanical: 40, mid: 85, hard: 70 },
      note: 'dependable across generic work',
    },
    {
      id: 'swift',
      label: 'Swift',
      family: 'codex',
      tier: 'plan follower',
      speed: 'fast',
      cost: 'medium',
      power: 70,
      roleScore: { researcher: 60, reviewer: 72 },
      implementerFit: { mechanical: 70, mid: 76, hard: 40 },
      needsPlan: true,
      note: 'fast against a written plan',
    },
    {
      id: 'chore',
      label: 'Chore',
      family: 'claude',
      tier: 'mass chore',
      speed: 'fastest',
      cost: 'low',
      power: 40,
      roleScore: { 'fan-out': 90 },
      implementerFit: { mechanical: 88, mid: 30, hard: 0 },
      kindAffinity: { debugging: 12 },
      noProductFacing: true,
      note: 'one unit of work per agent',
    },
  ],
  accounts: [
    {
      accountId: 'account-primary',
      preferredSpend: true,
      options: [{ model: 'apex' }, { model: 'steady', modelFlag: 'steady-1' }],
    },
    { accountId: 'account-secondary', options: [{ model: 'forge' }, { model: 'swift', modelFlag: 'swift-1' }] },
    { accountId: 'account-chore', options: [{ model: 'chore' }] },
    { accountId: 'account-personal', excludedReason: 'reserved for its owner — never route work here' },
  ],
  floors: {
    planner: 88,
    reviewer: 70,
    hardAndDemanding: 96,
    hardOrCritical: 88,
    mid: 40,
    qualityFirst: 88,
  },
  costPenalty: {
    cheap: { 'very-high': 60, high: 45, medium: 20, low: 0 },
    balanced: { 'very-high': 8, high: 4, medium: 1, low: 0 },
    max: { 'very-high': 0, high: 0, medium: 0, low: 0 },
  },
};

export const catalog: RoutingCatalog = parseRoutingCatalog(catalogInput);

const model = (id: string, available = true): CoreAccount['models'][number] => ({
  id,
  available,
  ...(available ? {} : { unavailableReason: 'declared down' }),
});

export const account = (overrides: Partial<CoreAccount> & Pick<CoreAccount, 'id'>): CoreAccount => ({
  agent: overrides.id,
  kind: 'claude',
  mode: 'auto',
  displayName: overrides.id,
  defaultModel: null,
  models: [],
  available: true,
  ...overrides,
});

/** The healthy inventory the routing catalog above describes. */
export const inventory: readonly CoreAccount[] = [
  account({
    id: 'account-primary',
    agent: 'agent-primary',
    displayName: 'Primary',
    defaultModel: 'apex',
    models: [model('apex'), model('steady')],
  }),
  account({
    id: 'account-secondary',
    agent: 'agent-secondary',
    kind: 'codex',
    displayName: 'Secondary',
    defaultModel: 'forge',
    models: [model('forge'), model('swift')],
  }),
  account({
    id: 'account-chore',
    agent: 'agent-chore',
    displayName: 'Chore',
    defaultModel: 'chore',
    models: [model('chore')],
  }),
];

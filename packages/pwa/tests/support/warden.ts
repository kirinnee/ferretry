/**
 * Warden fixtures. The shapes are the protocol's own, so a wire change breaks
 * these at compile time rather than at a reader's dashboard. The settings are
 * the daemon's own defaults (`DEFAULT_WARDEN_CONFIG`), so a test states only
 * what it is about.
 */

import {
  DEFAULT_WARDEN_CONFIG,
  type FleetAgendaItem,
  type WardenAction,
  type WardenAnomaly,
  type WardenAgendaView,
  type WardenConfig,
  type WardenFailoverAccountView,
  type WardenFailoverStatus,
  type WardenInvestigation,
  type WardenStatusView,
} from '@ferretry/protocol';

export const wardenConfig = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  accounts: [{ agent: 'claude-default' }],
  ...overrides,
});

export const wardenAccount = (overrides: Partial<WardenFailoverAccountView> = {}): WardenFailoverAccountView => ({
  agent: 'claude-default',
  eligible: true,
  ...overrides,
});

export const wardenAnomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'dead_monitor',
  sessionId: 'sess-1',
  status: 'running',
  detail: 'no monitor is attached',
  ...overrides,
});

export const wardenFailover = (overrides: Partial<WardenFailoverStatus> = {}): WardenFailoverStatus => ({
  policy: 'fallback',
  failureThreshold: 3,
  cooldownMinutes: 30,
  accounts: [wardenAccount()],
  ...overrides,
});

export const wardenInvestigation = (overrides: Partial<WardenInvestigation> = {}): WardenInvestigation => ({
  id: 'warden-1',
  state: 'running',
  scope: 'session',
  origin: 'sweep',
  targetSession: 'sess-1',
  ...overrides,
});

export const wardenAction = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: '2026-07-31T11:50:00.000Z',
  sessionId: 'sess-1',
  action: 'nudge',
  outcome: 'done',
  by: 'warden',
  detail: 'Asked it to report its blocker.',
  ...overrides,
});

export const wardenStatus = (overrides: Partial<WardenStatusView> = {}): WardenStatusView => {
  const config = wardenConfig(overrides.config);
  return {
    config,
    anomalies: [],
    fingerprint: 'fp-1',
    triage: {
      jev: { configured: config.layers.jev, active: config.layers.jev, reason: 'configured' },
      llm: { configured: config.layers.llm, active: config.layers.llm, reason: 'configured' },
    },
    spend: {
      day: '2026-07-31',
      jevUsd: 0,
      jevCapUsd: config.caps.jevUsdPerDay,
      investigationUsd: 0,
      investigationCapUsd: config.caps.investigationUsdPerDay,
      pendingInvestigations: 0,
      capsHit: [],
      investigationsLastHour: 0,
      maxInvestigationsPerHour: config.caps.maxInvestigationsPerHour,
    },
    savings: { day: '2026-07-31', flags: 0, jevDecisions: 0, jevSkips: 0, investigations: 0 },
    investigations: [],
    actions: [],
    blessings: [],
    ...overrides,
  };
};

export const agendaItem = (overrides: Partial<FleetAgendaItem> = {}): FleetAgendaItem => ({
  sessionId: 'sess-1',
  id: 'item-1',
  source: 'question',
  subject: 'Which relay?',
  why: 'Waiting for your answer.',
  waitingSince: '2026-07-31T11:30:00.000Z',
  howToResolve: 'Answer it.',
  ...overrides,
});

export const wardenAgenda = (overrides: Partial<WardenAgendaView> = {}): WardenAgendaView => ({
  generatedAt: '2026-07-31T11:59:00.000Z',
  lastSweepAt: '2026-07-31T11:59:00.000Z',
  outcome: 'clean-sweep',
  items: [],
  boardsWithParseErrors: [],
  verdictCoverage: { limit: 50, truncated: false },
  ...overrides,
});

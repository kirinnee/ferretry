/**
 * Warden fixtures. The shapes are the protocol's own, so a wire change breaks
 * these at compile time rather than at a reader's dashboard.
 */

import type {
  WardenAnomaly,
  WardenConfig,
  WardenFailoverAccountView,
  WardenFailoverStatus,
  WardenStatusView,
} from '@ferretry/protocol';

const wardenConfig = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({
  enabled: true,
  accounts: [{ agent: 'claude-auto-loge' }],
  failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
  providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 40 },
  intervalMinutes: 5,
  unattendedMinutes: 20,
  minSpawnGapMinutes: 10,
  susThinkingSeconds: 600,
  susSubprocessSeconds: 900,
  maxAssignedWardens: 2,
  assignedCooldownMinutes: 15,
  blessMinutes: 30,
  ...overrides,
});

export const wardenAccount = (overrides: Partial<WardenFailoverAccountView> = {}): WardenFailoverAccountView => ({
  agent: 'claude-auto-loge',
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

export const wardenStatus = (overrides: Partial<WardenStatusView> = {}): WardenStatusView => ({
  config: wardenConfig(overrides.config),
  anomalies: [],
  fingerprint: 'fp-1',
  ...overrides,
});

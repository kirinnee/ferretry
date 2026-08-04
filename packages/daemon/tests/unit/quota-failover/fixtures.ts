import type { AccountUsage, SessionStatus } from '@ferretry/protocol';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import {
  type QuotaFailoverConfig,
  QuotaFailoverConfigSchema,
  type QuotaFailoverSession,
} from '../../../src/lib/quota-failover/index.ts';

/** A usage row that says nothing at all, so every test states only the facts it is about. */
export const usageRow = (agent: string, overrides: Partial<AccountUsage> = {}): AccountUsage => ({
  agent,
  ...overrides,
});

/** A row the feed has positively scored as healthy at `percent` of its tighter window. */
export const healthyRow = (agent: string, percent: number, overrides: Partial<AccountUsage> = {}): AccountUsage =>
  usageRow(agent, { ok: true, authOk: true, atLimit: false, fiveHourPercent: percent, ...overrides });

/** A row the feed has positively scored as out of tokens. */
export const spentRow = (agent: string, overrides: Partial<AccountUsage> = {}): AccountUsage =>
  usageRow(agent, { ok: true, authOk: true, atLimit: true, fiveHourPercent: 100, ...overrides });

export const account = (agent: string, overrides: Partial<CoreAccount> = {}): CoreAccount => ({
  id: `id-${agent}`,
  agent,
  kind: 'claude',
  mode: 'auto',
  displayName: agent,
  defaultModel: 'a-model',
  models: [],
  available: true,
  ...overrides,
});

export const session = (
  id: string,
  agent: string,
  overrides: Partial<QuotaFailoverSession> = {},
): QuotaFailoverSession => ({ id, agent, harness: 'claude', status: 'running' as SessionStatus, ...overrides });

/** A configuration with the pool named and everything else defaulted. */
export const config = (overrides: Partial<QuotaFailoverConfig> = {}): QuotaFailoverConfig =>
  QuotaFailoverConfigSchema.parse({ enabled: true, accounts: ['agent-a', 'agent-b'], ...overrides });

export const AT = Date.parse('2026-01-01T00:00:00.000Z');

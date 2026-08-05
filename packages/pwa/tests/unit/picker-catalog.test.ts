import { describe, expect, it } from 'bun:test';
import type { FleetHealthSnapshot, FleetUsageSnapshot } from '@ferretry/fleet';
import type { FleetManifestSummary, SessionView } from '@ferretry/protocol';

import {
  type PickerCatalogClient,
  readAccountPickerCatalog,
  recentProjectPaths,
} from '../../src/components/picker-catalog.ts';
import { sessionView } from '../support/sessions.ts';

const account = (id: string, wrapper: string): FleetManifestSummary['accounts'][number] => ({
  id,
  kind: wrapper.startsWith('claude') ? 'claude' : 'codex',
  mode: 'auto',
  wrapper,
  home: `/accounts/${id}`,
  displayName: wrapper === 'claude-auto-a' ? 'Claude Atelier' : 'Codex Forge',
  defaultModel: wrapper.startsWith('claude') ? 'opus' : 'sol',
  models: [{ id: wrapper.startsWith('claude') ? 'opus' : 'sol', available: true }],
  available: true,
  unavailableReason: null,
});

const CLAUDE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

const manifest: FleetManifestSummary = {
  version: 1,
  generatedAt: '2026-08-05T12:00:00.000Z',
  accounts: [
    account(CLAUDE_ACCOUNT_ID, 'claude-auto-a'),
    account('22222222-2222-4222-8222-222222222222', 'codex-auto-b'),
  ],
};

const usageAccount: FleetUsageSnapshot['accounts'][number] = {
  accountId: CLAUDE_ACCOUNT_ID,
  kind: 'claude',
  usageBased: false,
  ok: true,
  unavailable: false,
  shortWindow: { usedPercent: 21 },
  longWindow: { usedPercent: 44 },
  atLimit: false,
};

const usage: FleetUsageSnapshot = {
  at: Date.parse('2026-08-05T12:00:00.000Z'),
  accounts: [usageAccount],
};

const healthAccount: FleetHealthSnapshot['accounts'][number] = {
  accountId: CLAUDE_ACCOUNT_ID,
  kind: 'claude',
  state: 'healthy',
  cached: true,
  checkedAt: Date.parse('2026-08-05T11:59:00.000Z'),
  ms: 320,
};

const health: FleetHealthSnapshot = {
  at: Date.parse('2026-08-05T12:00:00.000Z'),
  accounts: [healthAccount],
};

interface ClientFixture {
  readonly client: PickerCatalogClient;
  readonly paths: string[];
}

const clientFixture = (overrides: Partial<Record<string, unknown>> = {}): ClientFixture => {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    '/v1/fleet/accounts': manifest,
    '/v1/fleet/usage': usage,
    '/v1/fleet/health': health,
    ...overrides,
  };
  return {
    paths,
    client: {
      request: async path => {
        paths.push(path);
        const response = responses[path];
        if (response instanceof Error) throw response;
        return response as never;
      },
    },
  };
};

describe('recentProjectPaths', () => {
  it('deduplicates canonical session paths and keeps the newest evidence first', () => {
    const sessions: SessionView[] = [
      sessionView('a', {
        config: { cwd: '/work/same', updatedAt: '2026-08-01T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-01T00:00:00.000Z' },
      }),
      sessionView('b', {
        config: { cwd: '/work/other', updatedAt: '2026-08-02T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-02T00:00:00.000Z' },
      }),
      sessionView('c', {
        config: { cwd: ' /work/same/ ', updatedAt: '2026-08-03T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-03T00:00:00.000Z' },
      }),
    ];

    expect(recentProjectPaths(sessions)).toEqual([
      { path: '/work/same', lastActivity: '2026-08-03T00:00:00.000Z' },
      { path: '/work/other', lastActivity: '2026-08-02T00:00:00.000Z' },
    ]);
  });
});

describe('readAccountPickerCatalog', () => {
  it('reads the roster and live feeds from one bound client and joins live state by stable account id', async () => {
    const fixture = clientFixture();
    const catalog = await readAccountPickerCatalog(fixture.client);

    expect(fixture.paths).toEqual(['/v1/fleet/accounts', '/v1/fleet/usage', '/v1/fleet/health']);
    expect(catalog.accounts?.map(row => row.wrapper)).toEqual(['claude-auto-a', 'codex-auto-b']);
    expect(catalog.usage.get(CLAUDE_ACCOUNT_ID)?.shortWindow?.usedPercent).toBe(21);
    expect(catalog.health.get(CLAUDE_ACCOUNT_ID)?.state).toBe('healthy');
  });

  it('distinguishes an unreadable roster from a positively empty one without hiding independent live evidence', async () => {
    const broken = clientFixture({ '/v1/fleet/accounts': new Error('manifest damaged') });
    const unavailable = await readAccountPickerCatalog(broken.client);

    expect(unavailable.accounts).toBeNull();
    expect(unavailable.accountsError).toBe('manifest damaged');
    expect(unavailable.health.get(CLAUDE_ACCOUNT_ID)?.state).toBe('healthy');

    const empty = clientFixture({
      '/v1/fleet/accounts': { ...manifest, accounts: [] },
    });
    const available = await readAccountPickerCatalog(empty.client);
    expect(available.accounts).toEqual([]);
    expect(available.accountsError).toBeNull();
  });

  it('removes duplicate live rows instead of selecting one ambiguous answer', async () => {
    const duplicate: FleetUsageSnapshot = {
      ...usage,
      accounts: [usageAccount, { ...usageAccount, atLimit: true }],
    };
    const fixture = clientFixture({ '/v1/fleet/usage': duplicate });
    const catalog = await readAccountPickerCatalog(fixture.client);

    expect(catalog.usage.has(CLAUDE_ACCOUNT_ID)).toBeFalse();
    expect(catalog.usageError).toContain('ambiguous');
  });
});

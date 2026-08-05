import { describe, expect, it } from 'bun:test';
import type { FleetManifestSummary, SessionView } from '@ferretry/protocol';

import {
  type PickerAccountHealth,
  type PickerCatalogClient,
  readAccountPickerCatalog,
  readAccountPickerHealth,
  recentProjectPaths,
} from '../../src/lib/account-picker-catalog.ts';
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
const CODEX_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

const manifest: FleetManifestSummary = {
  version: 1,
  generatedAt: '2026-08-05T12:00:00.000Z',
  accounts: [account(CLAUDE_ACCOUNT_ID, 'claude-auto-a'), account(CODEX_ACCOUNT_ID, 'codex-auto-b')],
};

const healthAccount: PickerAccountHealth = {
  accountId: CLAUDE_ACCOUNT_ID,
  kind: 'claude',
  state: 'healthy',
  cached: true,
  checkedAt: Date.parse('2026-08-05T11:59:00.000Z'),
  ms: 320,
};

interface ClientFixture {
  readonly client: PickerCatalogClient;
  readonly paths: string[];
}

const clientFixture = (overrides: Partial<Record<string, unknown>> = {}): ClientFixture => {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    '/v1/fleet/accounts': manifest,
    '/v1/fleet/health': {
      at: Date.parse('2026-08-05T12:00:00.000Z'),
      accounts: [healthAccount],
    },
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
  it('deduplicates canonical paths, ignores blanks, and orders the newest evidence first', () => {
    const sessions: SessionView[] = [
      sessionView('a', {
        config: { cwd: '/work/same', updatedAt: '2026-08-01T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-01T00:00:00.000Z' },
      }),
      sessionView('blank', {
        config: { cwd: '   ', updatedAt: '2026-08-04T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-04T00:00:00.000Z' },
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

  it('uses the path as a deterministic tiebreaker', () => {
    const sessions = [
      sessionView('z', { config: { cwd: '/work/z', updatedAt: '2026-08-01T00:00:00.000Z' } }),
      sessionView('a', { config: { cwd: '/work/a', updatedAt: '2026-08-01T00:00:00.000Z' } }),
    ];

    expect(recentProjectPaths(sessions).map(row => row.path)).toEqual(['/work/a', '/work/z']);
  });
});

describe('readAccountPickerCatalog', () => {
  it('reads only the cheap published roster from one daemon-bound client', async () => {
    const fixture = clientFixture();
    const catalog = await readAccountPickerCatalog(fixture.client);

    expect(fixture.paths).toEqual(['/v1/fleet/accounts']);
    expect(catalog.accounts.map(row => row.wrapper)).toEqual(['claude-auto-a', 'codex-auto-b']);
  });

  it('keeps a positively empty roster distinct from a rejected read', async () => {
    const empty = clientFixture({ '/v1/fleet/accounts': { ...manifest, accounts: [] } });
    expect((await readAccountPickerCatalog(empty.client)).accounts).toEqual([]);

    const broken = clientFixture({ '/v1/fleet/accounts': new Error('manifest damaged') });
    await expect(readAccountPickerCatalog(broken.client)).rejects.toThrow('manifest damaged');
    expect(broken.paths).toEqual(['/v1/fleet/accounts']);
  });
});

describe('readAccountPickerHealth', () => {
  it('runs the expensive probe only through the explicit health reader', async () => {
    const fixture = clientFixture();
    const result = await readAccountPickerHealth(fixture.client);

    expect(fixture.paths).toEqual(['/v1/fleet/health']);
    expect(result.error).toBeNull();
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.state).toBe('healthy');
  });

  it('drops every duplicate account row while preserving unambiguous evidence', async () => {
    const codexHealth: PickerAccountHealth = {
      ...healthAccount,
      accountId: CODEX_ACCOUNT_ID,
      kind: 'codex',
      state: 'unknown',
      cached: false,
      failureKind: 'launch',
      error: 'wrapper was unavailable',
    };
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [healthAccount, { ...healthAccount, state: 'down' }, healthAccount, codexHealth],
      },
    });
    const result = await readAccountPickerHealth(fixture.client);

    expect(result.health.has(CLAUDE_ACCOUNT_ID)).toBeFalse();
    expect(result.health.get(CODEX_ACCOUNT_ID)).toEqual(codexHealth);
    expect(result.error).toContain('ambiguous');
  });
});

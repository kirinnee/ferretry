import { describe, expect, it } from 'bun:test';
import type { FleetManifestSummary, SessionView } from '@ferretry/protocol';

import {
  checkAccountPickerHealth,
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

const CHECKED_AT = Date.parse('2026-08-05T11:59:00.000Z');

const healthAccount: PickerAccountHealth = {
  accountId: CLAUDE_ACCOUNT_ID,
  kind: 'claude',
  verdict: 'healthy',
  reason: 'provider_accepted',
  evidence: 'anthropic_usage',
  lastCheckedAt: CHECKED_AT,
  verdictAt: CHECKED_AT,
  lastCheckInconclusive: false,
};

interface ClientFixture {
  readonly client: PickerCatalogClient;
  readonly paths: string[];
  /** The verb each call used, so a read cannot quietly become a write. */
  readonly methods: (string | undefined)[];
}

const clientFixture = (overrides: Partial<Record<string, unknown>> = {}): ClientFixture => {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    '/v1/fleet/accounts': manifest,
    '/v1/fleet/health': {
      at: Date.parse('2026-08-05T12:00:00.000Z'),
      accounts: [healthAccount],
    },
    '/v1/fleet/health/check': {
      at: Date.parse('2026-08-05T12:00:00.000Z'),
      accounts: [healthAccount],
    },
    ...overrides,
  };
  const methods: (string | undefined)[] = [];
  return {
    paths,
    methods,
    client: {
      // Parses through the caller's own schema, so a fixture cannot smuggle in a
      // shape the real daemon reader would have refused — or refuse one it accepts.
      request: async (path, schema, init) => {
        paths.push(path);
        methods.push(init?.method);
        const response = responses[path];
        if (response instanceof Error) throw response;
        return schema.parse(response);
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
  it('reads the stored snapshot with a plain GET', async () => {
    // Arrange / Act
    const fixture = clientFixture();
    const result = await readAccountPickerHealth(fixture.client);

    // Assert — A GET, and only a GET. That is the whole reason the store may now hydrate this on
    // mount: the daemon answers it from its own file and checks nothing to do so. The reader that
    // COLLECTS is a different function on a different verb, below.
    expect(fixture.paths).toEqual(['/v1/fleet/health']);
    expect(fixture.methods).toEqual([undefined]);
    expect(result.error).toBeNull();
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.verdict).toBe('healthy');
  });

  it('carries the never-checked case through as null rather than an instant', async () => {
    // Arrange
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [
          { ...healthAccount, verdict: 'unknown', reason: 'never_checked', lastCheckedAt: null, verdictAt: null },
        ],
      },
    });

    // Act
    const result = await readAccountPickerHealth(fixture.client);

    // Assert — the schema this replaced required a number, so this case arrived as a fabricated "now"
    // and was indistinguishable from a check that had just succeeded.
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.lastCheckedAt).toBeNull();
  });

  it('accepts the stale marker so a reader can be told what the verdict WAS', async () => {
    // Arrange
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [{ ...healthAccount, verdict: 'unknown', reason: 'stale', staleVerdict: 'healthy' }],
      },
    });

    // Act
    const result = await readAccountPickerHealth(fixture.client);

    // Assert
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.staleVerdict).toBe('healthy');
  });

  it('keeps a snapshot whose harness kind this build has never heard of', async () => {
    const unfamiliar: PickerAccountHealth = { ...healthAccount, accountId: CODEX_ACCOUNT_ID, kind: 'gemini' };
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [healthAccount, unfamiliar],
      },
    });
    const result = await readAccountPickerHealth(fixture.client);

    expect(result.error).toBeNull();
    expect(result.health.get(CODEX_ACCOUNT_ID)).toEqual(unfamiliar);
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.verdict).toBe('healthy');
  });

  it('still refuses a health row with no harness kind at all', async () => {
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [{ ...healthAccount, kind: '' }],
      },
    });

    await expect(readAccountPickerHealth(fixture.client)).rejects.toThrow();
  });

  it('refuses a verdict this build does not have words for', async () => {
    // Arrange — the copy table is exhaustive over the enum, so an unknown member would render as
    // `undefined` on screen rather than failing loudly here.
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [{ ...healthAccount, verdict: 'probably_fine' }],
      },
    });

    // Act / Assert
    await expect(readAccountPickerHealth(fixture.client)).rejects.toThrow();
  });

  it('drops every duplicate account row while preserving unambiguous evidence', async () => {
    const codexHealth: PickerAccountHealth = {
      ...healthAccount,
      accountId: CODEX_ACCOUNT_ID,
      kind: 'codex',
      verdict: 'unknown',
      reason: 'codex_liveness_unproven',
      evidence: 'none',
      verdictAt: null,
    };
    const fixture = clientFixture({
      '/v1/fleet/health': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [
          healthAccount,
          { ...healthAccount, verdict: 'needs_relogin', reason: 'oauth_token_rejected' },
          healthAccount,
          codexHealth,
        ],
      },
    });
    const result = await readAccountPickerHealth(fixture.client);

    expect(result.health.has(CLAUDE_ACCOUNT_ID)).toBeFalse();
    expect(result.health.get(CODEX_ACCOUNT_ID)).toEqual(codexHealth);
    expect(result.error).toContain('ambiguous');
  });
});

describe('checkAccountPickerHealth', () => {
  it('POSTs to the check route and answers with the snapshot', async () => {
    // Arrange / Act
    const fixture = clientFixture();
    const result = await checkAccountPickerHealth(fixture.client);

    // Assert — a POST because it RECORDS a reading, on a different path from the read. Two functions
    // rather than one with a flag: a boolean parameter would put "does this write" behind a call-site
    // argument, which is the shape that let a read reach a spending probe before.
    expect(fixture.paths).toEqual(['/v1/fleet/health/check']);
    expect(fixture.methods).toEqual(['POST']);
    expect(result.health.get(CLAUDE_ACCOUNT_ID)?.verdict).toBe('healthy');
  });

  it('applies the same duplicate-row rule as the read', async () => {
    // Arrange — one parser, one ambiguity rule. Two would eventually disagree about whether a damaged
    // response is safe to render.
    const fixture = clientFixture({
      '/v1/fleet/health/check': {
        at: Date.parse('2026-08-05T12:00:00.000Z'),
        accounts: [healthAccount, healthAccount],
      },
    });

    // Act
    const result = await checkAccountPickerHealth(fixture.client);

    // Assert
    expect(result.health.has(CLAUDE_ACCOUNT_ID)).toBeFalse();
    expect(result.error).toContain('ambiguous');
  });
});

import { describe, it } from 'bun:test';
import { buildFleetManifest, type FleetManifest } from '@ferretry/fleet';
import type { FleetCredentialList, FleetCredentialView } from '@ferretry/protocol';
import should from 'should';
import { CredentialUsageSource, credentialUsageRows } from '../../../src/lib/usage/credential-usage.ts';
import { quotaFromUsage, usageForAgent } from '../../../src/lib/usage/index.ts';

const WRITER_ID = '4c0f3b6e-7a91-4a2f-9a7f-2b1d0f5c8e31';
const REVIEWER_ID = '9d2e1a44-3c57-4b18-8f60-7c9a5e2d1b03';
const ORPHAN_ID = '1f7c8d92-58a1-4f3e-9c26-0a4b7e6d5f88';

const runtime = (id: string, name: string, credential: string) => ({
  id,
  name,
  harness: 'claude' as const,
  credential,
  profile: 'default',
  agent: true,
  wrapper: `/state/fleet/bin/${name}`,
  models: [{ id: 'sonnet', available: true }],
  defaultModel: 'sonnet',
});

const manifest = (...runtimes: ReturnType<typeof runtime>[]): FleetManifest =>
  buildFleetManifest({ generatedAt: '2026-10-13T08:00:00.000Z', accounts: [], runtimes });

const credential = (overrides: Partial<FleetCredentialView> = {}): FleetCredentialView => ({
  id: 'work',
  harness: 'claude',
  store: 'ferretry',
  needsLabel: false,
  sharedWithTerminal: false,
  status: {
    word: 'ready',
    label: 'Ready',
    reason: 'not_checked_yet',
    explanation: 'This login is present and current.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: {} },
  usedBy: ['claude-writer'],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 1, signsOutTerminal: false },
  ...overrides,
});

const status = (word: FleetCredentialView['status']['word']): FleetCredentialView['status'] => ({
  ...credential().status,
  word,
});

const list = (...credentials: FleetCredentialView[]): FleetCredentialList => ({
  format: 2,
  machine: 'studio',
  credentials,
});

describe('credentialUsageRows', () => {
  /**
   * THE JOIN IS THE FEATURE. `agent` is the executable name a session launches with — the value
   * Warden autoMigrate hands to `migrate(...)` and the advisor matches on. Keying by the credential or the
   * runtime id would satisfy every schema and match nothing, so failover would quietly stop moving
   * sessions off exhausted logins. This test fails if anyone ever does.
   */
  it('should key each row by the executable name, one row per runtime on the credential', () => {
    // Act
    const rows = credentialUsageRows(
      manifest(runtime(WRITER_ID, 'claude-writer', 'work'), runtime(REVIEWER_ID, 'claude-reviewer', 'work')),
      [credential()],
    );

    // Assert
    should(rows.map(row => row.agent)).deepEqual(['claude-writer', 'claude-reviewer']);
    should(usageForAgent(rows, 'claude-writer')).not.be.undefined();
    should(rows.some(row => row.agent === WRITER_ID || row.agent === 'work')).be.false();
  });

  it('should carry both windows, bounded to 100, with their reset instants', () => {
    // Arrange
    const reading = credential({
      usage: {
        fiveHour: { usedPercent: 42, resetsAt: '2026-10-13T09:00:00.000Z' },
        weekly: { usedPercent: 140, resetsAt: '2026-10-20T00:00:00.000Z' },
      },
    });

    // Act
    const [row] = credentialUsageRows(manifest(runtime(WRITER_ID, 'claude-writer', 'work')), [reading]);

    // Assert
    should(row).deepEqual({
      agent: 'claude-writer',
      ok: true,
      authOk: true,
      availability: 'available',
      unavailable: false,
      atLimit: true,
      fiveHourPercent: 42,
      weeklyPercent: 100,
      fiveHourResetAt: Date.parse('2026-10-13T09:00:00.000Z'),
      weeklyResetAt: Date.parse('2026-10-20T00:00:00.000Z'),
    });
  });

  it('should leave an absent window absent rather than reporting zero percent', () => {
    // Act
    const [row] = credentialUsageRows(manifest(runtime(WRITER_ID, 'claude-writer', 'work')), [
      credential({ status: status('refresh_due'), usage: { fiveHour: { usedPercent: 12 }, weekly: {} } }),
    ]);

    // Assert — unknown is not exhausted, and it is not empty either.
    should(row?.fiveHourPercent).equal(12);
    should(row?.atLimit).be.false();
    should(row?.availability).equal('available');
    should(row).not.have.property('weeklyPercent');
    should(row).not.have.property('fiveHourResetAt');
    should(row).not.have.property('weeklyResetAt');
  });

  it('should carry a signed-out login as a proven unavailability for auth', () => {
    // Act
    const [row] = credentialUsageRows(manifest(runtime(WRITER_ID, 'claude-writer', 'work')), [
      credential({ status: status('needs_sign_in') }),
    ]);

    // Assert
    should(row).deepEqual({
      agent: 'claude-writer',
      ok: true,
      authOk: false,
      availability: 'unavailable',
      unavailable: true,
      unavailableReason: 'auth',
      atLimit: false,
    });
  });

  it('should state nothing about a login whose check has not concluded', () => {
    // Act
    const [row] = credentialUsageRows(manifest(runtime(WRITER_ID, 'claude-writer', 'work')), [
      credential({ status: status('checking') }),
    ]);

    // Assert
    should(row).deepEqual({ agent: 'claude-writer', ok: false });
    should(quotaFromUsage(row as NonNullable<typeof row>)).deepEqual({});
  });

  it('should drop a runtime whose credential the list does not carry', () => {
    // Act
    const rows = credentialUsageRows(
      manifest(runtime(WRITER_ID, 'claude-writer', 'work'), runtime(ORPHAN_ID, 'claude-orphan', 'gone')),
      [credential()],
    );

    // Assert
    should(rows.map(row => row.agent)).deepEqual(['claude-writer']);
  });
});

describe('CredentialUsageSource', () => {
  const published = manifest(runtime(WRITER_ID, 'claude-writer', 'work'));
  const source = (overrides: Partial<ConstructorParameters<typeof CredentialUsageSource>[0]> = {}) =>
    new CredentialUsageSource({
      enabled: async () => true,
      manifest: async () => published,
      credentials: async () => list(credential()),
      ...overrides,
    });

  it('should read the credentials list through the published manifest', async () => {
    // Act
    const rows = await source().read();

    // Assert
    should(rows?.map(row => row.agent)).deepEqual(['claude-writer']);
  });

  it('should answer nothing when unattended collection is switched off, without reading anything', async () => {
    // Arrange
    let read = false;
    const subject = source({
      enabled: async () => false,
      credentials: async () => {
        read = true;
        return list(credential());
      },
    });

    // Act
    const rows = await subject.read();

    // Assert
    should(rows).be.undefined();
    should(read).be.false();
  });

  it('should answer nothing for a machine no apply has published yet', async () => {
    // Act
    const rows = await source({ manifest: async () => undefined }).read();

    // Assert
    should(rows).be.undefined();
  });

  it('should report a failure as unreadable, never as a fleet with no logins', async () => {
    // Act
    const rows = await source({
      credentials: async () => {
        throw new Error('config.yaml uses the old account format');
      },
    }).read();

    // Assert
    should(rows).be.undefined();
  });

  it('should abandon a read that was already cancelled', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();

    // Act
    const rows = await source().read(controller.signal);

    // Assert
    should(rows).be.undefined();
  });
});

describe('credentialUsageRows — environment logins (docs/provider-quotas.md)', () => {
  it('should carry the provider reading: at-limit when the provider says so, and the money it reported', () => {
    // Arrange
    const provider = {
      source: 'deepseek-balance' as const,
      via: 'endpoint' as const,
      windows: [],
      balance: { amount: 0, currency: 'USD' },
      spend: { amountUsd: 2, since: '2026-10-01T00:00:00.000Z', sessions: 1, unpriced: 0 },
      exhausted: true,
      unverified: false,
      at: '2026-10-16T09:00:00.000Z',
    };
    const ds = credential({ id: 'ds', store: 'environment', usage: { fiveHour: {}, weekly: {}, provider } });
    const { balance: _balance, spend: _spend, ...bare } = provider;
    const unknown = credential({
      id: 'quiet',
      store: 'environment',
      usage: { fiveHour: {}, weekly: {}, provider: { ...bare, via: 'unknown' } },
    });

    // Act
    const rows = credentialUsageRows(
      manifest(runtime(WRITER_ID, 'claude-writer', 'ds'), runtime(REVIEWER_ID, 'claude-reviewer', 'quiet')),
      [ds, unknown],
    );

    // Assert
    should(rows[0]).containDeep({
      agent: 'claude-writer',
      atLimit: true,
      balance: { amount: 0, currency: 'USD' },
      spendUsd: 2,
    });
    should(rows[1]).containDeep({ agent: 'claude-reviewer', atLimit: false });
    should(rows[1]).not.have.property('balance');
  });
});

describe('credentialUsageRows with a limit proven by a pane', () => {
  const limits = new Map([
    ['claude-writer', { notice: "You've hit your org's monthly spend limit", spend: true, retryAt: 5_000 }],
  ]);

  it('should read a spend-limited login as at its limit, unavailable for spend_limit, until the reset', () => {
    // Act
    const rows = credentialUsageRows(
      manifest(runtime(WRITER_ID, 'claude-writer', 'work'), runtime(REVIEWER_ID, 'claude-reviewer', 'other')),
      [credential(), credential({ id: 'other' })],
      limits,
    );

    // Assert
    should(rows[0]).containEql({
      agent: 'claude-writer',
      atLimit: true,
      unavailable: true,
      unavailableReason: 'spend_limit',
      availability: 'unavailable',
      retryAt: 5_000,
    });
    should(rows[1]?.atLimit).be.false();
    should(rows[1]?.unavailableReason).be.undefined();
  });

  it('should leave a login that needs signing in an auth problem', () => {
    // Act
    const [row] = credentialUsageRows(
      manifest(runtime(WRITER_ID, 'claude-writer', 'work')),
      [credential({ status: status('needs_sign_in') })],
      limits,
    );

    // Assert
    should(row?.unavailableReason).equal('auth');
  });
});

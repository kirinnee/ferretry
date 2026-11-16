import { describe, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import { LoginIdSchema, type LoginView } from '../../../contract/index.ts';
import should from 'should';
import { CredentialUsageSource, credentialUsageRows } from '../../../daemon/lib/usage/credential-usage.ts';
import { quotaFromUsage } from '../../../daemon/lib/usage/index.ts';

const at = (iso: string) => instantFromEpochMs(Date.parse(iso));

const login = (overrides: Partial<Omit<LoginView, 'id'>> & { readonly id?: string } = {}): LoginView => ({
  harness: 'claude-code',
  harnesses: ['claude-code'],
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
  usedBy: [],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 1, signsOutTerminal: false },
  ...overrides,
  id: LoginIdSchema.parse(overrides.id ?? 'work'),
});

const status = (word: LoginView['status']['word']): LoginView['status'] => ({ ...login().status, word });

describe('credentialUsageRows', () => {
  /**
   * THE JOIN IS THE FEATURE. `agent` is the LOGIN ID — the value Packs' recommendation, Warden and Start match on. Keying
   * by anything else would satisfy every schema and match nothing, so failover would quietly stop moving ferrets off
   * exhausted logins. This test fails if anyone ever does.
   */
  it('should key each row by the login id, one row per login', () => {
    // Act
    const rows = credentialUsageRows([login(), login({ id: 'review' })]);

    // Assert
    should(rows.map(row => row.agent)).deepEqual(['work', 'review']);
  });

  it('should carry both windows, bounded to 100, with their reset instants', () => {
    // Arrange
    const reading = login({
      usage: {
        fiveHour: { usedPercent: 42, resetsAt: at('2026-10-13T09:00:00.000Z') },
        weekly: { usedPercent: 140, resetsAt: at('2026-10-20T00:00:00.000Z') },
      },
    });

    // Act
    const [row] = credentialUsageRows([reading]);

    // Assert
    should(row).deepEqual({
      agent: 'work',
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
    const [row] = credentialUsageRows([
      login({ status: status('refresh_due'), usage: { fiveHour: { usedPercent: 12 }, weekly: {} } }),
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
    const [row] = credentialUsageRows([login({ status: status('needs_sign_in') })]);

    // Assert
    should(row).deepEqual({
      agent: 'work',
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
    const [row] = credentialUsageRows([login({ status: status('checking') })]);

    // Assert
    should(row).deepEqual({ agent: 'work', ok: false });
    should(quotaFromUsage(row as NonNullable<typeof row>)).deepEqual({});
  });
});

describe('CredentialUsageSource', () => {
  const source = (overrides: Partial<ConstructorParameters<typeof CredentialUsageSource>[0]> = {}) =>
    new CredentialUsageSource({ enabled: async () => true, credentials: async () => [login()], ...overrides });

  it('should read the logins through Logins', async () => {
    // Act
    const rows = await source().read();

    // Assert
    should(rows?.map(row => row.agent)).deepEqual(['work']);
  });

  it('should answer nothing when unattended collection is switched off, without reading anything', async () => {
    // Arrange
    let read = false;
    const subject = source({
      enabled: async () => false,
      credentials: async () => {
        read = true;
        return [login()];
      },
    });

    // Act
    const rows = await subject.read();

    // Assert
    should(rows).be.undefined();
    should(read).be.false();
  });

  it('should report a failure as unreadable, never as a machine with no logins', async () => {
    // Act
    const rows = await source({
      credentials: async () => {
        throw new Error('Logins did not answer');
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
      spend: { amountUsd: 2, since: at('2026-10-01T00:00:00.000Z'), sessions: 1, unpriced: 0 },
      exhausted: true,
      unverified: false,
      at: at('2026-10-16T09:00:00.000Z'),
    };
    const ds = login({ id: 'ds', store: 'environment', usage: { fiveHour: {}, weekly: {}, provider } });
    const { balance: _balance, spend: _spend, ...bare } = provider;
    const quiet = login({
      id: 'quiet',
      store: 'environment',
      usage: { fiveHour: {}, weekly: {}, provider: { ...bare, via: 'unknown' } },
    });

    // Act
    const rows = credentialUsageRows([ds, quiet]);

    // Assert
    should(rows[0]).containDeep({ agent: 'ds', atLimit: true, balance: { amount: 0, currency: 'USD' }, spendUsd: 2 });
    should(rows[1]).containDeep({ agent: 'quiet', atLimit: false });
    should(rows[1]).not.have.property('balance');
  });
});

describe('credentialUsageRows with a limit proven by a pane', () => {
  const limits = new Map([
    ['work', { notice: "You've hit your org's monthly spend limit", spend: true, retryAt: 5_000 }],
  ]);

  it('should read a spend-limited login as at its limit, unavailable for spend_limit, until the reset', () => {
    // Act
    const rows = credentialUsageRows([login(), login({ id: 'other' })], limits);

    // Assert
    should(rows[0]).containEql({
      agent: 'work',
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
    const [row] = credentialUsageRows([login({ status: status('needs_sign_in') })], limits);

    // Assert
    should(row?.unavailableReason).equal('auth');
  });
});

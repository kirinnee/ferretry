/**
 * The account model's credential status and usage (design §8.1.2–§8.2.3).
 *
 * Every token below is a FAKE: a JWT is three base64url segments whose payload is JSON this file
 * wrote, and nothing here ever reaches a provider.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CredentialStoreResolution, StoredCredentialResolution } from '../../src/lib/account/credentials.ts';
import {
  activeUsageReading,
  CODEX_LAST_REFRESH_MAX_AGE_MS,
  CREDENTIAL_NEGATIVE_FRESH_MS,
  CREDENTIAL_STATUS_LABELS,
  CREDENTIAL_STATUS_SHAPES,
  type CodexAuthFacts,
  type CredentialStatusHead,
  type CredentialStatusPorts,
  CredentialStatusService,
  chooseCredentialUsage,
  codexFileAdvanced,
  codexPlanType,
  decideClaudeStatus,
  decideCodexStatus,
  decideStorelessStatus,
  foldClaudeSignal,
  foldCodexRefresh,
  InMemoryCredentialStatusStore,
  needsActiveUsageRead,
  passiveUsageReading,
  readCodexAuthFacts,
  usagePercentLabel,
} from '../../src/lib/account/credential-status.ts';
import type { LocalCredentialReading } from '../../src/lib/health.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';
import type { FleetTokenRefreshAttempt, FleetTokenRefreshPort } from '../../src/lib/token-refresh.ts';
import type { FleetUsageProbeResult, PassiveUsageRecord } from '../../src/lib/usage.ts';

const NOW = 1_786_000_000_000;
const MINUTE = 60_000;

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (payload: unknown): string => `${segment({ alg: 'none' })}.${segment(payload)}.sig`;

const codexBlob = (patch: Record<string, unknown> = {}, tokens: Record<string, unknown> | null = {}): string =>
  JSON.stringify({
    last_refresh: new Date(NOW - MINUTE).toISOString(),
    tokens:
      tokens === null
        ? null
        : {
            access_token: fakeJwt({ exp: (NOW + 60 * MINUTE) / 1000 }),
            refresh_token: 'fake-refresh',
            id_token: fakeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
            ...tokens,
          },
    ...patch,
  });

const found = (blob: string): CredentialMaterial => ({ outcome: 'found', blob });

const tokens = (patch: Partial<Extract<CodexAuthFacts, { state: 'tokens' }>> = {}): CodexAuthFacts => ({
  state: 'tokens',
  hasAccess: true,
  hasRefresh: true,
  accessExpiresAt: NOW + 60 * MINUTE,
  lastRefreshAt: NOW - MINUTE,
  ...patch,
});

const CLAUDE: StoredCredentialResolution = {
  harness: 'claude',
  store: 'ferretry',
  secureStorage: '/fy/fleet/credentials/work',
  storageDirectory: '/fy/fleet/credentials/work',
  credentialFile: '/fy/fleet/credentials/work/.credentials.json',
  ownedDirectory: '/fy/fleet/credentials/work',
};
const CODEX: StoredCredentialResolution = {
  harness: 'codex',
  store: 'ferretry',
  canonicalFile: '/fy/fleet/credentials/cx/auth.json',
  ownedDirectory: '/fy/fleet/credentials/cx',
};

const passive = (at: number, used = 42): PassiveUsageRecord => ({
  version: 1,
  source: 'claude-statusline',
  at,
  fiveHour: { usedPercent: used, resetAt: NOW + 60 * MINUTE },
  weekly: { usedPercent: 10 },
});

describe('the four words', () => {
  it('should name exactly the product words and shapes', () => {
    should(CREDENTIAL_STATUS_LABELS).deepEqual({
      ready: 'Ready',
      refresh_due: 'Refresh due',
      needs_sign_in: 'Needs sign-in',
      checking: 'Checking',
    });
    should(Object.keys(CREDENTIAL_STATUS_SHAPES)).deepEqual(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
  });
});

describe('readCodexAuthFacts', () => {
  it('should reduce a ChatGPT login to facts with no token in them', () => {
    // Act
    const facts = readCodexAuthFacts(found(codexBlob()));

    // Assert
    should(facts).deepEqual({
      state: 'tokens',
      hasAccess: true,
      hasRefresh: true,
      accessExpiresAt: NOW + 60 * MINUTE,
      lastRefreshAt: NOW - MINUTE,
      planType: 'pro',
    });
    should(JSON.stringify(facts)).not.match(/fake-refresh/);
  });

  it('should tell absent, unreadable, non-object, api-key and token-less files apart', () => {
    should(readCodexAuthFacts({ outcome: 'absent' })).deepEqual({ state: 'missing' });
    should(readCodexAuthFacts({ outcome: 'unreadable', reason: 'locked' })).deepEqual({ state: 'unreadable' });
    should(readCodexAuthFacts(found('not json'))).deepEqual({ state: 'unreadable' });
    should(readCodexAuthFacts(found('[1]'))).deepEqual({ state: 'unreadable' });
    should(readCodexAuthFacts(found(JSON.stringify({ OPENAI_API_KEY: 'sk-fake', tokens: null })))).deepEqual({
      state: 'api_key',
    });
    should(readCodexAuthFacts(found(JSON.stringify({ tokens: null })))).deepEqual({ state: 'missing' });
  });

  it('should leave out an expiry, a refresh instant and a plan it cannot read', () => {
    // Act
    const facts = readCodexAuthFacts(
      found(codexBlob({ last_refresh: 'yesterday' }, { access_token: 'opaque', refresh_token: '', id_token: 7 })),
    );

    // Assert
    should(facts).deepEqual({ state: 'tokens', hasAccess: true, hasRefresh: false });
  });
});

describe('codexPlanType', () => {
  it('should read the nested claim, the flat claim, and nothing from a broken token', () => {
    should(codexPlanType(fakeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }))).equal('plus');
    should(codexPlanType(fakeJwt({ 'https://api.openai.com/auth.chatgpt_plan_type': 'team' }))).equal('team');
    should(codexPlanType(fakeJwt({}))).be.undefined();
    should(codexPlanType('a.!!!.c')).be.undefined();
    should(codexPlanType('only-one-segment')).be.undefined();
    should(codexPlanType(undefined)).be.undefined();
  });
});

describe('decideClaudeStatus', () => {
  const valid: LocalCredentialReading = { state: 'valid', expiresAt: NOW + 60 * MINUTE, fingerprint: 'f1' };
  const decide = (
    local: LocalCredentialReading,
    head: CredentialStatusHead = {},
    extra: { passive?: PassiveUsageRecord; checking?: boolean; now?: number } = {},
  ) =>
    decideClaudeStatus({
      local,
      head,
      checking: extra.checking ?? false,
      now: extra.now ?? NOW,
      ...(extra.passive === undefined ? {} : { passive: extra.passive }),
    });

  it('should say Checking only while a check is in flight', () => {
    should(decide(valid, {}, { checking: true })).deepEqual({
      word: 'checking',
      reason: 'check_in_flight',
      lastCheckInconclusive: false,
    });
  });

  it('should show a valid login nobody has read as Ready, not checked yet', () => {
    should(decide(valid)).deepEqual({ word: 'ready', reason: 'not_checked_yet', lastCheckInconclusive: false });
  });

  it('should need sign-in for an empty slot and for an expired token with nothing to renew it', () => {
    should(decide({ state: 'missing' }).reason).equal('not_signed_in');
    should(decide({ state: 'missing', expiresAt: NOW - MINUTE })).deepEqual({
      word: 'needs_sign_in',
      reason: 'access_expired_no_refresh',
      since: NOW - MINUTE,
      lastCheckInconclusive: false,
    });
  });

  it('should leave an expired token with a refresh token to Claude: Refresh due', () => {
    should(decide({ state: 'refreshable', expiresAt: NOW - MINUTE }).word).equal('refresh_due');
  });

  it('should condemn only the credential a fresh rejection was measured against', () => {
    // Arrange
    const head: CredentialStatusHead = {
      conclusion: { word: 'needs_sign_in', reason: 'provider_rejected', at: NOW - MINUTE, fingerprint: 'f1' },
      lastCheck: { at: NOW - MINUTE, conclusive: true },
    };

    // Act / Assert
    should(decide(valid, head)).deepEqual({
      word: 'needs_sign_in',
      reason: 'provider_rejected',
      since: NOW - MINUTE,
      lastCheckedAt: NOW - MINUTE,
      lastCheckInconclusive: false,
    });
    should(decide({ ...valid, fingerprint: 'f2' }, head).word).equal('ready');
    should(decide(valid, head, { now: NOW + CREDENTIAL_NEGATIVE_FRESH_MS }).word).equal('ready');
    const { fingerprint: _none, ...unpinned } = head.conclusion as NonNullable<CredentialStatusHead['conclusion']>;
    should(decide(valid, { conclusion: unpinned }).word).equal('ready');
  });

  it('should show the last known word, with its age, when the login cannot be read', () => {
    // Arrange
    const head: CredentialStatusHead = {
      conclusion: { word: 'ready', reason: 'provider_accepted', at: NOW - 30 * MINUTE },
      lastCheck: { at: NOW - MINUTE, conclusive: false },
    };

    // Act / Assert
    should(decide({ state: 'unreadable' }, head)).deepEqual({
      word: 'ready',
      reason: 'provider_accepted',
      since: NOW - 30 * MINUTE,
      lastCheckedAt: NOW - MINUTE,
      lastCheckInconclusive: true,
    });
    should(decide({ state: 'unreadable' }).reason).equal('credential_unreadable');
  });

  it('should take the newer of an accepted read and a statusLine reading', () => {
    // Arrange
    const head: CredentialStatusHead = {
      conclusion: { word: 'ready', reason: 'usage_scope_unavailable', at: NOW - 10 * MINUTE },
    };

    // Act / Assert
    should(decide(valid, head, { passive: passive(NOW - MINUTE) })).match({ reason: 'passive_usage_seen' });
    should(decide(valid, head, { passive: passive(NOW - 20 * MINUTE) })).match({
      reason: 'usage_scope_unavailable',
      since: NOW - 10 * MINUTE,
    });
    should(decide(valid, {}, { passive: passive(NOW - 20 * MINUTE) }).reason).equal('passive_usage_seen');
  });
});

describe('decideCodexStatus', () => {
  const decide = (facts: CodexAuthFacts, head: CredentialStatusHead = {}, fingerprint?: string, checking = false) =>
    decideCodexStatus({ facts, head, checking, now: NOW, ...(fingerprint === undefined ? {} : { fingerprint }) });

  it('should be Ready with a current token, saying when it was last refreshed and on which plan', () => {
    should(decide(tokens({ planType: 'pro' }))).deepEqual({
      word: 'ready',
      reason: 'access_current',
      since: NOW - MINUTE,
      lastCheckInconclusive: false,
      planType: 'pro',
    });
  });

  it('should say Checking only while in flight', () => {
    should(decide(tokens(), {}, undefined, true).word).equal('checking');
  });

  it('should cover the storeless and unreadable shapes', () => {
    should(decide({ state: 'missing' }).reason).equal('not_signed_in');
    should(decide({ state: 'unreadable' }).reason).equal('credential_unreadable');
    should(decide({ state: 'api_key' }).reason).equal('api_key');
  });

  it('should be Refresh due within five minutes of exp, and when there is no exp and last_refresh is old', () => {
    should(decide(tokens({ accessExpiresAt: NOW + 4 * MINUTE })).reason).equal('access_expiring');
    should(
      decide(tokens({ accessExpiresAt: undefined, lastRefreshAt: NOW - CODEX_LAST_REFRESH_MAX_AGE_MS - 1 })).reason,
    ).equal('last_refresh_old');
    should(decide(tokens({ accessExpiresAt: undefined, lastRefreshAt: undefined })).reason).equal('last_refresh_old');
    should(decide(tokens({ accessExpiresAt: undefined, lastRefreshAt: NOW - MINUTE })).word).equal('ready');
    // An old last_refresh does not matter while exp says the token is current: Codex itself would not refresh.
    should(decide(tokens({ lastRefreshAt: NOW - CODEX_LAST_REFRESH_MAX_AGE_MS - 1 })).word).equal('ready');
  });

  it('should tell a token with no way back from one that can still renew', () => {
    should(decide(tokens({ hasRefresh: false, accessExpiresAt: NOW - MINUTE })).reason).equal(
      'access_expired_no_refresh',
    );
    should(decide(tokens({ hasRefresh: false, hasAccess: false })).reason).equal('not_signed_in');
    should(decide(tokens({ hasAccess: false })).reason).equal('access_expired_refreshable');
    should(decide(tokens({ hasRefresh: false })).word).equal('ready');
  });

  it('should hold a recorded failure until the file advances or is replaced', () => {
    // Arrange
    const head: CredentialStatusHead = {
      codexFailure: { failure: 'revoked', at: NOW - MINUTE, lastRefreshAt: NOW - MINUTE, fingerprint: 'f1' },
    };

    // Act / Assert
    should(decide(tokens(), head, 'f1')).match({
      word: 'needs_sign_in',
      reason: 'refresh_revoked',
      since: NOW - MINUTE,
    });
    should(decide(tokens({ lastRefreshAt: NOW }), head, 'f1').word).equal('ready');
    should(decide(tokens(), head, 'f2').word).equal('ready');
    should(decide(tokens({ lastRefreshAt: undefined }), head).reason).equal('refresh_revoked');
    should(decide(tokens(), { codexFailure: { failure: 'expired', at: NOW } }).word).equal('ready');
    should(decide({ state: 'api_key' }, head).word).equal('ready');
  });

  it('should show a refresh it saw succeed', () => {
    should(decide(tokens(), { conclusion: { word: 'ready', reason: 'refresh_accepted', at: NOW - 2 * MINUTE } })).match(
      { reason: 'refresh_accepted', since: NOW - 2 * MINUTE },
    );
  });
});

describe('decideStorelessStatus', () => {
  it('should treat the environment as Ready and an unreachable store as Needs sign-in', () => {
    should(decideStorelessStatus({ harness: 'claude', store: 'environment', env: {} }).reason).equal(
      'from_environment',
    );
    should(decideStorelessStatus({ harness: 'codex', store: 'host', unavailable: 'relative CODEX_HOME' }).reason).equal(
      'store_unreachable',
    );
  });
});

describe('folding', () => {
  it('should conclude only from accepted, scope-unavailable and rejected Claude reads', () => {
    should(foldClaudeSignal({}, 'accepted', NOW, 'f1')).deepEqual({
      conclusion: { word: 'ready', reason: 'provider_accepted', at: NOW, fingerprint: 'f1' },
      lastCheck: { at: NOW, conclusive: true },
    });
    should(foldClaudeSignal({}, 'scope_unavailable', NOW, undefined).conclusion).deepEqual({
      word: 'ready',
      reason: 'usage_scope_unavailable',
      at: NOW,
    });
    should(foldClaudeSignal({}, 'rejected', NOW, 'f1').conclusion?.word).equal('needs_sign_in');
    const kept = { conclusion: { word: 'ready' as const, reason: 'provider_accepted' as const, at: 1 } };
    for (const signal of ['rejection_unconfirmed', 'timeout', 'inconclusive', 'absent', undefined] as const) {
      should(foldClaudeSignal(kept, signal, NOW, 'f1')).deepEqual({
        ...kept,
        lastCheck: { at: NOW, conclusive: false },
      });
    }
  });

  it('should clear a failure on success, record a permanent one and judge nothing from a transient one', () => {
    // Arrange
    const failed: CredentialStatusHead = { codexFailure: { failure: 'expired', at: 1 } };

    // Act / Assert
    should(foldCodexRefresh(failed, { kind: 'advanced' }, NOW, { facts: tokens() })).deepEqual({
      conclusion: { word: 'ready', reason: 'refresh_accepted', at: NOW },
      lastCheck: { at: NOW, conclusive: true },
    });
    should(
      foldCodexRefresh({}, { kind: 'failed', failure: 'revoked' }, NOW, { facts: tokens(), fingerprint: 'f1' })
        .codexFailure,
    ).deepEqual({ failure: 'revoked', at: NOW, lastRefreshAt: NOW - MINUTE, fingerprint: 'f1' });
    should(
      foldCodexRefresh({}, { kind: 'failed', failure: 'rejected' }, NOW, { facts: { state: 'missing' } }).codexFailure,
    ).deepEqual({ failure: 'rejected', at: NOW });
    should(foldCodexRefresh(failed, { kind: 'failed', failure: 'transient' }, NOW, { facts: tokens() })).deepEqual({
      ...failed,
      lastCheck: { at: NOW, conclusive: false },
    });
    should(foldCodexRefresh({}, { kind: 'not_run' }, NOW, { facts: tokens() }).lastCheck?.conclusive).be.false();
  });

  it('should see a file advance by digest or by last_refresh, never into a signed-out file', () => {
    const before = { facts: tokens(), fingerprint: 'f1' };
    should(codexFileAdvanced(before, { facts: tokens(), fingerprint: 'f2' })).be.true();
    should(codexFileAdvanced(before, { facts: { state: 'missing' }, fingerprint: 'f2' })).be.false();
    should(codexFileAdvanced(before, { facts: tokens({ lastRefreshAt: NOW }), fingerprint: 'f1' })).be.true();
    should(codexFileAdvanced(before, { facts: tokens(), fingerprint: 'f1' })).be.false();
    should(codexFileAdvanced({ facts: { state: 'missing' } }, { facts: tokens() })).be.true();
    should(codexFileAdvanced({ facts: tokens() }, { facts: tokens({ lastRefreshAt: undefined }) })).be.false();
    should(codexFileAdvanced({ facts: tokens() }, { facts: { state: 'unreadable' } })).be.false();
  });
});

describe('usage', () => {
  it('should never show 0% for a window nobody measured', () => {
    should(usagePercentLabel({})).equal('unknown');
    should(usagePercentLabel({ usedPercent: 0 })).equal('0%');
    should(usagePercentLabel({ usedPercent: 41.6 })).equal('42%');
  });

  it('should choose the newest reading that measured something, else two unknown windows', () => {
    // Arrange
    const older = passiveUsageReading(passive(NOW - 10 * MINUTE, 10));
    const newer = passiveUsageReading({ version: 1, source: 'codex-rollout', at: NOW, weekly: { usedPercent: 5 } });
    const empty = { source: 'codex-usage' as const, at: NOW + 1 };

    // Act / Assert
    should(chooseCredentialUsage([older, undefined, newer, empty])).deepEqual({
      fiveHour: {},
      weekly: { usedPercent: 5 },
      source: 'codex-rollout',
      at: NOW,
    });
    should(
      chooseCredentialUsage([
        passiveUsageReading({ version: 1, source: 'claude-statusline', at: 1, fiveHour: { usedPercent: 3 } }),
      ]),
    ).match({ weekly: {} });
    should(chooseCredentialUsage([])).deepEqual({ fiveHour: {}, weekly: {} });
  });

  it('should make the active read only when no passive reading is inside the interval', () => {
    should(needsActiveUsageRead(undefined, NOW, MINUTE)).be.true();
    should(needsActiveUsageRead(passive(NOW - 1000), NOW, MINUTE)).be.false();
    should(needsActiveUsageRead(passive(NOW - MINUTE), NOW, MINUTE)).be.true();
    should(needsActiveUsageRead({ version: 1, source: 'claude-statusline', at: NOW }, NOW, MINUTE)).be.true();
  });

  it('should turn a free read into a reading only when it measured something', () => {
    should(
      activeUsageReading(
        'anthropic-usage',
        { usageBased: true, ok: true, shortWindow: { usedPercent: 1 }, longWindow: { usedPercent: 2 } },
        NOW,
      ),
    ).deepEqual({ source: 'anthropic-usage', at: NOW, fiveHour: { usedPercent: 1 }, weekly: { usedPercent: 2 } });
    should(activeUsageReading('codex-usage', { usageBased: true, ok: false }, NOW)).be.undefined();
  });
});

describe('InMemoryCredentialStatusStore', () => {
  it('should keep what it is given and refuse a malformed head', async () => {
    // Arrange
    const store = new InMemoryCredentialStatusStore();

    // Act
    await store.write('work', { lastCheck: { at: NOW, conclusive: true } });

    // Assert
    should(await store.read('work')).deepEqual({ lastCheck: { at: NOW, conclusive: true } });
    should(await store.read('other')).be.undefined();
    await should(store.write('work', { lastCheck: { at: -1, conclusive: true } })).be.rejected();
  });
});

// ── The service ──────────────────────────────────────────────────────────────────────────────────

interface Harness {
  readonly ports: CredentialStatusPorts;
  readonly heads: InMemoryCredentialStatusStore;
  readonly calls: { active: number; refresh: number };
  set(state: Partial<State>): void;
}

interface State {
  local: LocalCredentialReading | 'throw';
  material: CredentialMaterial | 'throw';
  passive: PassiveUsageRecord | undefined | 'throw';
  active: FleetUsageProbeResult | 'throw' | (() => Promise<FleetUsageProbeResult>);
  refresh: (settled: () => Promise<boolean>) => Promise<FleetTokenRefreshAttempt>;
}

function harness(initial: Partial<State> = {}): Harness {
  const state: State = {
    local: { state: 'valid', expiresAt: NOW + 60 * MINUTE, fingerprint: 'f1' },
    material: found(codexBlob()),
    passive: undefined,
    active: { usageBased: true, ok: true, credentialSignal: 'accepted', shortWindow: { usedPercent: 7 } },
    refresh: async () => ({ outcome: 'ran' }),
    ...initial,
  };
  const calls = { active: 0, refresh: 0 };
  const heads = new InMemoryCredentialStatusStore();
  const refresh: FleetTokenRefreshPort = {
    refresh: async (target, settled) => {
      calls.refresh += 1;
      should(target).deepEqual({ accountId: 'cx', kind: 'codex', home: '/fy/fleet/credentials/cx' });
      return await state.refresh(settled);
    },
  };
  const ports: CredentialStatusPorts = {
    classify: async () => {
      if (state.local === 'throw') throw new Error('keychain locked');
      return state.local;
    },
    material: async () => {
      if (state.material === 'throw') throw new Error('io');
      return state.material;
    },
    passiveUsage: async () => {
      if (state.passive === 'throw') throw new Error('io');
      return state.passive;
    },
    activeUsage: async () => {
      calls.active += 1;
      if (state.active === 'throw') throw new Error('offline');
      return typeof state.active === 'function' ? await state.active() : state.active;
    },
    refresh,
    heads,
    now: () => NOW,
    usageIntervalMs: MINUTE,
  };
  return { ports, heads, calls, set: patch => Object.assign(state, patch) };
}

const subject = (resolution: CredentialStoreResolution, id = resolution.harness === 'codex' ? 'cx' : 'work') => ({
  id,
  resolution,
});

describe('CredentialStatusService', () => {
  it('should view a Claude login with no network, and publish Ready, not checked yet', async () => {
    // Arrange
    const world = harness();

    // Act
    const view = await new CredentialStatusService(world.ports).view(subject(CLAUDE));

    // Assert
    should(view).deepEqual({
      id: 'work',
      harness: 'claude',
      status: { word: 'ready', reason: 'not_checked_yet', lastCheckInconclusive: false },
      usage: { fiveHour: {}, weekly: {} },
    });
    should(world.calls.active).equal(0);
  });

  it('should show Checking while an observe is in flight, and the conclusion after', async () => {
    // Arrange
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = harness({
      active: async () => {
        await gate;
        return { usageBased: true, ok: true, credentialSignal: 'accepted', shortWindow: { usedPercent: 7 } };
      },
    });
    const service = new CredentialStatusService(world.ports);

    // Act
    const running = service.observe(subject(CLAUDE));
    const during = await service.view(subject(CLAUDE));
    should(service.busy('work')).be.true();
    release();
    const after = await running;

    // Assert
    should(during.status.word).equal('checking');
    should(service.busy('work')).be.false();
    should(after.status).match({ word: 'ready', reason: 'provider_accepted', since: NOW });
    should(after.usage).match({ fiveHour: { usedPercent: 7 }, source: 'anthropic-usage' });
    should((await world.heads.read('work'))?.conclusion?.fingerprint).equal('f1');
  });

  it('should answer the last known word to a settled view while an observe is in flight', async () => {
    // Arrange — one conclusion is already known, and a second read is out.
    let gate: Promise<void> = Promise.resolve();
    const world = harness({
      active: async () => {
        await gate;
        return { usageBased: true, ok: true, credentialSignal: 'accepted' };
      },
    });
    const service = new CredentialStatusService(world.ports);
    await service.observe(subject(CLAUDE));
    const release = Promise.withResolvers<void>();
    gate = release.promise;
    const running = service.observe(subject(CLAUDE));

    // Act
    const settled = await service.view(subject(CLAUDE), { settled: true });
    const live = await service.view(subject(CLAUDE));
    release.resolve();
    await running;

    // Assert — a cache gets the conclusion; a person looking now still sees Checking.
    should(settled.status).match({ word: 'ready', reason: 'provider_accepted', since: NOW });
    should(live.status.word).equal('checking');
  });

  it('should skip the active read when a passive reading is fresh', async () => {
    // Arrange
    const world = harness({ passive: passive(NOW - 1000) });

    // Act
    const view = await new CredentialStatusService(world.ports).observe(subject(CLAUDE));

    // Assert
    should(world.calls.active).equal(0);
    should(view.status.reason).equal('passive_usage_seen');
    should(view.usage.source).equal('claude-statusline');
  });

  it('should treat a throwing probe, classifier or passive reader as an inconclusive check', async () => {
    // Arrange
    const world = harness({ active: 'throw', local: 'throw', passive: 'throw' });

    // Act
    const view = await new CredentialStatusService(world.ports).checkNow(subject(CLAUDE));

    // Assert
    should(view.status).deepEqual({
      word: 'ready',
      reason: 'credential_unreadable',
      lastCheckedAt: NOW,
      lastCheckInconclusive: true,
    });
  });

  it('should never let the Codex usage read touch the conclusion', async () => {
    // Arrange
    const world = harness({ active: { usageBased: true, ok: true, shortWindow: { usedPercent: 3 } } });

    // Act
    const view = await new CredentialStatusService(world.ports).observe(subject(CODEX));

    // Assert
    should(await world.heads.read('cx')).deepEqual({
      activeUsage: { source: 'codex-usage', at: NOW, fiveHour: { usedPercent: 3 } },
    });
    should(view.status).match({ word: 'ready', reason: 'access_current' });
    should(world.calls.refresh).equal(0);
  });

  it('should record nothing new from a free read that measured nothing', async () => {
    // Arrange
    const world = harness({ active: { usageBased: true, ok: false } });

    // Act
    await new CredentialStatusService(world.ports).observe(subject(CODEX));

    // Assert
    should(await world.heads.read('cx')).deepEqual({});
  });

  it('should answer storeless credentials without touching any port', async () => {
    // Arrange
    const world = harness();
    const service = new CredentialStatusService(world.ports);

    // Act
    const env = await service.observe({ id: 'env', resolution: { harness: 'claude', store: 'environment', env: {} } });
    const lost = await service.checkNow({
      id: 'lost',
      resolution: { harness: 'codex', store: 'host', unavailable: 'relative CODEX_HOME' },
    });

    // Assert
    should(env.status.reason).equal('from_environment');
    should(lost.status.reason).equal('store_unreachable');
    should(world.calls).deepEqual({ active: 0, refresh: 0 });
  });

  it('should record a Codex Check now that advanced the file as accepted', async () => {
    // Arrange
    const world = harness();
    world.set({
      refresh: async settled => {
        should(await settled()).be.false();
        world.set({ material: found(codexBlob({ last_refresh: new Date(NOW).toISOString() })) });
        should(await settled()).be.true();
        return { outcome: 'ran' };
      },
    });

    // Act
    const view = await new CredentialStatusService(world.ports).checkNow(subject(CODEX));

    // Assert
    should(view.status).match({ word: 'ready', reason: 'refresh_accepted', since: NOW });
    should(world.calls).deepEqual({ active: 1, refresh: 1 });
  });

  it('should record an expired refresh token as Needs sign-in', async () => {
    // Arrange
    const world = harness({
      refresh: async () => ({ outcome: 'ran', evidence: { codes: ['refresh_token_expired'], unauthorized: false } }),
    });

    // Act
    const view = await new CredentialStatusService(world.ports).checkNow(subject(CODEX));

    // Assert
    should(view.status).match({ word: 'needs_sign_in', reason: 'refresh_expired', lastCheckInconclusive: false });
  });

  it('should judge nothing from a transient, unavailable or throwing refresh', async () => {
    for (const refresh of [
      async (): Promise<FleetTokenRefreshAttempt> => ({ outcome: 'ran' }),
      async (): Promise<FleetTokenRefreshAttempt> => ({ outcome: 'unavailable', reason: 'no codex' }),
      async (): Promise<FleetTokenRefreshAttempt> => {
        throw new Error('spawn failed');
      },
    ]) {
      // Arrange
      const world = harness({ refresh });

      // Act
      const view = await new CredentialStatusService(world.ports).checkNow(subject(CODEX));

      // Assert
      should(view.status).match({ word: 'ready', reason: 'access_current', lastCheckInconclusive: true });
    }
  });

  it('should join a second Check now instead of spending a second refresh token', async () => {
    // Arrange
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const world = harness({
      refresh: async () => {
        await gate;
        return { outcome: 'ran' };
      },
    });
    const service = new CredentialStatusService(world.ports);

    // Act
    const first = service.checkNow(subject(CODEX));
    const second = service.checkNow(subject(CODEX));
    release();
    const [one, two] = await Promise.all([first, second]);

    // Assert
    should(world.calls.refresh).equal(1);
    should(one).equal(two);
  });

  it('should read an unreadable Codex file as unreadable, never as signed out', async () => {
    // Arrange
    const world = harness({ material: 'throw', local: { state: 'unreadable' } });

    // Act
    const view = await new CredentialStatusService(world.ports).view(subject(CODEX));

    // Assert
    should(view.status.reason).equal('credential_unreadable');
  });
});

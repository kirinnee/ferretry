import { describe, it } from 'bun:test';
import type { FleetHealth, FleetIdentity, FleetIdentityMember, FleetIdentityStatus } from '@ferretry/fleet';
import should from 'should';
import {
  renderAccount,
  renderApplyPlan,
  renderApplyResult,
  renderIdentityStatus,
  renderLoginResults,
  renderLoginRow,
  renderManifest,
  renderRecommendation,
  renderScaffoldResult,
  renderUsage,
  renderUsageRow,
  renderHealth,
} from '../../../src/lib/fleet/render';
import {
  ACCOUNT_ID,
  account,
  applyResult,
  manifest,
  plan,
  recommendation,
  scaffoldResult,
  usageRow,
  usageSnapshot,
} from './fixtures';

const KEY = 'claude:kirin';

const identityMember = (accountId: string): FleetIdentityMember => ({
  accountId,
  wrapper: `bin-${accountId}`,
  home: `/homes/${accountId}`,
  displayName: `Account ${accountId}`,
  mode: 'interactive',
  available: true,
  unavailableReason: null,
});

const identity = (overrides: Partial<FleetIdentity> = {}): FleetIdentity => ({
  key: KEY,
  kind: 'claude',
  identity: 'kirin',
  auth: 'oauth',
  declared: true,
  members: [identityMember('a')],
  ...overrides,
});

const identityStatus = (overrides: Partial<FleetIdentityStatus> = {}): FleetIdentityStatus => {
  const target = overrides.identity ?? identity();
  return {
    identity: target,
    members: target.members.map(member => ({ member, reading: { state: 'valid' as const } })),
    unavailable: [],
    verdict: { kind: 'complete' as const },
    targets: [],
    refused: [],
    ...overrides,
  };
};

describe('apply plan rendering', () => {
  it('should say plainly that nothing has been written', () => {
    // Act
    const rendered = renderApplyPlan(plan());

    // Assert
    should(rendered.split('\n')[0]).equal('1 account, 2 operations, 0 history changes — nothing has been written');
    should(rendered).containEql('directory /state/fleet/bin');
    should(rendered).containEql('manifest   /state/fleet/manifest.json');
  });

  it('should name the source of a copy and a symlink, not just the destination', () => {
    // Arrange
    const withLinks = plan({
      operations: [
        { kind: 'copy', path: '/state/fleet/homes/a/CLAUDE.md', source: '/assets/CLAUDE.md' },
        { kind: 'symlink', path: '/state/fleet/homes/a/skills', source: '/assets/skills' },
      ],
    });

    // Act
    const rendered = renderApplyPlan(withLinks);

    // Assert
    should(rendered).containEql('/state/fleet/homes/a/CLAUDE.md ← /assets/CLAUDE.md');
    should(rendered).containEql('/state/fleet/homes/a/skills ← /assets/skills');
  });

  it('should say how much a prune would keep, because prune is the destructive one', () => {
    // Arrange
    const sweeping = plan({
      operations: [{ kind: 'prune', path: '/state/fleet/bin', marker: 'managed', keep: ['a', 'b'] }],
    });

    // Act + Assert
    should(renderApplyPlan(sweeping)).containEql('/state/fleet/bin (keeping 2)');
  });

  it('should name the exact winner and preserved loser for every history collision', () => {
    // Arrange
    const incoming = '/state/fleet/homes/b/projects/thread.jsonl';
    const pooled = '/state/fleet/shared/claude/projects/thread.jsonl';
    const preservedAt = '/state/fleet/shared/claude/.migration-conflicts/b/projects/thread.jsonl';
    const collision = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 1,
          conflicts: 1,
          links: 2,
          changes: [
            {
              kind: 'collision',
              incoming,
              pooled,
              winner: incoming,
              loser: pooled,
              preservedAt,
            },
          ],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(collision);

    // Assert
    should(rendered).containEql(
      `collision ${incoming} ↔ ${pooled}; winner ${incoming}; preserve loser ${pooled} at ${preservedAt}`,
    );
  });

  it('should report what an apply actually did', () => {
    // Act
    const rendered = renderApplyResult(applyResult());

    // Assert
    should(rendered).containEql('applied 1 account in 2 operations');
    should(rendered).not.containEql('pruned');
  });

  it('should name every wrapper that was swept away', () => {
    // Act
    const rendered = renderApplyResult(applyResult({ prunedWrappers: ['fy-old-a', 'fy-old-b'] }));

    // Assert
    should(rendered).containEql('pruned 2 wrappers: fy-old-a, fy-old-b');
  });
});

describe('manifest rendering', () => {
  it('should show what an account is and that it can be used', () => {
    // Act
    const rendered = renderAccount(account());

    // Assert
    should(rendered).containEql(`${ACCOUNT_ID}  [claude/auto]  Claude (work)`);
    should(rendered).containEql('wrapper fy-claude-work · home /state/fleet/homes/work');
    should(rendered).containEql('default opus · models opus');
    should(rendered).containEql('available');
  });

  it('should state why an unavailable account cannot be used', () => {
    // Act
    const rendered = renderAccount(
      account({ available: false, unavailableReason: 'not logged in', defaultModel: null, models: [] }),
    );

    // Assert
    should(rendered).containEql('unavailable — not logged in');
    should(rendered).containEql('default none · models none available');
  });

  it('should not count a model the account cannot actually serve', () => {
    // Act
    const rendered = renderAccount(
      account({
        models: [
          { id: 'opus', available: true },
          { id: 'haiku', available: false, unavailableReason: 'retired' },
        ],
      }),
    );

    // Assert
    should(rendered).containEql('models opus');
    should(rendered).not.containEql('haiku');
  });

  it('should say plainly when the manifest declares nothing', () => {
    // Act + Assert
    should(renderManifest(manifest([]))).equal('The fleet manifest declares no accounts.');
  });

  it('should head the listing with when provisioning ran', () => {
    // Act + Assert
    should(renderManifest(manifest()).split('\n')[0]).equal('1 account provisioned 2026-07-31T09:00:00.000Z');
  });
});

describe('usage rendering', () => {
  it('should show both quota windows', () => {
    // Act + Assert
    should(renderUsageRow(usageRow())).equal(`  ${ACCOUNT_ID}  short 42% · long 11%`);
  });

  it('should call out an account at its limit', () => {
    // Act + Assert
    should(renderUsageRow(usageRow({ atLimit: true }))).containEql('AT LIMIT');
  });

  it('should print a dash rather than a fabricated zero for a window the provider did not report', () => {
    // Act + Assert
    should(renderUsageRow(usageRow({ shortWindow: undefined, longWindow: undefined }))).containEql('short — · long —');
  });

  it('should distinguish an unavailable account from a failed probe', () => {
    // Act + Assert
    should(renderUsageRow(usageRow({ unavailable: true, ok: false, unavailableReason: 'no probe' }))).containEql(
      'unavailable — no probe',
    );
    should(renderUsageRow(usageRow({ ok: false, error: 'timeout' }))).containEql('probe failed — timeout');
  });

  it('should say when there is simply no quota to report', () => {
    // Act + Assert
    should(renderUsageRow(usageRow({ usageBased: false }))).containEql('pay-as-you-go — no quota to report');
  });

  it('should fall back to a stated absence rather than printing undefined', () => {
    // Act + Assert
    should(renderUsageRow(usageRow({ unavailable: true, ok: false, unavailableReason: undefined }))).containEql(
      'no reason given',
    );
    should(renderUsageRow(usageRow({ ok: false, error: undefined }))).containEql('no reason given');
  });

  it('should head the report with how many accounts are exhausted', () => {
    // Act + Assert
    should(renderUsage(usageSnapshot()).split('\n')[0]).equal('1 account');
    should(renderUsage(usageSnapshot([usageRow({ atLimit: true })])).split('\n')[0]).equal('1 account, 1 at limit');
    should(renderUsage(usageSnapshot([]))).equal('No accounts to report usage for.');
  });
});

describe('health rendering', () => {
  it('should distinguish down and unknown accounts while preserving cached evidence', () => {
    // Arrange
    const rows: FleetHealth[] = [
      { accountId: 'a', kind: 'claude', state: 'down', cached: false, checkedAt: 1, ms: 2, error: 'no sentinel' },
      { accountId: 'b', kind: 'codex', state: 'unknown', cached: true, checkedAt: 1, ms: 0 },
    ];

    // Act
    const rendered = renderHealth({ at: 1, accounts: rows });

    // Assert
    should(rendered).equal('2 accounts, 1 down, 1 unknown\n  a  DOWN — no sentinel\n  b  UNKNOWN (cached)');
  });

  it('should explain an empty health snapshot without pretending a probe ran', () => {
    should(renderHealth({ at: 1, accounts: [] })).equal('No accounts to probe for health.');
  });
});

describe('recommendation rendering', () => {
  it('should present the pick alongside its alternatives, not as an order', () => {
    // Act
    const rendered = renderRecommendation(recommendation());

    // Assert
    should(rendered).containEql('implementation — a long, many-checkpoint port');
    should(rendered).containEql('implementer: the work is mostly writing modules');
    should(rendered).containEql('pick  sol (gpt-5.6');
    should(rendered).containEql('or    terra (gpt-5.6');
  });

  it('should show a fan-out count when the role has one', () => {
    // Arrange
    const fanned = recommendation({
      roles: [{ ...recommendation().roles[0]!, count: 4 }],
    });

    // Act + Assert
    should(renderRecommendation(fanned)).containEql('implementer ×4:');
  });

  it('should carry an option caveat rather than dropping it', () => {
    // Arrange
    const caveated = recommendation({
      roles: [
        { ...recommendation().roles[0]!, primary: { ...recommendation().roles[0]!.primary, caveat: 'near quota' } },
      ],
    });

    // Act + Assert
    should(renderRecommendation(caveated)).containEql('near quota');
  });

  it('should say which accounts were skipped and why', () => {
    // Act
    const rendered = renderRecommendation(
      recommendation({ exclusions: [{ accountId: ACCOUNT_ID, agent: 'mm3', reason: 'at its quota limit' }] }),
    );

    // Assert
    should(rendered).containEql('not considered:');
    should(rendered).containEql('mm3 (' + ACCOUNT_ID + '): at its quota limit');
  });

  it('should surface every warning the recommender raised', () => {
    // Act + Assert
    should(renderRecommendation(recommendation({ warnings: ['quota was not probed'] }))).containEql(
      '! quota was not probed',
    );
  });
});

describe('renderLoginResults', () => {
  it('should say so plainly when there is nothing to log in', () => {
    // Act
    const actual = renderLoginResults([]);

    // Assert
    should(actual).equal('No accounts to log in.');
  });

  it('should name every outcome, so a skip never reads as a success', () => {
    // Act
    const actual = renderLoginResults([
      { accountId: 'a', identity: KEY, status: 'logged-in' },
      { accountId: 'b', identity: KEY, status: 'not-required' },
      { accountId: 'c', identity: KEY, status: 'unavailable', message: 'pool down' },
      { accountId: 'd', identity: KEY, status: 'failed', message: 'login process exited with code 7' },
      { accountId: 'e', identity: KEY, status: 'synced' },
      { accountId: 'f', identity: KEY, status: 'usable' },
      { accountId: 'g', identity: KEY, status: 'login-needed', message: 'rerun without --sync-only' },
      { accountId: 'h', identity: KEY, status: 'indeterminate', message: 'the keychain is locked' },
    ]);

    // Assert — a failure and an unknown are counted apart, because they need different next steps.
    should(actual).containEql('8 accounts, 1 failed, 1 could not be read');
    should(actual).containEql('a  logged in');
    should(actual).containEql('b  no login needed');
    should(actual).containEql('c  skipped, the manifest declares it unavailable — pool down');
    should(actual).containEql('d  FAILED — login process exited with code 7');
    should(actual).containEql('e  credential copied from this identity');
    should(actual).containEql('f  already had a usable credential');
    should(actual).containEql('g  needs a login, not attempted — rerun without --sync-only');
    should(actual).containEql('h  UNKNOWN, left untouched — the keychain is locked');
  });

  it('should count no failures when every account succeeded', () => {
    // Act
    const actual = renderLoginResults([{ accountId: 'a', identity: KEY, status: 'logged-in' }]);

    // Assert
    should(actual).startWith('1 account\n');
  });

  it('should render an unavailable account with no stated reason', () => {
    // Act
    const actual = renderLoginRow({ accountId: 'a', identity: KEY, status: 'unavailable' });

    // Assert
    should(actual).equal('  a  skipped, the manifest declares it unavailable');
  });
});

describe('renderIdentityStatus', () => {
  it('should say so plainly when this host has no identities', () => {
    should(renderIdentityStatus([])).equal('No identities on this host.');
  });

  it('should group by identity and name what each home holds', () => {
    // Arrange
    const target = identity({ members: [identityMember('a'), identityMember('b')] });
    const status = identityStatus({
      identity: target,
      members: [
        { member: identityMember('a'), reading: { state: 'valid' } },
        { member: identityMember('b'), reading: { state: 'refreshable' } },
      ],
    });

    // Act
    const actual = renderIdentityStatus([status]);

    // Assert — one identity, two homes: the shape that makes the approval count obvious.
    should(actual).startWith('1 identity\n');
    should(actual).containEql(`${KEY}  every home has a usable credential`);
    should(actual).containEql('a  valid');
    should(actual).containEql('b  expired, renewable');
  });

  it('should pluralise more than one identity', () => {
    should(renderIdentityStatus([identityStatus(), identityStatus()])).startWith('2 identities\n');
  });

  it('should say how many homes a copy would touch, and where from', () => {
    // Arrange
    const status = identityStatus({
      verdict: { kind: 'sync', donor: identityMember('a') },
      targets: [identityMember('b')],
    });

    // Act / Assert
    should(renderIdentityStatus([status])).containEql('1 home would be copied from a');
  });

  it('should promise one approval covers the whole identity when nothing is usable', () => {
    // Arrange
    const status = identityStatus({
      verdict: { kind: 'login' },
      members: [{ member: identityMember('a'), reading: { state: 'missing' } }],
    });

    // Act
    const actual = renderIdentityStatus([status]);

    // Assert
    should(actual).containEql('needs one browser approval, which would then cover every home here');
    should(actual).containEql('a  none');
  });

  it('should mark an identity it could not read as unknown, not as signed out', () => {
    // Arrange — this is the distinction the report exists to keep.
    const status = identityStatus({
      verdict: { kind: 'indeterminate', reason: 'no usable credential was found, and 1 of 1 could not be read' },
      members: [{ member: identityMember('a'), reading: { state: 'unreadable', reason: 'the keychain is locked' } }],
    });

    // Act
    const actual = renderIdentityStatus([status]);

    // Assert
    should(actual).containEql('UNKNOWN — no usable credential was found');
    should(actual).containEql('a  UNREADABLE');
  });

  it('should say an api-key identity has no provider login at all', () => {
    // Arrange
    const status = identityStatus({
      identity: identity({ auth: 'api-key' }),
      verdict: { kind: 'no-login', reason: 'this account authenticates with a key' },
    });

    // Act / Assert
    should(renderIdentityStatus([status])).containEql('no provider login — this account authenticates with a key');
  });

  it('should say when the configuration no longer declares an account', () => {
    // Arrange — a manifest outlives its configuration, and the reader should know why it stands alone.
    const status = identityStatus({ identity: identity({ declared: false, key: 'account:a' }) });

    // Act / Assert
    should(renderIdentityStatus([status])).containEql('the configuration no longer declares this account');
  });

  it('should list an unavailable home as not read, rather than omitting it', () => {
    // Arrange
    const skipped = { ...identityMember('c'), available: false, unavailableReason: 'no harness' };
    const status = identityStatus({ unavailable: [skipped] });

    // Act / Assert
    should(renderIdentityStatus([status])).containEql('c  unavailable, not read');
  });
});

describe('renderScaffoldResult', () => {
  it('should list what it created and always say what must go on PATH', () => {
    // Act
    const actual = renderScaffoldResult(scaffoldResult());

    // Assert
    should(actual).containEql('prepared the fleet in /state/fleet');
    should(actual).containEql('created  /state/fleet/config.yaml');
    should(actual).containEql('export PATH="/state/fleet/bin:$PATH"');
  });

  it('should still print the PATH line on a re-run that changed nothing', () => {
    // Act — the line is the one step nothing else can do for the person.
    const actual = renderScaffoldResult(scaffoldResult({ created: [], kept: ['/state/fleet/config.yaml'] }));

    // Assert
    should(actual).containEql('already set up');
    should(actual).containEql('kept     /state/fleet/config.yaml');
    should(actual).containEql('export PATH=');
  });

  it('should not claim a directory it does not know', () => {
    // Act
    const actual = renderScaffoldResult(scaffoldResult({ directories: [] }));

    // Assert
    should(actual).containEql('prepared the fleet in its directory');
  });
});

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

  it('should describe every history action and both Codex ownership transitions', () => {
    // Arrange
    const detailed = plan({
      operations: [
        {
          kind: 'codex-sqlite-ownership',
          path: '/homes/codex/config.toml',
          markerPath: '/homes/codex/.ferretry-sqlite-home.json',
          sqliteHome: '/state/fleet/shared/codex/sqlite',
          enabled: true,
        },
        {
          kind: 'codex-sqlite-ownership',
          path: '/homes/old/config.toml',
          markerPath: '/homes/old/.ferretry-sqlite-home.json',
          sqliteHome: '/state/fleet/shared/codex/sqlite',
          enabled: false,
        },
      ],
      sharedHistory: [
        {
          kind: 'codex',
          pool: '/state/fleet/shared/codex',
          migrated: 2,
          conflicts: 0,
          links: 2,
          changes: [
            { kind: 'create-pooled-entry', path: '/pool/sessions', entryType: 'directory' },
            { kind: 'move', source: '/home/sessions/a', destination: '/pool/sessions/a' },
            {
              kind: 'merge-jsonl',
              source: '/home/history.jsonl',
              destination: '/pool/history.jsonl',
              sourcePreservedAt: '/pool/.migration-conflicts/a/history.jsonl',
            },
            { kind: 'link', path: '/home/sessions', target: '/pool/sessions' },
            { kind: 'already-shared', path: '/other/sessions', target: '/pool/sessions' },
          ],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(detailed);

    // Assert
    should(rendered).containEql('own sqlite_home=/state/fleet/shared/codex/sqlite');
    should(rendered).containEql("restore/remove only Ferretry's owned sqlite_home");
    should(rendered).containEql('create directory /pool/sessions');
    should(rendered).containEql('rename /home/sessions/a → /pool/sessions/a');
    should(rendered).containEql(
      'merge /home/history.jsonl → /pool/history.jsonl; preserve source at /pool/.migration-conflicts/a/history.jsonl',
    );
    should(rendered).containEql('link /home/sessions → /pool/sessions');
    should(rendered).containEql('keep shared link /other/sessions → /pool/sessions');
  });

  it('should report what an apply actually did', () => {
    // Act
    const rendered = renderApplyResult(applyResult());

    // Assert
    should(rendered).containEql('applied 1 account in 2 operations');
    should(rendered).not.containEql('pruned');
  });

  it('should report each harness pool an apply migrated', () => {
    // Act
    const rendered = renderApplyResult(
      applyResult({
        sharedHistory: [
          {
            kind: 'claude',
            pool: '/state/fleet/shared/claude',
            migrated: 3,
            conflicts: 1,
            links: 4,
            changes: [],
          },
        ],
      }),
    );

    // Assert
    should(rendered).containEql(
      'shared claude: 3 migrated entries, 1 collisions preserved, 4 links → /state/fleet/shared/claude',
    );
  });

  it('should warn that a pooled Codex rollout may not be listed for resume yet, in a dry run', () => {
    // Arrange
    const codex = plan({
      sharedHistory: [
        { kind: 'codex', pool: '/state/fleet/shared/codex', migrated: 2, conflicts: 0, links: 2, changes: [] },
      ],
    });

    // Act
    const rendered = renderApplyPlan(codex);

    // Assert
    should(rendered).containEql('Codex resume');
    should(rendered).containEql('does not re-index it');
    should(rendered).containEql('No history is deleted.');
  });

  it('should not warn about Codex resume when only Claude history is pooled', () => {
    // Arrange
    const claudeOnly = plan({
      sharedHistory: [
        { kind: 'claude', pool: '/state/fleet/shared/claude', migrated: 1, conflicts: 0, links: 1, changes: [] },
      ],
    });

    // Act + Assert
    should(renderApplyPlan(claudeOnly)).not.containEql('Codex resume');
    should(renderApplyPlan(plan())).not.containEql('Codex resume');
  });

  it('should repeat the Codex resume caveat after an apply that actually pooled it', () => {
    // Arrange
    const pooled = applyResult({
      sharedHistory: [
        { kind: 'claude', pool: '/state/fleet/shared/claude', migrated: 1, conflicts: 0, links: 1, changes: [] },
        { kind: 'codex', pool: '/state/fleet/shared/codex', migrated: 3, conflicts: 0, links: 3, changes: [] },
      ],
    });

    // Act
    const rendered = renderApplyResult(pooled);

    // Assert
    should(rendered).containEql('shared codex: 3 migrated entries');
    should(rendered).containEql('is linked into every Codex home');
    should(rendered).containEql('No history is deleted.');
    should(rendered).not.containEql('lost');
  });

  it('should leave a Claude-only apply free of the Codex caveat', () => {
    // Act + Assert
    should(renderApplyResult(applyResult())).not.containEql('Codex resume');
  });

  it('should name each source directory the migration empties and removes', () => {
    // Arrange
    const emptied = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 2,
          conflicts: 0,
          links: 2,
          changes: [],
          emptiedSourceDirectories: ['/homes/a/projects', '/homes/b/projects'],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(emptied);

    // Assert
    should(rendered).containEql('2 source directories emptied by moving every entry into the pool, then removed');
    should(rendered).containEql('/homes/a/projects');
    should(rendered).containEql('/homes/b/projects');
  });

  it('should keep the emptied source directories in the record of what an apply did', () => {
    // Act
    const rendered = renderApplyResult(
      applyResult({
        sharedHistory: [
          {
            kind: 'claude',
            pool: '/state/fleet/shared/claude',
            migrated: 1,
            conflicts: 0,
            links: 1,
            changes: [],
            emptiedSourceDirectories: ['/homes/a/projects'],
          },
        ],
      }),
    );

    // Assert
    should(rendered).containEql('1 source directory emptied by moving every entry into the pool, then removed');
    should(rendered).containEql('/homes/a/projects');
  });

  it('should say an unreadable home makes apply refuse the pool, not skip the home', () => {
    // Arrange
    const refused = plan({
      sharedHistory: [
        {
          kind: 'codex',
          pool: '/state/fleet/shared/codex',
          migrated: 0,
          conflicts: 0,
          links: 0,
          changes: [],
          refusals: [
            {
              account: 'b',
              home: '/homes/b',
              path: '/homes/b/sessions',
              reason: 'EACCES: permission denied',
            },
          ],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(refused);

    // Assert
    should(rendered).containEql('1 account home could not be read, so an apply REFUSES the whole codex pool');
    should(rendered).containEql('quietly leave these out');
    should(rendered).containEql('b (/homes/b) — EACCES: permission denied; refused at /homes/b/sessions');
    should(rendered).containEql('make that home readable, or stop declaring it');
  });

  it('should speak of several unreadable homes in the plural', () => {
    // Arrange
    const refused = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 0,
          conflicts: 0,
          links: 0,
          changes: [],
          refusals: [
            { account: 'b', home: '/homes/b', path: '/homes/b', reason: 'EACCES' },
            { account: 'c', home: '/homes/c', path: '/homes/c', reason: 'EIO' },
          ],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(refused);

    // Assert
    should(rendered).containEql('2 account homes could not be read');
    should(rendered).containEql('make those homes readable, or stop declaring them');
  });

  it('should state per merge which lines are appended and where later writes stay instead', () => {
    // Arrange
    const merging = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 0,
          conflicts: 0,
          links: 0,
          changes: [
            {
              kind: 'merge-jsonl',
              source: '/homes/a/history.jsonl',
              destination: '/pool/history.jsonl',
              sourcePreservedAt: '/pool/.migration-conflicts/a/history.jsonl',
            },
            {
              kind: 'merge-jsonl',
              source: '/homes/b/history.jsonl',
              destination: '/pool/history.jsonl',
              sourcePreservedAt: '/pool/.migration-conflicts/b/history.jsonl',
            },
          ],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(merging);

    // Assert: each merge names its own preserved file, because that is the file a person would open.
    should(rendered).containEql(
      'prompt history /homes/a/history.jsonl: only the lines observed here are appended to /pool/history.jsonl; whatever is written to it afterwards stays at /pool/.migration-conflicts/a/history.jsonl and never joins the pool',
    );
    should(rendered).containEql(
      'whatever is written to it afterwards stays at /pool/.migration-conflicts/b/history.jsonl and never joins the pool',
    );
    should(rendered).containEql('no prompt is discarded either way');
    should(rendered).containEql('pool prompt history while these accounts are idle');
    should(rendered).not.containEql('lost');
  });

  it('should carry the merge caveat into the applied report too', () => {
    // Act
    const rendered = renderApplyResult(
      applyResult({
        sharedHistory: [
          {
            kind: 'claude',
            pool: '/state/fleet/shared/claude',
            migrated: 1,
            conflicts: 0,
            links: 1,
            changes: [
              {
                kind: 'merge-jsonl',
                source: '/homes/a/history.jsonl',
                destination: '/pool/history.jsonl',
                sourcePreservedAt: '/pool/.migration-conflicts/a/history.jsonl',
              },
            ],
            refusals: [{ account: 'b', home: '/homes/b', path: '/homes/b', reason: 'EACCES' }],
          },
        ],
      }),
    );

    // Assert
    should(rendered).containEql('only the lines observed here are appended to /pool/history.jsonl');
    should(rendered).containEql('stays at /pool/.migration-conflicts/a/history.jsonl and never joins the pool');
    should(rendered).containEql('an apply REFUSES the whole claude pool');
  });

  it('should stay silent about emptied directories, merges and refusals when there are none', () => {
    // Arrange
    const quiet = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 0,
          conflicts: 0,
          links: 1,
          changes: [{ kind: 'link', path: '/homes/a/sessions', target: '/pool/sessions' }],
          emptiedSourceDirectories: [],
          refusals: [],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(quiet);

    // Assert
    should(rendered).containEql('link /homes/a/sessions → /pool/sessions');
    should(rendered).not.containEql('source director');
    should(rendered).not.containEql('prompt history');
    should(rendered).not.containEql('could not be read');
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

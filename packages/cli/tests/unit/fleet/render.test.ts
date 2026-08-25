import { describe, it } from 'bun:test';
import type { FleetAccountHealth, FleetIdentity, FleetIdentityMember, FleetIdentityStatus } from '@ferretry/fleet';
import should from 'should';
import {
  fleetAccountNames,
  renderAccount,
  renderApplyPlan,
  renderApplyResult,
  renderFleetApplyFailure,
  renderFleetSharing,
  renderHealth,
  renderIdentityStatus,
  renderLoginResults,
  renderLoginRow,
  renderManifest,
  renderRecommendation,
  renderRelativeInstant,
  renderScaffoldResult,
  renderUsage,
  renderUsageRow,
} from '../../../src/lib/fleet/render';
import {
  ACCOUNT_ID,
  account,
  applyResult,
  committedState,
  LOCK_RESIDUE,
  manifest,
  plan,
  ROLLBACK_INCOMPLETE,
  ROLLBACK_WITH_DISPLACED,
  ROLLED_BACK,
  recommendation,
  scaffoldResult,
  sharingAccount,
  sharingReport,
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

  it('should say what a symlink line means, only on a plan that has one', () => {
    // Arrange
    const linking = plan({
      operations: [{ kind: 'symlink', path: '/state/fleet/homes/a/CLAUDE.md', source: '/assets/CLAUDE.md' }],
    });

    // Act
    const rendered = renderApplyPlan(linking);

    // Assert — every other line in a plan writes bytes once; this one makes two names into one file, and
    // its effect keeps going after the apply finishes. Somebody approving it has to be told which.
    should(rendered).containEql('makes the destination the SAME FILE as the source');
    should(rendered).containEql('with no apply in between');
    // And a plan with no link says nothing about links, so the note stays a statement about this plan.
    should(renderApplyPlan(plan())).not.containEql('SAME FILE');
  });

  it('should name settings files and inline layers without printing their values', () => {
    // Arrange
    const withSettings = plan({
      operations: [
        {
          kind: 'settings',
          path: '/state/fleet/homes/a/settings.json',
          format: 'json',
          layers: [
            { from: 'file', path: '/state/fleet/assets/templates/claude/settings.json' },
            { from: 'inline', settings: { secretLookingValue: 'must-not-render' } },
          ],
          mode: 0o600,
          preserveExisting: true,
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(withSettings);

    // Assert
    should(rendered).containEql(
      '/state/fleet/homes/a/settings.json ← /state/fleet/assets/templates/claude/settings.json + [inline settings]',
    );
    should(rendered).not.containEql('must-not-render');
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

  it('should make an observed empty apply a next step, not an accomplishment', () => {
    // Act
    const rendered = renderApplyResult(applyResult({ accountCount: 0, operationCount: 4 }));

    // Assert
    should(rendered).containEql('The manifest declares no accounts');
    should(rendered).containEql('fy fleet init --first-account');
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

  it('should promise a pool link only for the emptied directories that actually get one', () => {
    // Arrange: the domain drains every depth, but only the shared-history entry is linked.
    const emptied = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 2,
          conflicts: 0,
          links: 1,
          changes: [{ kind: 'link', path: '/homes/b/projects', target: '/state/fleet/shared/claude/projects' }],
          emptiedSourceDirectories: ['/homes/b/projects/p1/deep', '/homes/b/projects/p1', '/homes/b/projects'],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(emptied);

    // Assert: the linked entry and the drained descendants are two different sentences.
    should(rendered).containEql(
      '1 source directory emptied by moving every entry into the pool, then replaced by a link to the pool:\n      /homes/b/projects\n',
    );
    should(rendered).containEql(
      '2 source directories emptied further down and removed with nothing put back, because the shared-history entry above each one carries the pool link:\n      /homes/b/projects/p1/deep\n      /homes/b/projects/p1',
    );
    // And the false claim the old wording made over the whole list is gone.
    should(rendered).not.containEql('3 source directories emptied by moving');
    should(rendered).not.containEql("takes each one's place");
  });

  it('should never claim a link replaces a nested directory when nothing is linked at all', () => {
    // Arrange: drained descendants with no link change of their own.
    const nested = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 1,
          conflicts: 0,
          links: 0,
          changes: [],
          emptiedSourceDirectories: ['/homes/a/projects/p1'],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(nested);

    // Assert
    should(rendered).containEql('1 source directory emptied further down and removed with nothing put back');
    should(rendered).containEql('/homes/a/projects/p1');
    should(rendered).not.containEql('replaced by a link to the pool');
  });

  it('should say nothing about descendants when only the entry directory was emptied', () => {
    // Arrange
    const flat = plan({
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/state/fleet/shared/claude',
          migrated: 1,
          conflicts: 0,
          links: 1,
          changes: [{ kind: 'link', path: '/homes/a/projects', target: '/state/fleet/shared/claude/projects' }],
          emptiedSourceDirectories: ['/homes/a/projects'],
        },
      ],
    });

    // Act
    const rendered = renderApplyPlan(flat);

    // Assert
    should(rendered).containEql(
      '1 source directory emptied by moving every entry into the pool, then replaced by a link',
    );
    should(rendered).not.containEql('emptied further down');
  });

  it('should keep the same split in the record of what an apply did', () => {
    // Act
    const rendered = renderApplyResult(
      applyResult({
        sharedHistory: [
          {
            kind: 'claude',
            pool: '/state/fleet/shared/claude',
            migrated: 2,
            conflicts: 0,
            links: 1,
            changes: [{ kind: 'link', path: '/homes/a/projects', target: '/state/fleet/shared/claude/projects' }],
            emptiedSourceDirectories: ['/homes/a/projects/p1', '/homes/a/projects'],
          },
        ],
      }),
    );

    // Assert
    should(rendered).containEql(
      '1 source directory emptied by moving every entry into the pool, then replaced by a link to the pool:\n      /homes/a/projects\n',
    );
    should(rendered).containEql(
      '1 source directory emptied further down and removed with nothing put back, because the shared-history entry above each one carries the pool link:\n      /homes/a/projects/p1',
    );
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
    should(rendered).containEql('serves opus (default)');
    should(rendered).containEql('available');
  });

  it('should state why an unavailable account cannot be used', () => {
    // Act
    const rendered = renderAccount(
      account({ available: false, unavailableReason: 'not logged in', defaultModel: null, models: [] }),
    );

    // Assert
    should(rendered).containEql('unavailable — not logged in');
    should(rendered).containEql('declares no models');
  });

  it('should say every model it serves, naming the default among them', () => {
    // Act
    const rendered = renderAccount(
      account({
        models: [
          { id: 'opus', available: true },
          { id: 'sonnet', available: true, displayName: 'Sonnet 5' },
        ],
      }),
    );

    // Assert
    should(rendered).containEql('serves opus (default), sonnet (Sonnet 5)');
  });

  it('should annotate a default that also carries a display name with both', () => {
    // Act
    const rendered = renderAccount(
      account({ defaultModel: 'opus', models: [{ id: 'opus', available: true, displayName: 'Opus 5' }] }),
    );

    // Assert
    should(rendered).containEql('serves opus (Opus 5, default)');
  });

  /**
   * REPLACES "should not count a model the account cannot actually serve".
   *
   * That assertion guaranteed one thing worth keeping — an unavailable model must never appear in the
   * list of what an account SERVES — and enforced it with `not.containEql('haiku')`, which also
   * guaranteed the reason was nowhere on the row. The first half still matters and is asserted here
   * against the `serves` line specifically. The second half was the defect: an account declaring a
   * model unavailable WITH a reason printed neither, so `fy fleet ls` was the one command that exists
   * to say what this host publishes and it silently dropped part of it.
   */
  it('should name an unavailable model and why, without offering it as one it serves', () => {
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
    should(rendered).containEql('serves opus (default)\n');
    should(rendered).containEql('model haiku is unavailable — retired');
    should(rendered.split('\n').find(line => line.includes('serves')) ?? '').not.containEql('haiku');
  });

  it('should not claim an unavailable account serves the models it declares', () => {
    // Act
    const rendered = renderAccount(
      account({
        available: false,
        unavailableReason: 'not logged in',
        models: [
          { id: 'opus', available: true },
          { id: 'haiku', available: false, unavailableReason: 'retired' },
        ],
      }),
    );

    // Assert
    should(rendered).containEql('declares opus (default)');
    should(rendered).not.containEql('serves');
    should(rendered).containEql('model haiku is unavailable — retired');
  });

  it('should say plainly when the manifest declares nothing', () => {
    // Act + Assert
    should(renderManifest(manifest([]))).containEql('The fleet manifest declares no accounts.');
    should(renderManifest(manifest([]))).containEql('fy fleet init --first-account');
  });

  it('should head the listing with when provisioning ran', () => {
    // Act + Assert
    should(renderManifest(manifest()).split('\n')[0]).equal('1 account provisioned 2026-07-31T09:00:00.000Z');
  });
});

/** The manifest join the controller supplies, so a row names something a person recognises. */
const usageNames = new Map([[ACCOUNT_ID, 'Claude (work)']]);

describe('the manifest name join', () => {
  it('should map each account id to the display name a person recognises', () => {
    // ONE join for both terminal reports, so `fy fleet usage` and `fy fleet health` cannot end up
    // naming the same account differently. `displayName` rather than `wrapper`, which is an absolute
    // path — naming a row after one puts `/state/fleet/bin/fy-claude-work` in it.
    should(fleetAccountNames(manifest()).get(ACCOUNT_ID)).equal('Claude (work)');
  });
});

describe('usage rendering', () => {
  /**
   * THE ROW NAMES THE ACCOUNT, not its id.
   *
   * It used to print the account UUID, so `8d071755-…  short 12% · long 4%` told a reader how many of
   * their accounts were busy and never which one. Unlike a health row this carries the name ALONE:
   * `fy fleet health` prints `fy fleet login <accountId>` because a login repairs that account, and
   * there is no command that repairs a quota number.
   */
  it('should name the account rather than printing its opaque id', () => {
    // Act
    const rendered = renderUsageRow(usageRow(), usageNames);

    // Assert
    should(rendered).equal('  Claude (work)  short 42% · long 11%');
    should(rendered).not.containEql(ACCOUNT_ID);
  });

  it('should name the account in every outcome, not only the one that reports a quota', () => {
    // Arrange — a row is unreadable in exactly the same way whichever branch produced it, and a fix
    // applied to the reporting branch alone leaves a UUID on precisely the rows something went wrong.
    const cases = [
      usageRow({ atLimit: true }),
      usageRow({ unavailable: true, ok: false, unavailableReason: 'no probe' }),
      usageRow({ ok: false, error: 'timeout' }),
      usageRow({ usageBased: false }),
    ];

    // Act + Assert
    for (const usage of cases) {
      should(renderUsageRow(usage, usageNames)).startWith('  Claude (work)  ');
    }
  });

  it('should fall back to the id when the manifest cannot name the account', () => {
    // Arrange — a snapshot can outlive the account it is about: the manifest moved, or somebody
    // removed the account. A quota about something the manifest cannot name is STILL a true quota, so
    // the row is printed with the id rather than hidden or given an invented name.
    // Act + Assert
    should(renderUsageRow(usageRow({ accountId: 'departed' }), usageNames)).containEql('departed  short 42%');
  });

  it('should offer no remedy line, because no command resets a quota window', () => {
    // A window resets on the provider's clock. `fy fleet health` prints a command beside an account a
    // login repairs; an instruction printed here would be the same unactionable row in a new costume.
    const rendered = renderUsageRow(usageRow({ atLimit: true }), usageNames);

    // Act + Assert
    should(rendered).not.containEql('\n');
    should(rendered).not.containEql('fy fleet');
  });

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

  it('should carry the names down to every row of the report', () => {
    // Act — the snapshot is what the collector returns; the names are the controller's join onto it.
    const rendered = renderUsage(usageSnapshot([usageRow(), usageRow({ accountId: 'departed' })]), usageNames);

    // Assert
    should(rendered).containEql('  Claude (work)  short 42%');
    should(rendered).containEql('  departed  short 42%');
  });
});

/**
 * Account health in a terminal.
 *
 * ONE FACT, ONE OWNER, TWO SURFACES. The daemon publishes a verdict and a reason CODE; this file owns
 * the terminal's words for it and `packages/pwa/src/lib/account-health-view.ts` owns the browser's.
 * Both read the same codes, so the two surfaces cannot describe the same account differently — and
 * neither is a degraded version of the other: the terminal shows the same four verdicts and the same
 * last-checked instant the browser does.
 */
const NOW = 1_786_000_000_000;
const healthRow = (overrides: Partial<FleetAccountHealth> = {}): FleetAccountHealth =>
  ({
    accountId: 'a',
    kind: 'claude',
    verdict: 'healthy',
    reason: 'provider_accepted',
    evidence: 'anthropic_usage',
    lastCheckedAt: NOW - 240_000,
    verdictAt: NOW - 240_000,
    lastCheckInconclusive: false,
    ...overrides,
  }) as FleetAccountHealth;

describe('relative instant rendering', () => {
  it('should use whole units, coarsest that fits', () => {
    // A terminal reader wants "4m ago", never a millisecond count.
    should(renderRelativeInstant(NOW - 5_000, NOW)).equal('just now');
    should(renderRelativeInstant(NOW - 240_000, NOW)).equal('4m ago');
    should(renderRelativeInstant(NOW - 7_200_000, NOW)).equal('2h ago');
    should(renderRelativeInstant(NOW - 172_800_000, NOW)).equal('2d ago');
  });

  it('should never render a future instant as negative', () => {
    // A daemon clock a little ahead of this process is ordinary, and "-3m ago" is not a time.
    should(renderRelativeInstant(NOW + 60_000, NOW)).equal('just now');
  });
});

/** The manifest join the controller supplies, so a verdict names something a person can act on. */
const names = new Map([['a', 'claude-default']]);

describe('health rendering', () => {
  it('should name the verdict, when it was checked, and why', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [healthRow()] }, names);

    // Assert — the time is part of the verdict, not decoration: "HEALTHY" with no instant is a claim
    // with no expiry, and the evidence behind it has a fifteen-minute horizon.
    should(rendered).containEql('claude-default  HEALTHY  checked 4m ago — the provider accepted this credential');
  });

  /**
   * THE ROW NAMES THE ACCOUNT, not its id.
   *
   * It used to print the account UUID. That answered "how many accounts need a login" and never
   * "which" — and "NEEDS LOGIN" beside an id a person cannot resolve, and cannot type into
   * `fy fleet login`, is an instruction that cannot be followed.
   */
  it('should name the account AND give the exact command, because the id is what the command takes', () => {
    // Act
    const rendered = renderHealth(
      { at: NOW, accounts: [healthRow({ verdict: 'needs_relogin', reason: 'oauth_token_rejected' })] },
      names,
    );

    // Assert — BOTH halves. The name answers "which account", and `fy fleet login` matches on the
    // ACCOUNT ID (see `selectIdentities`), so a row carrying only a name would be readable and
    // unactionable — the opposite of the failure this replaced.
    should(rendered).containEql('claude-default  NEEDS LOGIN');
    should(rendered).containEql('fy fleet login a');
  });

  it('should offer no command for a verdict a command cannot fix', () => {
    // Arrange — a static credential cannot be repaired by signing in, and Codex cannot be proved at
    // all. Printing `fy fleet login` beside either would be an instruction that does not help.
    const cases = [
      healthRow({ verdict: 'needs_credentials', reason: 'static_credential_rejected' }),
      healthRow({ verdict: 'unknown', reason: 'codex_liveness_unproven', kind: 'codex' }),
      healthRow(),
    ];

    // Act / Assert
    for (const account of cases) {
      should(renderHealth({ at: NOW, accounts: [account] }, names)).not.containEql('fy fleet login');
    }
  });

  it('should fall back to the id when the manifest cannot name the account', () => {
    // Arrange — a stored head can outlive the account it is about: the manifest moved, or somebody
    // removed the account. A verdict about something the manifest cannot name is STILL a true verdict,
    // so the row is printed with the id rather than hidden or given an invented name.
    const rendered = renderHealth({ at: NOW, accounts: [healthRow({ accountId: 'departed' })] }, names);

    // Assert
    should(rendered).containEql('departed  HEALTHY');
  });

  it('should count the two verdicts somebody must ACT on, and not count unknown among them', () => {
    // Arrange
    const rows = [
      healthRow({ accountId: 'a', verdict: 'needs_relogin', reason: 'oauth_token_rejected' }),
      healthRow({ accountId: 'b', verdict: 'needs_credentials', reason: 'static_credential_missing' }),
      healthRow({ accountId: 'c', verdict: 'unknown', reason: 'codex_liveness_unproven', kind: 'codex' }),
    ];

    // Act
    const rendered = renderHealth({ at: NOW, accounts: rows });

    // Assert — unknown is not a fault. On Codex it is the CORRECT published answer, and counting it
    // beside real rejections would send a person hunting a problem that is not there.
    should(rendered.split('\n')[0]).equal('3 accounts, 1 need sign-in, 1 need a credential');
  });

  it('should offer a CREDENTIAL, not a login, for an account no login can fix', () => {
    // Arrange / Act — the harness reads an environment variable and never consults its own credential
    // store, so telling somebody to sign in sends them to do something that cannot work.
    const rendered = renderHealth({
      at: NOW,
      accounts: [healthRow({ verdict: 'needs_credentials', reason: 'static_credential_rejected' })],
    });

    // Assert
    should(rendered).containEql('NEEDS CREDENTIAL');
    should(rendered).not.containEql('NEEDS LOGIN');
  });

  it('should call a 403 healthy and say the quota is what is unknown', () => {
    // Arrange / Act — the rule the whole feature turns on.
    const rendered = renderHealth({
      at: NOW,
      accounts: [healthRow({ reason: 'usage_scope_unavailable' })],
    });

    // Assert
    should(rendered).containEql('HEALTHY');
    should(rendered).containEql('quota is unknown');
    should(rendered).not.containEql('NEEDS LOGIN');
  });

  it('should say NEVER CHECKED rather than inventing an instant', () => {
    // Arrange / Act
    const rendered = renderHealth({
      at: NOW,
      accounts: [healthRow({ verdict: 'unknown', reason: 'never_checked', lastCheckedAt: null, verdictAt: null })],
    });

    // Assert — a fabricated "now" here would be indistinguishable from a check that just succeeded.
    should(rendered).containEql('checked never checked — never checked');
  });

  it('should report what a stale verdict WAS, and that the last check was inconclusive', () => {
    // Arrange
    const rows = [
      healthRow({
        accountId: 'a',
        verdict: 'unknown',
        reason: 'stale',
        staleVerdict: 'healthy',
        lastCheckedAt: NOW - 60_000,
      }),
      healthRow({ accountId: 'b', lastCheckInconclusive: true, lastCheckedAt: NOW - 60_000 }),
    ];

    // Act
    const rendered = renderHealth({ at: NOW, accounts: rows });

    // Assert — a bare UNKNOWN reads exactly like an account nobody ever checked, and hiding a failed
    // attempt is how a fleet reads healthy while every provider call is failing.
    should(rendered).containEql('a  UNKNOWN (was HEALTHY)');
    should(rendered).containEql('b  HEALTHY');
    should(rendered).containEql('last check was inconclusive');
  });

  it('should state that it spends nothing, every time', () => {
    // The command this replaced launched every account's wrapper and asked a model for a sentinel.
    // Somebody who used it before has every reason to assume this one still bills them.
    should(renderHealth({ at: NOW, accounts: [healthRow()] })).containEql('uses no inference quota');
  });

  it('should explain an empty health snapshot without pretending a check ran', () => {
    should(renderHealth({ at: NOW, accounts: [] })).equal('No accounts to report health for.');
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
      { accountId: 'i', identity: KEY, status: 'renewed' },
    ]);

    // Assert — a failure and an unknown are counted apart, because they need different next steps.
    should(actual).containEql('9 accounts, 1 failed, 1 could not be read');
    should(actual).containEql('a  logged in');
    // A renewal is not "already had a usable credential": it is an approval this run did not cost.
    should(actual).containEql('i  expired token renewed itself, nobody was asked');
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
    should(actual).containEql('created  /state/fleet/config.yaml (Ferretry starter)');
    should(actual).containEql('export PATH="/state/fleet/bin:$PATH"');
  });

  it('should still print the PATH line on a re-run that changed nothing', () => {
    // Act — the line is the one step nothing else can do for the person.
    const actual = renderScaffoldResult(scaffoldResult({ created: [], kept: ['/state/fleet/config.yaml'] }));

    // Assert
    should(actual).containEql('already set up');
    should(actual).containEql(
      'kept     /state/fleet/config.yaml (pre-existing file wins; Ferretry did not replace it)',
    );
    should(actual).containEql('export PATH=');
  });

  it('should say directly which harnesses this run declared accounts for', () => {
    // Act
    const actual = renderScaffoldResult(
      scaffoldResult({
        created: [],
        updated: ['/state/fleet/config.yaml'],
        declaredAccounts: ['codex'],
      }),
      'codex',
    );

    // Assert — the harnesses rather than a count, because each declares two lanes.
    should(actual).containEql('Declared the default codex accounts');
    should(actual).not.containEql('If this command');
  });

  it('should name every harness when a host had both detected', () => {
    // Act
    const actual = renderScaffoldResult(
      scaffoldResult({ created: ['/state/fleet/config.yaml'], declaredAccounts: ['claude', 'codex'] }),
    );

    // Assert
    should(actual).containEql('Declared the default claude and codex accounts');
  });

  it('should not claim a directory it does not know', () => {
    // Act
    const actual = renderScaffoldResult(scaffoldResult({ directories: [] }));

    // Assert
    should(actual).containEql('prepared the fleet in its directory');
  });
});

describe('rendering how an apply ended badly', () => {
  it('should lead with the verdict, not the error, for a clean rollback', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLED_BACK);

    // Assert — "what is my host now" is the question that decides what happens next
    should(actual.split('\n')[1]).containEql('the host is exactly as it was');
    should(actual).containEql('nothing was committed');
  });

  it('should print an unrestored path with no surviving backup without inventing one', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLBACK_INCOMPLETE);

    // Assert
    should(actual).containEql('/state/fleet/bin/fy-claude-work — still held open');
    should(actual).containEql('2 paths whose previous state could not be put back');
    // The entry without a backup must not claim one exists
    should(actual.split('\n').filter(line => line.includes('the original is still at'))).have.length(1);
  });

  it('should count a single unrestored path in the singular', () => {
    // Act
    const actual = renderFleetApplyFailure({
      kind: 'rollback-incomplete',
      failedOperation: 'file /a',
      reason: 'nope',
      unrestored: [{ path: '/a', reason: 'busy' }],
    });

    // Assert
    should(actual).containEql('1 path whose previous state could not be put back');
  });

  it('should report the history migrations that DID complete before the failure', () => {
    // Act — the committed state is the point; a partial migration is part of it
    const actual = renderFleetApplyFailure({
      kind: 'history-failed-after-commit',
      failedHarness: 'codex',
      reason: 'pool vanished',
      committed: committedState({
        sharedHistory: [
          { kind: 'claude', pool: '/state/fleet/shared/claude', migrated: 3, conflicts: 1, links: 2, changes: [] },
        ],
      }),
    });

    // Assert
    should(actual).containEql(
      'shared claude: 3 migrated entries, 1 collisions preserved, 2 links → /state/fleet/shared/claude',
    );
    should(actual).containEql('THE FLEET DID LAND');
  });

  it('should say nothing about residue when an apply left none', () => {
    // Act
    const actual = renderFleetApplyFailure({
      kind: 'history-failed-after-commit',
      failedHarness: 'claude',
      reason: 'nope',
      committed: committedState(),
    });

    // Assert
    should(actual).not.containEql('moved-aside');
  });

  it('should keep a successful apply unchanged when there is no residue', () => {
    // Act — the success surface must not grow noise for the ordinary case
    const actual = renderApplyResult(applyResult());

    // Assert
    should(actual).not.containEql('moved-aside');
    should(actual).containEql('applied 1 account in 2 operations');
  });

  it('should count one moved-aside original in the singular', () => {
    // Act
    const actual = renderApplyResult(applyResult({ backupResidue: ['/state/fleet/.bak/one'] }));

    // Assert
    should(actual).containEql('1 moved-aside original');
  });
});

describe('rendering residue and displacement a failed apply left behind', () => {
  it('should keep displaced content in its own block, never folded into unrestored', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLBACK_WITH_DISPLACED);

    // Assert — unrestored is OUR state we could not put back; displaced is SOMEBODY ELSE'S file now
    // living under another name. A reader acts differently on each, so they must not be one list.
    should(actual).containEql('1 path whose previous state could not be put back');
    // Plural agreement matters here: this block is usually printed with more than one entry.
    should(actual).containEql('2 paths not belonging to this apply, moved aside and left there');
    should(actual).containEql('/state/fleet/homes/work/AGENTS.md → /state/fleet/.bak/AGENTS.md');
    should(actual).containEql('/state/fleet/homes/work/skills → /state/fleet/.bak/skills');
  });

  it('should say nothing about displacement when nothing of anyone else was moved', () => {
    // Act — the ordinary rollback-incomplete carries no displaced entries
    const actual = renderFleetApplyFailure(ROLLBACK_INCOMPLETE);

    // Assert
    should(actual).not.containEql('moved aside');
  });

  it('should name a stuck apply claim and say it blocks the next apply', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLED_BACK, LOCK_RESIDUE);

    // Assert — residue, never a failure, but it is not cosmetic either
    should(actual).containEql(`the exclusive apply claim at ${LOCK_RESIDUE} could not be cleared`);
    should(actual).containEql('the next apply will refuse until it is removed');
  });

  it('should stop calling a re-run safe when a claim is still blocking it', () => {
    // Act — "the host is exactly as it was" is true; "safe to run again" would not be
    const actual = renderFleetApplyFailure(ROLLED_BACK, LOCK_RESIDUE);

    // Assert
    should(actual).not.containEql('safe to fix the cause');
    should(actual).containEql('fix the cause AND clear the claim above');
  });

  it('should still call a clean rollback safe to re-run', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLED_BACK);

    // Assert
    should(actual).containEql('safe to fix the cause and run "fy fleet apply" again');
    should(actual).not.containEql('exclusive apply claim');
  });

  it('should carry a stuck claim through the unverified-state outcome too', () => {
    // Act
    const actual = renderFleetApplyFailure(ROLLBACK_INCOMPLETE, LOCK_RESIDUE);

    // Assert
    should(actual).containEql('UNVERIFIED STATE');
    should(actual).containEql(`the exclusive apply claim at ${LOCK_RESIDUE} could not be cleared`);
  });

  it('should report a claim the committed state itself carries', () => {
    // Act
    const actual = renderFleetApplyFailure({
      kind: 'history-failed-after-commit',
      failedHarness: 'claude',
      reason: 'pool vanished',
      committed: committedState({ lockResidue: LOCK_RESIDUE }),
    });

    // Assert
    should(actual).containEql('THE FLEET DID LAND');
    should(actual).containEql(`the exclusive apply claim at ${LOCK_RESIDUE} could not be cleared`);
  });

  it('should not print the same stuck claim twice when both sides carry it', () => {
    // Act — the committed block and the error both know about one claim; it is still one claim
    const actual = renderFleetApplyFailure(
      {
        kind: 'history-failed-after-commit',
        failedHarness: 'claude',
        reason: 'pool vanished',
        committed: committedState({ lockResidue: LOCK_RESIDUE }),
      },
      LOCK_RESIDUE,
    );

    // Assert
    should(actual.split('\n').filter(line => line.includes('exclusive apply claim'))).have.length(1);
  });

  it('should report a claim the error knows about that the committed state does not', () => {
    // Act
    const actual = renderFleetApplyFailure(
      {
        kind: 'history-failed-after-commit',
        failedHarness: 'claude',
        reason: 'pool vanished',
        committed: committedState(),
      },
      LOCK_RESIDUE,
    );

    // Assert
    should(actual).containEql(`the exclusive apply claim at ${LOCK_RESIDUE} could not be cleared`);
  });

  it('should report a stuck claim on a SUCCESSFUL apply, without calling it a failure', () => {
    // Act
    const actual = renderApplyResult(applyResult({ lockResidue: LOCK_RESIDUE }));

    // Assert — the fleet landed; the claim is residue that blocks the next run
    should(actual).containEql('applied 1 account in 2 operations');
    should(actual).containEql(`the exclusive apply claim at ${LOCK_RESIDUE} could not be cleared`);
    should(actual).not.containEql('failed');
  });

  it('should stay quiet on a successful apply that left no claim', () => {
    // Act
    const actual = renderApplyResult(applyResult());

    // Assert
    should(actual).not.containEql('exclusive apply claim');
  });
});

describe('rendering the sharing report', () => {
  it('should say what is shared, who is on it, and where each value comes from', () => {
    // Act
    const actual = renderFleetSharing(sharingReport());

    // Assert — the two questions a person has, in the order they ask them.
    should(actual).containEql('Shared documents');
    should(actual).containEql('memory/default  ./CLAUDE.md · 1 account');
    should(actual).containEql('Claude (primary) (claude-primary, claude)');
    should(actual).containEql('SHARED "default" · only this account');
    should(actual).containEql('from the base profile');
  });

  it('should list a skills selection item by item rather than as a count', () => {
    // Arrange — one store item two accounts are on, and one path the store never declared.
    const report = sharingReport({
      accounts: [
        sharingAccount({
          fields: {
            ...sharingAccount().fields,
            skills: {
              state: 'selection',
              origin: { kind: 'account' },
              items: [
                { name: 'review', path: 'skills/review', sharedName: 'review', referrers: 2, materialization: 'link' },
                { name: 'mine', path: 'skills/mine', referrers: 1, materialization: 'copy' },
              ],
            },
          },
        }),
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — which ones, which are the store's, and who else is on each: a count answers none of it.
    should(actual).containEql('skills   2 items · from this account');
    should(actual).containEql('review  SHARED "review" · with 1 other account · skills/review · linked');
    should(actual).containEql('mine  own · only this account · skills/mine · copied at apply');
  });

  it('should say which mechanism each field has, and what each one means for an edit', () => {
    // Arrange — a stack of settings layers alongside the linked memory document, so both the per-field
    // mechanism and the generated-file statement are on the same screen.
    const report = sharingReport({
      accounts: [
        sharingAccount({
          settings: [
            {
              position: 0,
              kind: 'document',
              path: './base.json',
              origin: { kind: 'base-profile', name: 'base' },
              referrers: 1,
            },
            { position: 1, kind: 'inline', origin: { kind: 'account' } },
          ],
        }),
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — the mechanism per field, the stack said as one generated file, and a legend written
    // about the EDIT rather than about the filesystem: "symlink" answers nothing a person came to ask.
    should(actual).containEql('./CLAUDE.md · from the base profile · linked');
    should(actual).containEql('settings  2 layers merged in order into one generated file');
    should(actual).containEql('linked = one file.');
    should(actual).containEql('copied at apply = the bytes as of the last apply');
    should(actual).containEql('generated = composed from its layers on every apply');
  });

  it('should say nothing about a mechanism for a field whose harness has no destination', () => {
    // Arrange — a Claude account declaring `hooks`, which Claude has no destination for. The report
    // carries no materialization for it, and `linkable` already excludes it.
    const report = sharingReport({
      accounts: [
        sharingAccount({
          fields: {
            ...sharingAccount().fields,
            hooks: { state: 'local', path: './hooks.json', origin: { kind: 'account' }, referrers: 1 },
          },
          linkable: ['memory', 'skills', 'hooks', 'mcp'],
        }),
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — the field is still described; only the mechanism sentence is withheld, because there is
    // no write to describe.
    should(actual).containEql('./hooks.json · from this account');
    should(actual).not.containEql('./hooks.json · from this account · linked');
    should(actual).not.containEql('./hooks.json · from this account · copied at apply');
  });

  it('should render a generated field rather than silently dropping a mechanism the wire admits', () => {
    // Arrange — no field the daemon reports today is `generated`; `settings` is a stack and is reported
    // separately. But the wire enum admits all three values for every field, so a renderer that said
    // nothing for one of them would be an unhandled case waiting for the first field that used it.
    const report = sharingReport({
      accounts: [
        sharingAccount({
          fields: {
            ...sharingAccount().fields,
            mcp: {
              state: 'local',
              path: './own.json',
              origin: { kind: 'account' },
              referrers: 1,
              materialization: 'generated',
            },
          },
        }),
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — and the sentence is about the edit: a generated file is the one a person must NOT edit
    // in the home, which is the whole reason the three mechanisms are named separately.
    should(actual).containEql('./own.json · from this account · merged into a generated file');
  });

  it('should say an empty selection is empty rather than printing nothing', () => {
    // Arrange
    const report = sharingReport({
      accounts: [
        sharingAccount({
          fields: {
            ...sharingAccount().fields,
            skills: { state: 'selection', origin: { kind: 'account' }, items: [] },
          },
        }),
      ],
    });

    // Act / Assert — an account that dropped every item said something, and the screen has to show it.
    should(renderFleetSharing(report)).containEql('skills   none selected · from this account');
  });

  it('should call out a path several accounts share without it being declared', () => {
    // Arrange
    const report = sharingReport({
      documents: [],
      accounts: [
        {
          accountId: ACCOUNT_ID,
          kind: 'claude',
          wrapper: 'claude-primary',
          displayName: 'Claude (primary)',
          fields: {
            memory: {
              state: 'local',
              path: './CLAUDE.md',
              origin: { kind: 'agent', name: 'primary' },
              referrers: 3,
            },
            skills: { state: 'absent' },
            hooks: { state: 'absent' },
            hooksDir: { state: 'absent' },
            mcp: { state: 'absent' },
          },
          settings: [
            { position: 0, kind: 'inline', origin: { kind: 'variant', name: 'auto' } },
            {
              position: 1,
              kind: 'document',
              path: './base.json',
              name: 'base',
              origin: { kind: 'agent-profile', name: 'house' },
              referrers: 2,
            },
          ],
          linkable: ['memory'],
        },
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — a fleet sharing something it never declared is a state to offer to fix, not one to hide.
    should(actual).containEql('own copy · also used by 2 other accounts, undeclared');
    should(actual).containEql('from the primary agent');
    should(actual).containEql('[0] inline · from the auto lane');
    should(actual).containEql('[1] SHARED "base"');
    should(actual).containEql('This fleet declares no shared documents.');
  });

  it('should name a declared document nobody uses, and a fleet with no accounts', () => {
    // Arrange
    const report = sharingReport({
      documents: [{ field: 'skills', name: 'default', path: './skills', accounts: [] }],
      accounts: [],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — an offer nobody has taken up is exactly what a person wants to see.
    should(actual).containEql('skills/default  ./skills · used by no account');
    should(actual).containEql('This fleet declares no accounts.');
  });

  it('should call a genuinely private document an own copy and nothing more', () => {
    // Arrange
    const report = sharingReport({
      documents: [],
      accounts: [
        sharingAccount({
          fields: {
            memory: {
              state: 'local',
              path: 'accounts/claude-primary/CLAUDE.md',
              origin: { kind: 'account' },
              referrers: 1,
            },
            skills: { state: 'absent' },
            hooks: { state: 'absent' },
            hooksDir: { state: 'absent' },
            mcp: { state: 'absent' },
          },
          linkable: ['memory'],
        }),
      ],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — one account using its own document needs no adjective; "undeclared" belongs only to a
    // path several accounts share without the fleet having said so.
    should(actual).containEql('own copy');
    should(actual).not.containEql('undeclared');
    should(actual).containEql('accounts/claude-primary/CLAUDE.md · from this account');
  });

  it('should print an absent field as a dash rather than omitting the row', () => {
    // Arrange
    const report = sharingReport({
      accounts: [sharingAccount({ linkable: ['memory', 'skills'] })],
    });

    // Act
    const actual = renderFleetSharing(report);

    // Assert — a row that is simply missing reads as "I did not look".
    should(actual).match(/skills {3}—/u);
  });
});

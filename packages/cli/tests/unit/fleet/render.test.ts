import { describe, it } from 'bun:test';
import type { FleetAccountHealth, FleetIdentity, FleetIdentityMember, FleetIdentityStatus } from '@ferretry/fleet';
import should from 'should';
import type { FleetPalette, FleetPresentation } from '../../../src/lib/fleet/presentation';
import { PLAIN_FLEET_PRESENTATION } from '../../../src/lib/fleet/presentation';
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

/**
 * A palette that names the ROLE that painted each span.
 *
 * Asserting on an escape code would test chalk, and asserting on the plain text would test nothing:
 * these tests are about which MEANING reached which span, so the palette writes the meaning down.
 * `chalkFleetPalette` is the only thing that turns one of these into a colour, and it is proved in
 * `tests/integration/terminal-adapters.test.ts` where the terminal dependency is allowed to live.
 */
const LABELLED_PALETTE: FleetPalette = {
  danger: text => `<danger>${text}</danger>`,
  good: text => `<good>${text}</good>`,
  muted: text => `<muted>${text}</muted>`,
  command: text => `<command>${text}</command>`,
};

const plainAt = (width: number): FleetPresentation => ({ ...PLAIN_FLEET_PRESENTATION, width });
const labelled = (width = 120): FleetPresentation => ({ palette: LABELLED_PALETTE, width });
/** Wide enough that nothing wraps, so a test about WHAT is printed is not also a test about where. */
const WIDE = plainAt(120);

/** One of every verdict, all checked at the same instant, in deliberately unhelpful manifest order. */
const oneOfEach: FleetAccountHealth[] = [
  healthRow({ accountId: 'h' }),
  healthRow({ accountId: 'u', verdict: 'unknown', reason: 'codex_liveness_unproven', kind: 'codex' }),
  healthRow({ accountId: 'c', verdict: 'needs_credentials', reason: 'static_credential_missing' }),
  healthRow({ accountId: 'r', verdict: 'needs_relogin', reason: 'oauth_token_rejected' }),
];
const everyName = new Map([
  ['h', 'Claude (research)'],
  ['u', 'Codex (default)'],
  ['c', 'Claude (bulk)'],
  ['r', 'Claude (default)'],
]);

describe('health rendering', () => {
  it('should account for EVERY account in one header line, not only the actionable ones', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, WIDE);

    // Assert — "4 accounts, 2 need sign-in" said nothing about the other two and read as a promise
    // that they were fine. They were UNKNOWN. Every verdict present is now named and counted.
    should(rendered.split('\n')[0]).equal(
      '4 accounts · 1 needs sign-in · 1 needs a credential · 1 unknown · 1 healthy · checked 4m ago',
    );
  });

  it('should fold the header at the terminal width rather than off the edge of it', () => {
    // Act — the same five counts on a terminal too narrow to hold them.
    const lines = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, plainAt(80)).split('\n');

    // Assert — it breaks between counts, never inside one, and the fold is indented so it cannot be
    // mistaken for the first row.
    should(lines[0]).equal('4 accounts · 1 needs sign-in · 1 needs a credential · 1 unknown · 1 healthy');
    should(lines[1]).equal('  checked 4m ago');
  });

  it('should say a check time the whole fleet shares ONCE, in the header', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, WIDE);
    const rows = rendered.split('\n').filter(line => /(NEEDS|UNKNOWN|HEALTHY)/u.test(line));

    // Assert — four copies of one fact used to sit in the widest column of every row, pushing the
    // reason off the edge of an 80-column terminal.
    should(rendered).containEql('· checked 4m ago');
    should(rows.filter(line => line.includes('checked 4m ago'))).be.empty();
  });

  it('should keep the check time on the ROWS when the rows disagree about it', () => {
    // Arrange — a header that flattened two different instants into one would report something
    // nobody measured, so the deduplication only applies when there is one instant to state.
    const accounts = [
      healthRow({ accountId: 'r', verdict: 'needs_relogin', reason: 'oauth_token_rejected' }),
      healthRow({ accountId: 'h', lastCheckedAt: NOW - 7_200_000 }),
    ];

    // Act
    const rendered = renderHealth({ at: NOW, accounts }, new Map(), PLAIN_FLEET_PRESENTATION);

    // Assert
    should(rendered.split('\n')[0]).equal('2 accounts · 1 needs sign-in · 1 healthy');
    should(rendered).containEql('· checked 4m ago');
    should(rendered).containEql('· checked 2h ago');
  });

  it('should order the rows worst first rather than in manifest order', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, WIDE);
    const verdicts = rendered
      .split('\n')
      .flatMap(line => ['NEEDS LOGIN', 'NEEDS CREDENTIAL', 'UNKNOWN', 'HEALTHY'].filter(word => line.includes(word)));

    // Assert — manifest order mixed the actionable with the non-actionable, so the whole report had
    // to be read before anything could be triaged. The header counts in this same order.
    should(verdicts).eql(['NEEDS LOGIN', 'NEEDS CREDENTIAL', 'UNKNOWN', 'HEALTHY']);
  });

  it('should line the verdicts up in one column whatever the names are', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, WIDE);
    const columns = new Set(
      rendered
        .split('\n')
        .filter(line => /(NEEDS|UNKNOWN|HEALTHY)/u.test(line) && line.startsWith('  '))
        .map(line => line.search(/(NEEDS|UNKNOWN|HEALTHY)/u)),
    );

    // Assert — the verdict used to start wherever the account name happened to end, so there was no
    // column for the eye to run down and every row had to be read individually.
    should(columns).have.size(1);
  });

  it('should carry severity in colour AND in a glyph, so a pipe loses nothing', () => {
    // Arrange / Act
    const painted = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, labelled());
    const bare = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, PLAIN_FLEET_PRESENTATION);

    // Assert — colour is the SECOND channel and never the only one. `NO_COLOR`, a redirect and a
    // reader who cannot separate red from grey all keep the glyph, the column and the order.
    should(painted).containEql('<danger>✗</danger> Claude (default)   <danger>NEEDS LOGIN</danger>');
    should(painted).containEql('<danger>✗</danger> Claude (bulk)      <danger>NEEDS CREDENTIAL</danger>');
    should(painted).containEql('<good>✓</good> Claude (research)  <good>HEALTHY</good>');
    should(bare).containEql('✗ Claude (default)   NEEDS LOGIN');
    should(bare).containEql('✓ Claude (research)  HEALTHY');
    should(bare).not.containEql('<danger>');
  });

  it('should mute UNKNOWN rather than paint it as a warning', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: oneOfEach }, everyName, labelled());

    // Assert — unknown is an honest absence of evidence, not a fault: it is what Codex correctly
    // publishes about itself, and a fleet whose every Codex row glowed amber would teach its owner
    // to look past amber, which is the one place a real warning has to work.
    should(rendered).containEql('<muted>?</muted> Codex (default)    <muted>UNKNOWN</muted>');
    should(rendered).not.containEql('<danger>UNKNOWN');
    should(rendered).not.containEql('<good>UNKNOWN');
  });

  it('should offer the exact command as a copy-paste target, carrying the whole account id', () => {
    // Arrange — `fy fleet login` matches on exactly this id (see `selectIdentities`), so a shortened
    // one would produce a line that looks copyable and is not.
    const accountId = '34ffb79f-786c-4179-a8aa-f2180a76252a';
    const accounts = [healthRow({ accountId, verdict: 'needs_relogin', reason: 'oauth_token_rejected' })];

    // Act
    const rendered = renderHealth({ at: NOW, accounts }, new Map([[accountId, 'Claude (default)']]), labelled());

    // Assert
    should(rendered).containEql(`<command>fy fleet login ${accountId}</command>`);
  });

  it('should never break the remedy across lines, however narrow the terminal is', () => {
    // Arrange — the command is meant to be SELECTED rather than read, and a break inside the id
    // produces two lines neither of which works when pasted.
    const accountId = '34ffb79f-786c-4179-a8aa-f2180a76252a';
    const accounts = [healthRow({ accountId, verdict: 'needs_relogin', reason: 'oauth_token_rejected' })];

    // Act
    const rendered = renderHealth({ at: NOW, accounts }, new Map(), plainAt(40));

    // Assert
    should(rendered.split('\n')).containEql(`      fy fleet login ${accountId}`);
  });

  it('should offer no command for a state a command cannot fix', () => {
    // Arrange — a static credential cannot be repaired by signing in, and Codex cannot be proved at
    // all. Printing `fy fleet login` beside either would be an instruction that does not help.
    //
    // The `stale` row is here because the remedy is keyed on the REASON now: a conclusion too old to
    // trust publishes `unknown`/`stale` while remembering it WAS `needs_relogin`, and printing a
    // command on the strength of an expired claim is exactly the regression that rekeying invites.
    const cases = [
      healthRow({ verdict: 'needs_credentials', reason: 'static_credential_rejected' }),
      healthRow({ verdict: 'unknown', reason: 'codex_liveness_unproven', kind: 'codex' }),
      healthRow({ verdict: 'unknown', reason: 'stale', staleVerdict: 'needs_relogin' }),
      healthRow(),
    ];

    // Act / Assert
    for (const account of cases) {
      should(renderHealth({ at: NOW, accounts: [account] }, names, PLAIN_FLEET_PRESENTATION)).not.containEql(
        'fy fleet login',
      );
    }
  });

  it('should indent a wrapped clause UNDER its row, so half a sentence cannot read as a new account', () => {
    // Arrange — the terminal used to do this wrapping, and a terminal indents nothing: the second
    // half of a reason started hard against the left margin and read as the next top-level row.
    const accounts = [healthRow({ accountId: 'r', verdict: 'needs_relogin', reason: 'oauth_access_expired' })];

    // Act
    const lines = renderHealth({ at: NOW, accounts }, new Map(), plainAt(48)).split('\n');
    const wrapped = lines.filter(line => line.startsWith('    ') && !line.trimStart().startsWith('fy '));

    // Assert — every continuation sits deeper than the two spaces a row starts at, and no line is
    // longer than the terminal is wide.
    should(wrapped).not.be.empty();
    should(lines.filter(line => line.length > 48)).be.empty();
    should(lines.some(line => line.startsWith('  ✗'))).be.true();
  });

  it('should drop the reason onto its own line when the columns leave no room for it', () => {
    // Arrange — a name plus a verdict can consume the whole width on a narrow terminal, and a
    // one-word-per-line reason squeezed into what is left is not an improvement on wrapping.
    const accounts = [healthRow({ accountId: 'r', verdict: 'needs_credentials', reason: 'static_credential_missing' })];

    // Act
    const lines = renderHealth({ at: NOW, accounts }, new Map([['r', 'Claude (bulk, api key)']]), plainAt(44)).split(
      '\n',
    );

    // Assert — the row ends at its verdict, and the reason follows at the continuation indent.
    should(lines).containEql('  ✗ Claude (bulk, api key)  NEEDS CREDENTIAL');
    should(lines).containEql('    the configured credential is absent');
  });

  it('should say the Codex answer once, in one clause', () => {
    // Arrange — it used to be three clauses saying one thing: "Codex has no free way to prove a
    // login; nothing here is a verdict; last check was inconclusive", on the only row that repeats
    // identically down the whole report.
    const accounts = [
      healthRow({
        verdict: 'unknown',
        reason: 'codex_liveness_unproven',
        kind: 'codex',
        lastCheckInconclusive: true,
      }),
    ];

    // Act
    const rendered = renderHealth({ at: NOW, accounts }, names, WIDE);

    // Assert
    should(rendered).containEql('UNKNOWN  Codex offers no free check');
    should(rendered).not.containEql('nothing here is a verdict');
    should(rendered).not.containEql('inconclusive');
  });

  it('should never tell somebody to sign in over a rejection it could not attribute', () => {
    // Arrange — a `401` from that endpoint cannot tell a dead login from a client the provider does
    // not accept. It used to be read as "the provider rejected this token" with `fy fleet login <id>`
    // printed beside it, and wrongly sending somebody to re-authenticate a login that is FINE is the
    // worst outcome available: it costs a browser approval and fixes nothing.
    const accounts = [
      healthRow({
        accountId: 'r',
        verdict: 'unknown',
        reason: 'oauth_rejection_unconfirmed',
        lastCheckInconclusive: true,
      }),
    ];

    // Act
    const painted = renderHealth({ at: NOW, accounts }, new Map([['r', 'Claude (default)']]), labelled());

    // Assert — no command, and the SAME muted class as every other unknown rather than the red one a
    // reader has learned means "act on this". The clause keeps all three meanings the wording agreed:
    // refused, cause unattributed, and no instruction to sign in.
    should(painted).not.containEql('fy fleet login');
    should(painted).not.containEql('<danger>');
    should(painted).containEql('<muted>?</muted> Claude (default)  <muted>UNKNOWN</muted>');
    should(painted).containEql('the check was refused — possibly this client, not the login');
    // And no fourth clause: "it could not tell what was refused" IS the inconclusive result.
    should(painted).not.containEql('inconclusive');
  });

  it('should call a renewable token signed in, because that is what it is', () => {
    // Arrange / Act — the old wording, "expired, but renewable — not signed out", led with a problem
    // and then took it back. The login is fine; the access token merely aged out with a refresh token
    // sitting beside it.
    const rendered = renderHealth(
      { at: NOW, accounts: [healthRow({ verdict: 'unknown', reason: 'oauth_refreshable' })] },
      names,
      WIDE,
    );

    // Assert
    should(rendered).containEql('UNKNOWN  signed in, but this copy needs refreshing');
  });

  it('should print the renewal command beside a refreshable account, with its id', () => {
    // Arrange — THE REPORTED INCIDENT. This row used to assert `not.containEql('fy fleet login')`,
    // because the remedy table was keyed on the VERDICT and `oauth_refreshable`'s verdict is
    // `unknown`. So the row said "signed in, but this copy needs refreshing" and stopped, while
    // `fy fleet login <accountId>` renewed exactly that account the whole time — it renews before
    // anything else, and a renewal that succeeds settles the pass with no browser at all. The row
    // prints the NAME, so the id the command needs was not on screen either.
    const accountId = '34ffb79f-786c-4179-a8aa-f2180a76252a';
    const accounts = [healthRow({ accountId, verdict: 'unknown', reason: 'oauth_refreshable' })];

    // Act
    const painted = renderHealth({ at: NOW, accounts }, new Map([[accountId, 'Claude (default)']]), labelled());

    // Assert — the whole id, in the copy-paste class, on a row that stays muted: a credential that
    // can renew itself is not a fault, and painting it as one is what the muting exists to prevent.
    should(painted).containEql(`<command>fy fleet login ${accountId}</command>`);
    should(painted).containEql('<muted>?</muted> Claude (default)  <muted>UNKNOWN</muted>');
    should(painted).not.containEql('<danger>');
  });

  it('should still say a check was inconclusive when the reason does not already say so', () => {
    // Arrange / Act — hiding a failed attempt is how a fleet reads healthy while every provider call
    // is failing, so the clause is suppressed only where it would be the same fact twice.
    const rendered = renderHealth({ at: NOW, accounts: [healthRow({ lastCheckInconclusive: true })] }, names, WIDE);

    // Assert
    should(rendered).containEql('· last check inconclusive');
  });

  it('should report what a stale verdict WAS without widening the verdict column', () => {
    // Arrange — a bare UNKNOWN reads exactly like an account nobody has ever looked at, which is the
    // opposite of what happened. It travels as a clause because in the verdict column it made one
    // row wider than every other and broke the alignment the eye runs down.
    const accounts = [
      healthRow({ accountId: 'y', verdict: 'unknown', reason: 'stale', staleVerdict: 'healthy' }),
      healthRow({ accountId: 'h' }),
    ];

    // Act
    const rendered = renderHealth({ at: NOW, accounts }, new Map(), PLAIN_FLEET_PRESENTATION);

    // Assert
    should(rendered).containEql('? y  UNKNOWN  the last result is too old to trust · was HEALTHY');
    should(rendered).containEql('✓ h  HEALTHY  the provider accepted this credential');
  });

  /**
   * THE DISCLOSURE, and the sentence the honesty constraint lives in.
   *
   * The Claude case asserts BOTH halves: that the conditional is present and that the flat claim is
   * absent. Asserting only the first would pass over a sentence that said "if Claude rotates refresh
   * tokens, renewing it signs that install out" — conditional in form and an assertion in substance.
   */
  /**
   * The report as ONE line, so an assertion about WHAT was said is not also an assertion about
   * where the terminal happened to break it. Where it breaks has its own test below.
   */
  const unwrapped = (rendered: string): string => rendered.replace(/\s+/g, ' ');

  const seedRow = (patch: Record<string, unknown> = {}, row: Record<string, unknown> = {}) =>
    healthRow({
      accountId: 'seeded',
      seedProvenance: {
        state: 'seeded_copy',
        donorHome: '/home/me/.claude',
        seededAt: Date.UTC(2026, 7, 12, 9, 30),
        rotation: 'unproven',
        ...patch,
      },
      ...row,
    } as Partial<FleetAccountHealth>);

  it('should say a credential is still the copy taken from this host, and when', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [seedRow()] }, names, WIDE);

    // Assert — the directory is the only thing a person can go and check, and the date is absolute
    // because a seed may be months old and "94d ago" is not something anybody can match to a memory.
    should(unwrapped(rendered)).containEql(
      "seeded copy: this credential is still the copy taken from this host's own Claude install (/home/me/.claude) on 12 Aug 2026.",
    );
  });

  it('should keep the Claude consequence CONDITIONAL, because nothing here proves Claude rotates', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [seedRow()] }, names, WIDE);

    // Assert — the evidence for Claude is that a REPLACEMENT refresh token is stored, which is not
    // the same claim as the old one being invalidated. Nobody has measured that.
    should(unwrapped(rendered)).containEql(
      'If Claude rotates refresh tokens, renewing it — or running an agent on it — may sign that install out.',
    );
    // And the flat claim is NOT made. This half is what a copy-editing pass would delete.
    should(rendered).not.containEql('signs that install out');
    should(rendered).not.containEql('will sign that install out');
  });

  it('should say the Codex consequence flatly, because single-use rotation is established there', () => {
    // Act
    const rendered = renderHealth(
      {
        at: NOW,
        accounts: [seedRow({ donorHome: '/home/me/.codex', rotation: 'single_use' }, { kind: 'codex' })],
      },
      names,
      WIDE,
    );

    // Assert
    should(unwrapped(rendered)).containEql(
      'Codex refresh tokens are single-use, so renewing it — or running an agent on it — signs that install out.',
    );
    should(rendered).not.containEql('If Codex rotates');
  });

  it('should hedge the whole sentence when this home credential could not be read', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [seedRow({ state: 'undetermined' })] }, names, WIDE);

    // Assert — fail-closed, and SAID to be fail-closed. A locked keychain reads as "may belong to the
    // donor", and pretending that was a measurement would be the same overstatement in a new place.
    should(rendered).containEql('seeded copy, unconfirmed:');
    should(unwrapped(rendered)).containEql('so this cannot tell whether it is still the copy');
    should(rendered).containEql('it is reported as if it were.');
  });

  it('should say a home that has since rotated is its own, with no consequence attached', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [seedRow({ state: 'own_login' })] }, names, WIDE);

    // Assert — the risk has passed, so no sentence about signing anybody out is printed at all. This
    // line is also what turns a SILENT row into information: silence means nothing was recorded.
    should(unwrapped(rendered)).containEql(
      "own login: seeded from this host's own Claude install (/home/me/.claude) on 12 Aug 2026, and replaced since.",
    );
    should(rendered).not.containEql('sign that install out');
  });

  it('should say nothing at all about an account with no seed record', () => {
    // Act
    const rendered = renderHealth({ at: NOW, accounts: [healthRow()] }, names, WIDE);

    // Assert — absence of a record is NOT evidence of an own login, so the row makes no claim either
    // way. Rendering it as "own login" would clear exactly the hosts this cannot say anything about.
    should(rendered).not.containEql('seeded copy');
    should(rendered).not.containEql('own login');
  });

  it('should print the disclosure above the command it changes the meaning of', () => {
    // Arrange — an account a login repairs, whose credential is still the donor's copy.
    const rendered = renderHealth(
      { at: NOW, accounts: [seedRow({}, { verdict: 'unknown', reason: 'oauth_refreshable' })] },
      names,
      WIDE,
    ).split('\n');

    // Assert — somebody about to run a renewal has to have read this first, so it cannot sit below.
    const disclosure = rendered.findIndex(line => line.includes('seeded copy:'));
    const remedy = rendered.findIndex(line => line.includes('fy fleet login seeded'));
    should(disclosure).be.greaterThan(-1);
    should(remedy).be.greaterThan(disclosure);
  });

  it('should print the raw harness when the daemon named one this build does not know', () => {
    // Assert — `kind` is an open string on the wire so a third harness stays conformant. A closed
    // lookup would print `undefined` in the middle of a sentence about somebody's credential.
    const rendered = renderHealth({ at: NOW, accounts: [seedRow({}, { kind: 'gemini' })] }, names, WIDE);
    should(unwrapped(rendered)).containEql("this host's own gemini install");
  });

  it('should wrap the disclosure under the account rather than against the left margin', () => {
    // Arrange — an 80-column terminal, which is what a pipe and a default window both give.
    const lines = renderHealth({ at: NOW, accounts: [seedRow()] }, names, plainAt(80)).split('\n');

    // Assert — every line of it is indented, so a wrapped clause never reads as the next account.
    const disclosure = lines.filter(line => line.trim().startsWith('seeded copy:') || line.includes('rotates refresh'));
    should(disclosure.length).be.greaterThan(1);
    for (const line of disclosure) should(line.startsWith('    ')).be.true();
  });

  it('should fall back to the id when the manifest cannot name the account', () => {
    // Arrange — a stored head can outlive the account it is about: the manifest moved, or somebody
    // removed the account. A verdict about something the manifest cannot name is STILL a true verdict,
    // so the row is printed with the id rather than hidden or given an invented name.
    const rendered = renderHealth(
      { at: NOW, accounts: [healthRow({ accountId: 'departed' })] },
      names,
      PLAIN_FLEET_PRESENTATION,
    );

    // Assert
    should(rendered).containEql('✓ departed  HEALTHY');
  });

  it('should stop one very long name from widening the column for everybody', () => {
    // Arrange — padding every row out to the longest name would spend most of a terminal on
    // whitespace. The long name overflows its own row instead, and is never truncated: it is the
    // only thing on the row that says WHICH account this is.
    const long = 'Claude (an extravagantly over-described account)';
    const accounts = [healthRow({ accountId: 'long' }), healthRow({ accountId: 'h' })];

    // Act
    const rendered = renderHealth(
      { at: NOW, accounts },
      new Map([
        ['long', long],
        ['h', 'Claude (research)'],
      ]),
      plainAt(120),
    );

    // Assert
    should(rendered).containEql(`✓ ${long}  HEALTHY`);
    should(rendered).containEql('✓ Claude (research)                 HEALTHY');
  });

  it('should offer a CREDENTIAL, not a login, for an account no login can fix', () => {
    // Arrange / Act — the harness reads an environment variable and never consults its own credential
    // store, so telling somebody to sign in sends them to do something that cannot work.
    const rendered = renderHealth(
      { at: NOW, accounts: [healthRow({ verdict: 'needs_credentials', reason: 'static_credential_rejected' })] },
      names,
      PLAIN_FLEET_PRESENTATION,
    );

    // Assert
    should(rendered).containEql('NEEDS CREDENTIAL');
    should(rendered).not.containEql('NEEDS LOGIN');
  });

  it('should call a 403 healthy and say the quota is what is unknown', () => {
    // Arrange / Act — the rule the whole feature turns on.
    const rendered = renderHealth(
      { at: NOW, accounts: [healthRow({ reason: 'usage_scope_unavailable' })] },
      names,
      WIDE,
    );

    // Assert
    should(rendered).containEql('HEALTHY');
    should(rendered).containEql('quota is unknown');
    should(rendered).not.containEql('NEEDS LOGIN');
  });

  it('should say a check has never run rather than inventing an instant', () => {
    // Arrange / Act
    const rendered = renderHealth(
      {
        at: NOW,
        accounts: [healthRow({ verdict: 'unknown', reason: 'never_checked', lastCheckedAt: null, verdictAt: null })],
      },
      names,
      PLAIN_FLEET_PRESENTATION,
    );

    // Assert — a fabricated "now" here would be indistinguishable from a check that just succeeded,
    // and the inconclusive clause is suppressed because "no check has run" already said it.
    should(rendered.split('\n')[0]).equal('1 account · 1 unknown · never checked');
    should(rendered).containEql('UNKNOWN  no check has run for this account');
  });

  it('should state that it spends nothing, every time, as an aside rather than as a heading', () => {
    // The command this replaced launched every account's wrapper and asked a model for a sentinel.
    // Somebody who used it before has every reason to assume this one still bills them.
    const rendered = renderHealth({ at: NOW, accounts: [healthRow()] }, names, labelled());

    // Assert
    should(rendered).containEql(
      '<muted>Reads credentials and one free status endpoint — no model, no inference quota.',
    );
  });

  it('should explain an empty health snapshot without pretending a check ran', () => {
    should(renderHealth({ at: NOW, accounts: [] }, names, PLAIN_FLEET_PRESENTATION)).equal(
      'No accounts to report health for.',
    );
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

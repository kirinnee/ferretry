import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderAccount,
  renderApplyPlan,
  renderApplyResult,
  renderLoginResults,
  renderLoginRow,
  renderManifest,
  renderRecommendation,
  renderScaffoldResult,
  renderUsage,
  renderUsageRow,
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

describe('apply plan rendering', () => {
  it('should say plainly that nothing has been written', () => {
    // Act
    const rendered = renderApplyPlan(plan());

    // Assert
    should(rendered.split('\n')[0]).equal('1 account, 2 operations — nothing has been written');
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
      { accountId: 'a', status: 'logged-in' },
      { accountId: 'b', status: 'not-required' },
      { accountId: 'c', status: 'unavailable', message: 'pool down' },
      { accountId: 'd', status: 'failed', message: 'login process exited with code 7' },
    ]);

    // Assert
    should(actual).containEql('4 accounts, 1 failed');
    should(actual).containEql('a  logged in');
    should(actual).containEql('b  no login needed');
    should(actual).containEql('c  skipped, the manifest declares it unavailable — pool down');
    should(actual).containEql('d  FAILED — login process exited with code 7');
  });

  it('should count no failures when every account succeeded', () => {
    // Act
    const actual = renderLoginResults([{ accountId: 'a', status: 'logged-in' }]);

    // Assert
    should(actual).startWith('1 account\n');
  });

  it('should render an unavailable account with no stated reason', () => {
    // Act
    const actual = renderLoginRow({ accountId: 'a', status: 'unavailable' });

    // Assert
    should(actual).equal('  a  skipped, the manifest declares it unavailable');
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

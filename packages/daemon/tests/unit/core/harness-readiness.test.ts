import { describe, it } from 'bun:test';
import should from 'should';
import {
  accountLaunchability,
  type ExecutableResolverPort,
  harnessAbsentWarning,
  harnessPreflightSummary,
  readHarnessPreflight,
  renderHarnessPreflight,
} from '../../../src/lib/core/harness-readiness.ts';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';

/** One published account, as the fleet manifest declares it. */
function account(patch: Partial<CoreAccount> = {}): CoreAccount {
  return {
    id: 'account-1',
    agent: 'claude-auto-one',
    kind: 'claude',
    mode: 'auto',
    displayName: 'Claude auto one',
    defaultModel: null,
    models: [],
    available: true,
    ...patch,
  };
}

/** A host that can run exactly the named wrappers and nothing else. */
function hostWith(...installed: readonly string[]): ExecutableResolverPort {
  return { resolve: name => (installed.includes(name) ? `/usr/local/bin/${name}` : undefined) };
}

describe('harness readiness', () => {
  it('should call an account launchable only when the fleet declares it and the host can run it', () => {
    // Act
    const usable = accountLaunchability(account(), hostWith('claude-auto-one'));

    // Assert — the same two conditions a start resolves an account from, which is the point: written
    // twice they would drift, and the drift is a preflight promising a start that then refuses.
    should(usable).deepEqual({ kind: 'launchable', executable: '/usr/local/bin/claude-auto-one' });
  });

  it('should separate a fleet that declared an account down from a host that cannot run it', () => {
    // Act
    const declaredDown = accountLaunchability(
      account({ available: false, unavailableReason: 'quota exhausted until tomorrow' }),
      hostWith('claude-auto-one'),
    );
    const notInstalled = accountLaunchability(account(), hostWith());
    const noStatedReason = accountLaunchability(account({ available: false }), hostWith('claude-auto-one'));

    // Assert — two different things for a human to do, so they are two different answers.
    should(declaredDown.kind).equal('declared-unavailable');
    should(declaredDown)
      .have.property('reason')
      .match(/quota exhausted until tomorrow/u);
    should(notInstalled.kind).equal('absent-executable');
    should(notInstalled)
      .have.property('reason')
      .match(/no such executable on its PATH/u);
    // A manifest that reports an account down without saying why still produces a usable sentence.
    should(noStatedReason)
      .have.property('reason')
      .match(/the manifest reports it unavailable/u);
  });

  it('should report every harness, including one with nothing published at all', () => {
    // Act
    const preflight = readHarnessPreflight([account()], hostWith('claude-auto-one'));

    // Assert — a report that listed only what it found could not answer "is Codex set up?", which is
    // the question being asked.
    should(preflight.harnesses.map(harness => harness.kind)).deepEqual(['claude', 'codex']);
    should(preflight.ready).be.true();
    should(preflight.harnesses[0]?.launchable).deepEqual(['claude-auto-one']);
    should(preflight.harnesses[1]?.launchable).be.empty();
    should(preflight.harnesses[1]?.blocked).be.empty();
  });

  it('should treat at least one launchable account of any harness as ready', () => {
    // Arrange: Claude published but not installed, Codex installed. One is the bar.
    const accounts = [account(), account({ id: 'account-2', agent: 'codex-auto-one', kind: 'codex' })];

    // Act
    const preflight = readHarnessPreflight(accounts, hostWith('codex-auto-one'));

    // Assert
    should(preflight.ready).be.true();
    should(preflight.harnesses[0]?.blocked).have.length(1);
    should(preflight.harnesses[1]?.launchable).deepEqual(['codex-auto-one']);
    should(harnessPreflightSummary(preflight)).equal('claude: none (1 published but unusable); codex: codex-auto-one');
  });

  it('should be unready when every published account is one this host cannot launch', () => {
    // Arrange
    const accounts = [account(), account({ id: 'account-2', agent: 'codex-auto-one', kind: 'codex' })];

    // Act
    const nothingInstalled = readHarnessPreflight(accounts, hostWith());
    const nothingPublished = readHarnessPreflight([], hostWith('claude-auto-one'));

    // Assert — a daemon that is healthy by every internal measure and cannot launch anything is the
    // failure this check exists for, so both shapes of it count as unready.
    should(nothingInstalled.ready).be.false();
    should(nothingPublished.ready).be.false();
    should(harnessPreflightSummary(nothingPublished)).equal('claude: none; codex: none');
  });

  it('should name a remedy rather than only a diagnosis, and distinguish the two causes', () => {
    // Act
    const nonePublished = harnessAbsentWarning(readHarnessPreflight([], hostWith()), 'fy');
    const noneUsable = harnessAbsentWarning(readHarnessPreflight([account()], hostWith()), 'fy');

    // Assert
    should(nonePublished).match(/publishes no agent account at all/u);
    should(noneUsable).match(/every published account is unusable/u);
    should(noneUsable).match(/no such executable on its PATH/u);
    for (const warning of [nonePublished, noneUsable]) {
      // A diagnosis on its own leaves the reader exactly where they were.
      should(warning).match(/fy fleet apply/u);
      should(warning).match(/Install Claude Code or Codex/u);
      // It must never read as a refusal: the daemon starts anyway.
      should(warning).match(/can serve its API but cannot start a session/u);
    }
  });

  it('should state the limit of what it verified every single time', () => {
    // Act
    const ready = renderHarnessPreflight(readHarnessPreflight([account()], hostWith('claude-auto-one')), 'fy');
    const unready = renderHarnessPreflight(readHarnessPreflight([], hostWith()), 'fy');

    // Assert — found-on-PATH is not authenticated-and-working, and a reader who takes "ready" for the
    // stronger thing has been misled by a report that was accurate. So the limit is printed even when
    // everything is fine, which is exactly when it is easiest to forget.
    should(ready.join('\n')).match(/not that they are signed in/u);
    should(ready.join('\n')).match(/harness {6}claude {2}ready — claude-auto-one/u);
    should(ready.join('\n')).match(/harness {6}codex {3}no account published/u);
    should(unready.join('\n')).match(/^! no agent harness is ready/mu);
  });
});

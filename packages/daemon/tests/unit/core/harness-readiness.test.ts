import { describe, it } from 'bun:test';
import { basename } from 'node:path';
import should from 'should';
import {
  accountLaunchability,
  type ExecutableResolverPort,
  harnessAbsentWarning,
  harnessPreflightSummary,
  readHarnessPreflight,
  renderHarnessPreflight,
  unreadableManifestPreflight,
} from '../../../src/lib/core/harness-readiness.ts';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';

/** One published account, as the fleet manifest declares it. */
function account(patch: Partial<CoreAccount> = {}): CoreAccount {
  const agent = patch.agent ?? 'claude-auto-one';
  return {
    id: 'account-1',
    agent,
    // The manifest publishes the ABSOLUTE path; the daemon derives the name from it.
    wrapper: `/state/fleet/bin/${agent}`,
    home: `/state/fleet/homes/${agent}`,
    kind: 'claude',
    mode: 'auto',
    displayName: 'Claude auto one',
    defaultModel: null,
    models: [],
    available: true,
    unavailableReason: null,
    ...patch,
  };
}

/**
 * A host that can run exactly the named programs and nothing else.
 *
 * The two halves answer differently on purpose: a wrapper is asked about BY PATH, because that is
 * what the manifest publishes and what a service-managed daemon can actually resolve, while a
 * harness command is asked about by name against `PATH`.
 */
function hostWith(...installed: readonly string[]): ExecutableResolverPort {
  return {
    resolve: name => (installed.includes(name) ? `/usr/local/bin/${name}` : undefined),
    runnable: path => installed.includes(basename(path)),
  };
}

describe('harness readiness', () => {
  it('should call an account launchable only when the fleet declares it and the host can run it', () => {
    // Act
    const usable = accountLaunchability(account(), hostWith('claude-auto-one'));

    // Assert — the same two conditions a start resolves an account from, which is the point: written
    // twice they would drift, and the drift is a preflight promising a start that then refuses.
    should(usable).deepEqual({ kind: 'launchable', executable: '/state/fleet/bin/claude-auto-one' });
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
      .match(/but this host cannot run that file/u);
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
    should(noneUsable).match(/but this host cannot run that file/u);
    for (const warning of [nonePublished, noneUsable]) {
      // A diagnosis on its own leaves the reader exactly where they were.
      should(warning).match(/fy fleet apply/u);
      should(warning).match(/Install Claude Code or Codex/u);
      // It must never read as a refusal: the daemon starts anyway.
      should(warning).match(/can serve its API but cannot start a session/u);
    }
  });

  it('should name the missing step when the harness is installed but no account is published', () => {
    // Arrange: somebody has just installed Claude Code. Told "no harness is ready", they would be
    // right to object — and the report would look wrong while being technically accurate.
    const justInstalled = readHarnessPreflight([], hostWith('claude'));

    // Act
    const warning = harnessAbsentWarning(justInstalled, 'fy');
    const rendered = renderHarnessPreflight(justInstalled, 'fy').join('\n');

    // Assert — this daemon launches the wrappers the manifest publishes, never the harness command,
    // so the actionable fact is the account, not the install.
    should(justInstalled.harnesses[0]?.commandOnPath).be.true();
    should(justInstalled.harnesses[1]?.commandOnPath).be.false();
    should(justInstalled.ready).be.false();
    should(warning).match(/claude is on this host's PATH/u);
    // Singular, because only one is installed: a sentence that says "either" of one thing reads as a
    // template nobody proofread, and this message is the one a confused person is relying on.
    should(warning).match(/publishes no account for it —/u);
    should(harnessAbsentWarning(readHarnessPreflight([], hostWith('claude', 'codex')), 'fy')).match(
      /claude and codex are on this host's PATH.*for either/u,
    );
    should(rendered).match(/the claude command is on PATH, but this daemon launches published wrappers/u);
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
    should(ready.join('\n')).match(/harness {6}codex {3}no account published, and the command is not on PATH/u);
    should(unready.join('\n')).match(/^! no agent harness is ready/mu);
  });
});

describe('a manifest the daemon could not read', () => {
  const refusal = 'the fleet manifest at /state/fleet/manifest.json is present but cannot be read: bad shape.';

  it('should claim nothing about any account', () => {
    // Act
    const preflight = unreadableManifestPreflight(refusal, hostWith('claude'));

    // Assert — `blocked` means "this published account cannot be launched, and here is why", and
    // there is no honest way to say that about accounts whose file would not parse.
    should(preflight.ready).be.false();
    should(preflight.manifestRefusal).equal(refusal);
    should(preflight.harnesses.map(harness => harness.blocked)).deepEqual([[], []]);
    should(preflight.harnesses.map(harness => harness.launchable)).deepEqual([[], []]);
    // The harness command is still a fact the manifest has no bearing on.
    should(preflight.harnesses[0]?.commandOnPath).be.true();
    should(preflight.harnesses[1]?.commandOnPath).be.false();
  });

  it('should say it does not know, rather than that nothing is published', () => {
    // Arrange
    const preflight = unreadableManifestPreflight(refusal, hostWith());

    // Act
    const summary = harnessPreflightSummary(preflight);
    const warning = harnessAbsentWarning(preflight, 'fy');
    const rendered = renderHarnessPreflight(preflight, 'fy').join('\n');

    // Assert — "no account is published" is a claim about a file this daemon read. This is the
    // admission that it has no idea what is published, and reporting the second as the first is the
    // exact defect: a daemon told an operator their fleet published nothing while the CLI listed one.
    should(summary).equal('unknown — the fleet manifest could not be read');
    should(warning).containEql(refusal);
    should(warning).not.match(/publishes no agent account at all/u);
    should(rendered).match(/harness {6}claude {2}unknown — the fleet manifest could not be read/u);
    should(rendered).match(/^! no agent harness can be resolved/mu);
  });
});

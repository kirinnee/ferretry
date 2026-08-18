import { describe, it } from 'bun:test';
import { basename } from 'node:path';
import should from 'should';
import {
  accountLaunchability,
  type EnvironmentReader,
  type ExecutableResolverPort,
  HarnessDiscoveryDocumentSchema,
  harnessAbsentWarning,
  harnessDiscoveryPolicy,
  harnessLocationSummary,
  harnessOverrideFailures,
  harnessPreflightSummary,
  NO_HARNESS_DECLARATIONS,
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

/**
 * A host whose two halves are set INDEPENDENTLY, which is the whole subject of the tests below.
 *
 * `inherited` is what a `PATH` lookup would find — the half a daemon started by a service manager
 * loses. `files` is what actually exists on disk, which is what an operator's declared path or search
 * directory is answered from. A helper that derived one from the other could not express the state
 * this feature exists for: `claude` is installed, and this daemon cannot see it.
 */
function machine(input: { readonly inherited?: readonly string[]; readonly files?: readonly string[] }) {
  const resolver: ExecutableResolverPort = {
    resolve: name => (input.inherited?.includes(name) === true ? `/usr/local/bin/${name}` : undefined),
    runnable: path => input.files?.includes(path) === true,
  };
  return resolver;
}

/** An environment holding exactly these variables and nothing else. */
function environmentOf(variables: Readonly<Record<string, string>>): EnvironmentReader {
  return name => variables[name];
}

/** The declarations an operator's document plus environment produce, parsed exactly as a boot does. */
function policyOf(input: {
  readonly document?: unknown;
  readonly variables?: Readonly<Record<string, string>>;
  readonly home?: string;
}) {
  return harnessDiscoveryPolicy({
    document: HarnessDiscoveryDocumentSchema.parse(input.document ?? {}),
    environment: environmentOf(input.variables ?? {}),
    homeDirectory: input.home ?? '/home/op',
  });
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
    const preflight = readHarnessPreflight([account()], hostWith('claude-auto-one'), NO_HARNESS_DECLARATIONS);

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
    const preflight = readHarnessPreflight(accounts, hostWith('codex-auto-one'), NO_HARNESS_DECLARATIONS);

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
    const nothingInstalled = readHarnessPreflight(accounts, hostWith(), NO_HARNESS_DECLARATIONS);
    const nothingPublished = readHarnessPreflight([], hostWith('claude-auto-one'), NO_HARNESS_DECLARATIONS);

    // Assert — a daemon that is healthy by every internal measure and cannot launch anything is the
    // failure this check exists for, so both shapes of it count as unready.
    should(nothingInstalled.ready).be.false();
    should(nothingPublished.ready).be.false();
    should(harnessPreflightSummary(nothingPublished)).equal('claude: none; codex: none');
  });

  it('should name a remedy rather than only a diagnosis, and distinguish the two causes', () => {
    // Act
    const nonePublished = harnessAbsentWarning(readHarnessPreflight([], hostWith(), NO_HARNESS_DECLARATIONS), 'fy');
    const noneUsable = harnessAbsentWarning(
      readHarnessPreflight([account()], hostWith(), NO_HARNESS_DECLARATIONS),
      'fy',
    );

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
    const justInstalled = readHarnessPreflight([], hostWith('claude'), NO_HARNESS_DECLARATIONS);

    // Act
    const warning = harnessAbsentWarning(justInstalled, 'fy');
    const rendered = renderHarnessPreflight(justInstalled, 'fy').join('\n');

    // Assert — this daemon launches the wrappers the manifest publishes, never the harness command,
    // so the actionable fact is the account, not the install.
    should(justInstalled.harnesses[0]?.command.outcome).equal('located');
    should(justInstalled.harnesses[1]?.command.outcome).equal('absent');
    should(justInstalled.ready).be.false();
    should(warning).match(/claude is on this host's PATH/u);
    // Singular, because only one is installed: a sentence that says "either" of one thing reads as a
    // template nobody proofread, and this message is the one a confused person is relying on.
    should(warning).match(/publishes no account for it —/u);
    should(
      harnessAbsentWarning(readHarnessPreflight([], hostWith('claude', 'codex'), NO_HARNESS_DECLARATIONS), 'fy'),
    ).match(/claude and codex are on this host's PATH.*for either/u);
    should(rendered).match(/the claude command resolves, but this daemon launches published wrappers/u);
  });

  it('should state the limit of what it verified every single time', () => {
    // Act
    const ready = renderHarnessPreflight(
      readHarnessPreflight([account()], hostWith('claude-auto-one'), NO_HARNESS_DECLARATIONS),
      'fy',
    );
    const unready = renderHarnessPreflight(readHarnessPreflight([], hostWith(), NO_HARNESS_DECLARATIONS), 'fy');

    // Assert — found-on-PATH is not authenticated-and-working, and a reader who takes "ready" for the
    // stronger thing has been misled by a report that was accurate. So the limit is printed even when
    // everything is fine, which is exactly when it is easiest to forget.
    should(ready.join('\n')).match(/not that they are signed in/u);
    should(ready.join('\n')).match(/harness {6}claude {2}ready — claude-auto-one/u);
    should(ready.join('\n')).match(/harness {6}codex {3}no account published, and the command could not be resolved/u);
    should(unready.join('\n')).match(/^! no agent harness is ready/mu);
  });
});

describe('a manifest the daemon could not read', () => {
  const refusal = 'the fleet manifest at /state/fleet/manifest.json is present but cannot be read: bad shape.';

  it('should claim nothing about any account', () => {
    // Act
    const preflight = unreadableManifestPreflight(refusal, hostWith('claude'), NO_HARNESS_DECLARATIONS);

    // Assert — `blocked` means "this published account cannot be launched, and here is why", and
    // there is no honest way to say that about accounts whose file would not parse.
    should(preflight.ready).be.false();
    should(preflight.manifestRefusal).equal(refusal);
    should(preflight.harnesses.map(harness => harness.blocked)).deepEqual([[], []]);
    should(preflight.harnesses.map(harness => harness.launchable)).deepEqual([[], []]);
    // The harness command is still a fact the manifest has no bearing on.
    should(preflight.harnesses[0]?.command.outcome).equal('located');
    should(preflight.harnesses[1]?.command.outcome).equal('absent');
  });

  it('should say it does not know, rather than that nothing is published', () => {
    // Arrange
    const preflight = unreadableManifestPreflight(refusal, hostWith(), NO_HARNESS_DECLARATIONS);

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

/**
 * WHERE A HARNESS IS, and which rule said so.
 *
 * The case every test here is built around: a daemon started by systemd or launchd at login inherits
 * a minimal environment rather than the operator's interactive shell, so `claude` works perfectly in
 * their terminal and is invisible to their daemon. Every assertion is about what an operator can say
 * to fix that, and about being told what was done with what they said.
 */
describe('where a harness command is', () => {
  it('should prefer an explicit override to a harness the inherited environment could resolve', () => {
    // Arrange: BOTH would answer. `claude` is on the inherited PATH, and the operator has also named
    // an exact file — a version manager's shim and the copy they actually want, which is the whole
    // reason naming one exists.
    const host = machine({ inherited: ['claude'], files: ['/opt/harnesses/claude'] });
    const policy = policyOf({ document: { paths: { claude: '/opt/harnesses/claude' } } });

    // Act
    const preflight = readHarnessPreflight([], host, policy);

    // Assert — the named file wins, and the report says which rule chose it rather than leaving the
    // operator to guess whether their line was read at all.
    should(preflight.harnesses[0]?.command).deepEqual({
      kind: 'claude',
      outcome: 'located',
      path: '/opt/harnesses/claude',
      rule: 'explicit override',
      declaredBy: 'harness.paths.claude',
    });
  });

  it('should refuse loudly rather than fall back when an override names nothing this host can run', () => {
    // Arrange: the operator named a path that is wrong, and a perfectly good `claude` is on the
    // inherited PATH. A search would find it and report success.
    const host = machine({ inherited: ['claude'], files: ['/usr/local/bin/claude'] });
    const policy = policyOf({ document: { paths: { claude: '/opt/typo/claude' } } });

    // Act
    const preflight = readHarnessPreflight([], host, policy);
    const failures = harnessOverrideFailures(preflight);
    const rendered = renderHarnessPreflight(preflight, 'fy').join('\n');

    // Assert — a silent fallback means they think they configured something they did not, so the
    // fallback does not happen and the failure names the key to correct.
    should(preflight.harnesses[0]?.command).have.property('outcome', 'override-absent');
    should(preflight.harnesses[0]?.command).have.property('path', '/opt/typo/claude');
    should(failures).have.length(1);
    should(failures[0]).match(/harness\.paths\.claude names \/opt\/typo\/claude for claude/u);
    should(failures[0]).match(/nothing else was searched/u);
    // And what it costs, in the same breath: a diagnosis with no consequence is half an answer.
    should(failures[0]).match(/no claude session can start on this host/u);
    should(rendered).match(/command {6}claude {2}not usable/u);
  });

  it('should search a declared directory when the inherited environment has no harness at all', () => {
    // Arrange: THE REASON THIS EXISTS. A service-managed daemon inherits nothing useful, so the
    // lookup finds nothing while the harness sits in a directory the login shell would have added.
    const host = machine({ files: ['/opt/homebrew/bin/claude'] });
    const policy = policyOf({ document: { searchPaths: ['/nowhere', '/opt/homebrew/bin'] } });

    // Act
    const preflight = readHarnessPreflight([], host, policy);

    // Assert — found, at the absolute path a wrapper would run, with the rule that found it. The
    // earlier directory is simply skipped rather than being an error.
    should(preflight.harnesses[0]?.command).deepEqual({
      kind: 'claude',
      outcome: 'located',
      path: '/opt/homebrew/bin/claude',
      rule: 'extra search path',
      declaredBy: 'harness.searchPaths',
    });
    // One line covers every harness, including one installed after it was written.
    should(preflight.harnesses[1]?.command).have.property('outcome', 'absent');
  });

  it('should report the rule that produced each path, never the path alone', () => {
    // Arrange: one harness from a declared directory, one from the inherited environment.
    const host = machine({ inherited: ['codex'], files: ['/opt/bin/claude'] });
    const policy = policyOf({ document: { searchPaths: ['/opt/bin'] } });

    // Act
    const summary = harnessLocationSummary(readHarnessPreflight([], host, policy));

    // Assert — two hosts resolving a harness to the same file for different reasons are not in the
    // same state, and only one of them survives the next login.
    should(summary).equal(
      'claude: /opt/bin/claude  (extra search path — harness.searchPaths); ' +
        'codex: /usr/local/bin/codex  (inherited environment — PATH)',
    );
  });

  it('should let a unit file outrank the document, and say which surface won', () => {
    // Arrange: the operator is repairing a service-managed daemon by editing its unit file, and the
    // document names an older path. A document that quietly outranked the variable would make that
    // edit look ignored, which is the silent-configuration failure this whole block exists to end.
    const host = machine({ files: ['/opt/new/claude', '/opt/old/claude'] });
    const policy = policyOf({
      document: { paths: { claude: '/opt/old/claude' } },
      variables: { FY_CLAUDE_BIN: '/opt/new/claude' },
    });

    // Act
    const located = readHarnessPreflight([], host, policy).harnesses[0]?.command;

    // Assert
    should(located).have.property('path', '/opt/new/claude');
    should(located).have.property('declaredBy', 'FY_CLAUDE_BIN');
  });

  it('should add the directories a unit file names, ahead of the document it cannot edit', () => {
    // Arrange: the environment-only surface, which is the case a unit file can actually reach.
    const host = machine({ files: ['/srv/tools/codex'] });
    const policy = policyOf({ variables: { FY_HARNESS_PATH: '/srv/tools:/srv/empty' } });

    // Act
    const located = readHarnessPreflight([], host, policy).harnesses[1]?.command;

    // Assert
    should(located).deepEqual({
      kind: 'codex',
      outcome: 'located',
      path: '/srv/tools/codex',
      rule: 'extra search path',
      declaredBy: 'FY_HARNESS_PATH',
    });
  });

  it('should read a declared path the way the operator typed it, home and all', () => {
    // Arrange: somebody writes the path they use in a terminal.
    const host = machine({ files: ['/home/op/.local/bin/claude'] });
    const policy = policyOf({ document: { paths: { claude: '~/.local/bin/claude' } }, home: '/home/op' });

    // Act
    const located = readHarnessPreflight([], host, policy).harnesses[0]?.command;

    // Assert — the wrapper that would run it needs an absolute path, so `~` is resolved when the
    // declaration is read rather than left for something further down to guess at.
    should(located).have.property('path', '/home/op/.local/bin/claude');
  });

  it('should refuse a relative declaration in the document rather than searching from nowhere', () => {
    // Act
    const relativePath = HarnessDiscoveryDocumentSchema.safeParse({ paths: { claude: 'bin/claude' } });
    const relativeDirectory = HarnessDiscoveryDocumentSchema.safeParse({ searchPaths: ['./tools'] });

    // Assert — this daemon's working directory is whatever a service manager handed it, so a relative
    // path names a different file depending on where the unit happened to start.
    should(relativePath.success).be.false();
    should(relativeDirectory.success).be.false();
    should(HarnessDiscoveryDocumentSchema.parse({})).deepEqual({ paths: {}, searchPaths: [] });
  });

  it('should treat a blank variable as having said nothing', () => {
    // Arrange: a unit file that exports `FY_CLAUDE_BIN=` has declared no path at all.
    const host = machine({ inherited: ['claude'], files: ['/usr/local/bin/claude'] });
    const policy = policyOf({ variables: { FY_CLAUDE_BIN: '   ', FY_HARNESS_PATH: ' : ' } });

    // Assert — an empty string treated as an override would fail the boot's report with a path that
    // is not a path, and hide a harness that is present.
    should(policy).deepEqual(NO_HARNESS_DECLARATIONS);
    should(readHarnessPreflight([], host, policy).harnesses[0]?.command).have.property('rule', 'inherited environment');
  });

  it('should name every directory it searched when it found nothing', () => {
    // Arrange
    const policy = policyOf({
      document: { searchPaths: ['/opt/bin'] },
      variables: { FY_HARNESS_PATH: '/srv/tools' },
    });

    // Act
    const preflight = readHarnessPreflight([], machine({}), policy);
    const rendered = renderHarnessPreflight(preflight, 'fy').join('\n');

    // Assert — the environment's directories are searched first, and both are named: an operator
    // reading a report that does not mention the line they are staring at learns nothing from it.
    should(preflight.harnesses[0]?.command).deepEqual({
      kind: 'claude',
      outcome: 'absent',
      searched: ['/srv/tools', '/opt/bin'],
    });
    should(rendered).match(
      /command {6}claude {2}not found in the inherited environment, nor in \/srv\/tools, \/opt\/bin/u,
    );
    // What the absence breaks, said where the absence is reported.
    should(rendered).match(/no claude session can start on this host/u);
  });

  it('should say so plainly when there is nothing declared and nothing installed', () => {
    // Act
    const preflight = readHarnessPreflight([], machine({}), NO_HARNESS_DECLARATIONS);

    // Assert
    should(harnessLocationSummary(preflight)).equal(
      'claude: not found in the inherited environment, and no extra search path is declared; ' +
        'codex: not found in the inherited environment, and no extra search path is declared',
    );
    should(harnessOverrideFailures(preflight)).be.empty();
  });
});

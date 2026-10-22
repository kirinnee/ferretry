import { describe, it } from 'bun:test';
import { UpdateReportSchema } from '@ferretry/protocol';
import should from 'should';
import type { IDaemonPrompt } from '../../../src/lib/daemon/ports';
import { NixProfileSwitch } from '../../../src/lib/update/profile-switch';
import { type DaemonUpdateOptions, DaemonUpdater, renderPlan } from '../../../src/lib/update/updater';
import { CapturedOutput, SteppingClock } from '../daemon/fixtures';
import {
  FakeFacts,
  FakeHost,
  FakeLatest,
  FakeLifecycle,
  FakePackages,
  FakeReports,
  FakeStandalone,
  FakeUpdateView,
  PROFILE_DAEMON,
  STORE,
  USER_HOME,
} from './fixtures';

/** A terminal that answers each question in turn, then no forever. */
class ScriptedPrompt implements IDaemonPrompt {
  readonly asked: string[] = [];

  constructor(private readonly answers: string[] = []) {}

  ask(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.answers.shift() ?? 'n');
  }
}

const DEFAULT_PATHS: Readonly<Record<string, string>> = {
  homebrew: '/opt/homebrew/bin/fyd',
  'nix-profile': `${USER_HOME}/.nix-profile/bin/fyd`,
  'nix-shell': `${STORE}/bin/fyd`,
  standalone: '/opt/fy/fyd',
};

function harness(
  kind: string,
  options: {
    running?: boolean;
    version?: string | undefined;
    midTurn?: (number | undefined)[];
    interactive?: boolean;
    answers?: string[];
    latest?: FakeLatest;
  } = {},
) {
  const daemonPath = DEFAULT_PATHS[kind] ?? '/usr/bin/fyd';
  const host = new FakeHost(daemonPath, options.version ?? '1.2.3', options.running ?? true);
  if (options.version === undefined && 'version' in options) host.versions.set(daemonPath, undefined);
  const packages = new FakePackages(host, daemonPath);
  const standalone = new FakeStandalone(host, daemonPath);
  const lifecycle = new FakeLifecycle(host, daemonPath);
  const out = new CapturedOutput();
  const prompt = new ScriptedPrompt(options.answers);
  const reports = new FakeReports();
  const view = new FakeUpdateView(options.midTurn ?? [0]);
  const clock = new SteppingClock(1_000);
  const facts = new FakeFacts(kind);
  const latest = options.latest ?? new FakeLatest();
  const interactive = () => options.interactive ?? false;
  const switcher = new NixProfileSwitch({
    facts,
    packages,
    lifecycle,
    out,
    prompt,
    interactive,
    product: 'ferretry',
    clientName: 'fy',
    daemonName: 'fyd',
    homeDirectory: USER_HOME,
  });
  const updater = new DaemonUpdater({
    facts,
    latest,
    packages,
    standalone,
    lifecycle,
    updateView: view,
    switcher,
    reports,
    out,
    prompt,
    interactive,
    clock,
    product: 'ferretry',
    clientName: 'fy',
    daemonName: 'fyd',
    healthTimeoutMs: 5_000,
    pollMs: 500,
  });
  const run = (flags: DaemonUpdateOptions = { yes: true, report: '/r.json' }) => updater.update(flags);
  const report = () => UpdateReportSchema.parse(JSON.parse(reports.written.get('/r.json') ?? 'null'));
  return { host, packages, standalone, lifecycle, out, prompt, reports, view, clock, latest, run, report };
}

const BREW_REFRESH = 'brew-refresh:kirinnee/ferretry:https://github.com/kirinnee/ferretry';
const RECOVERY =
  'To recover by hand run: brew update && brew upgrade --cask ferretry && fy daemon restart; if the tap is wedged: brew untap kirinnee/ferretry && brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry && brew reinstall --cask ferretry';

describe('DaemonUpdater — Homebrew', () => {
  it('upgrades the cask, restarts, and proves the new version serves', async () => {
    const h = harness('homebrew');
    await h.run();
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:ferretry', 'restart']);
    should(h.out.lines).containEql(
      'warn: refreshing the Homebrew tap kirinnee/ferretry so brew can see 1.3.0 (brew update)',
    );
    should(h.report()).match({ from: '1.2.3', target: '1.3.0', outcome: 'succeeded' });
    should(h.out.lines.at(-1)).equal('ok: fyd updated 1.2.3 → 1.3.0 and serving');
    should(h.out.exitCode).be.undefined();
  });

  it('keeps --json output machine-readable by not printing progress', async () => {
    const h = harness('homebrew');
    await h.run({ yes: true, json: true });
    should(h.out.lines.some(line => line.startsWith('warn:'))).be.false();
  });

  it('cannot roll a Homebrew update back, and says so', async () => {
    const h = harness('homebrew');
    h.host.serveOnce = ['1.2.3'];
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.report().message).match(
      /did not report 1\.3\.0 within 5s; Homebrew keeps no previous version.*fy daemon logs/u,
    );
    should(h.out.exitCode).equal(1);
  });

  it('reports a failed brew command and changes nothing else', async () => {
    const h = harness('homebrew');
    h.packages.failures.add('brew:ferretry');
    await h.run();
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:ferretry']);
    should(h.report().message).equal(
      `brew upgrade --cask ferretry failed, and nothing changed: error: brew:ferretry broke. ${RECOVERY}`,
    );
  });

  it('stops before upgrading when the tap cannot be refreshed, and names the manual commands', async () => {
    const h = harness('homebrew');
    h.packages.failures.add(BREW_REFRESH);
    await h.run();
    should(h.host.trail).deepEqual([BREW_REFRESH]);
    should(h.report().message).equal(
      `brew update failed, and nothing changed: error: ${BREW_REFRESH} broke. ${RECOVERY}`,
    );
  });

  it('says how to recover by hand when brew upgraded to something else', async () => {
    const h = harness('homebrew');
    h.packages.upgradeTo = '1.2.9';
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.report().message).startWith('the upgrade left fyd at 1.2.9, not 1.3.0');
    should(h.report().message).containEql(RECOVERY);
  });
});

describe('DaemonUpdater — nix profile', () => {
  it('upgrades the element and restarts', async () => {
    const h = harness('nix-profile');
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'restart']);
    should(h.report().outcome).equal('succeeded');
  });

  it('rolls the profile back when the new daemon will not start', async () => {
    const h = harness('nix-profile');
    h.host.restartFailures = 1;
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'restart', 'nix-rollback', 'restart']);
    should(h.report()).match({ outcome: 'rolled-back' });
    should(h.report().message).match(/did not start: .*; rolled back to 1\.2\.3, which is serving/u);
    should(h.host.running).equal('1.2.3');
  });

  it('rolls back an upgrade that installed the wrong version, before any restart', async () => {
    const h = harness('nix-profile');
    h.packages.upgradeTo = '1.2.9';
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'nix-rollback', 'restart']);
    should(h.report().message).match(/^the upgrade left fyd at 1\.2\.9, not 1\.3\.0; rolled back/u);
  });

  it('names an unknown installed version', async () => {
    const h = harness('nix-profile');
    h.packages.upgradeTo = undefined;
    h.host.versions.set(`${USER_HOME}/.nix-profile/bin/fyd`, undefined);
    await h.run();
    should(h.report().message).match(/^the upgrade left fyd at an unknown version/u);
  });

  it('fails when the rollback itself fails', async () => {
    const h = harness('nix-profile');
    h.host.restartFailures = 1;
    h.packages.failures.add('nix-rollback');
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.report().message).match(/nix profile rollback failed: error: nix-rollback broke/u);
  });

  it('names the exit code when a failed command printed nothing', async () => {
    const h = harness('nix-profile');
    h.host.restartFailures = 1;
    h.packages.failures.add('nix-rollback');
    h.packages.nixProfileRollback = () => Promise.resolve({ code: 3, stdout: '', stderr: '' });
    await h.run();
    should(h.report().message).match(/nix profile rollback failed: exit 3/u);
  });

  it('fails when the rolled-back daemon will not start either', async () => {
    const h = harness('nix-profile');
    h.host.restartFailures = 2;
    await h.run();
    should(h.report().message).match(/rolled back, but 1\.2\.3 did not start/u);
  });

  it('fails when the rolled-back daemon never reports its version', async () => {
    const h = harness('nix-profile');
    h.host.serveOnce = ['1.2.9', '1.2.9'];
    await h.run();
    should(h.report().message).match(/rolled back, but 1\.2\.3 is not serving/u);
  });

  it('reports a failed upgrade command', async () => {
    const h = harness('nix-profile');
    h.packages.failures.add('nix-upgrade:ferretry');
    h.packages.nixProfileUpgrade = () => Promise.resolve({ code: 4, stdout: '', stderr: '' });
    await h.run();
    should(h.report().message).equal('nix profile upgrade ferretry failed, and nothing changed: exit 4');
  });

  it('upgrades a daemon that is not running without starting it', async () => {
    const h = harness('nix-profile', { running: false });
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry']);
    should(h.report().message).equal('fyd updated to 1.3.0; it was not running — start it with fy daemon start');
  });

  it('rolls back a stopped daemon’s wrong upgrade without starting it', async () => {
    const h = harness('nix-profile', { running: false });
    h.packages.upgradeTo = '1.2.9';
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'nix-rollback']);
    should(h.report()).match({ outcome: 'rolled-back', message: /1\.2\.3 is back in place$/u });
  });
});

describe('DaemonUpdater — standalone', () => {
  it('stages, swaps and restarts', async () => {
    const h = harness('standalone');
    await h.run();
    should(h.host.trail).deepEqual(['stage:1.3.0:/opt/fy', 'swap:fy,fyd', 'restart']);
  });

  it('refuses what it cannot verify, and says what instead', async () => {
    const h = harness('standalone');
    h.standalone.refusal = 'this fy carries no release-signing key; update with the installer instead';
    await h.run();
    should(h.host.trail).deepEqual(['stage:1.3.0:/opt/fy']);
    should(h.report().message).equal(h.standalone.refusal);
  });

  it('puts the previous binaries back when the new daemon will not start', async () => {
    const h = harness('standalone');
    h.host.restartFailures = 1;
    await h.run();
    should(h.host.trail).deepEqual(['stage:1.3.0:/opt/fy', 'swap:fy,fyd', 'restart', 'rollback:/opt/fy', 'restart']);
    should(h.report().outcome).equal('rolled-back');
  });
});

describe('DaemonUpdater — an install newer than the release offered', () => {
  const OFFERED = '(newer than the 1.3.0 release you were offered)';

  it('accepts a newer nix profile build, serves it, and says so', async () => {
    const h = harness('nix-profile');
    h.packages.upgradeTo = '1.3.1';
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'restart']);
    should(h.report()).match({
      from: '1.2.3',
      target: '1.3.0',
      outcome: 'succeeded',
      message: `fyd updated 1.2.3 → 1.3.1 ${OFFERED} and serving`,
    });
    should(h.host.running).equal('1.3.1');
    should(h.out.exitCode).be.undefined();
  });

  it('accepts a newer Homebrew cask and a newer standalone release', async () => {
    const brew = harness('homebrew');
    brew.packages.upgradeTo = '1.4.0';
    await brew.run();
    should(brew.report().message).equal(`fyd updated 1.2.3 → 1.4.0 ${OFFERED} and serving`);
    const standalone = harness('standalone');
    standalone.standalone.delivers = '1.3.1';
    await standalone.run();
    should(standalone.host.trail).deepEqual(['stage:1.3.0:/opt/fy', 'swap:fy,fyd', 'restart']);
    should(standalone.report().message).equal(`fyd updated 1.2.3 → 1.3.1 ${OFFERED} and serving`);
  });

  it('accepts a newer build when the daemon was not running', async () => {
    const h = harness('nix-profile', { running: false });
    h.packages.upgradeTo = '1.3.1';
    await h.run();
    should(h.report().message).equal(
      `fyd updated to 1.3.1 ${OFFERED}; it was not running — start it with fy daemon start`,
    );
  });

  it('rolls back a newer build that does not serve the version it installed', async () => {
    const h = harness('nix-profile');
    h.packages.upgradeTo = '1.3.1';
    h.host.serveOnce = ['1.2.3'];
    await h.run();
    should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'restart', 'nix-rollback', 'restart']);
    should(h.report().outcome).equal('rolled-back');
    should(h.report().message).startWith('the new fyd did not report 1.3.1 within 5s; rolled back to 1.2.3');
  });

  it('still rolls back an older, unchanged, pre-release or unreadable result', async () => {
    for (const left of ['1.2.9', '1.2.3', '1.3.0-rc.1', 'dev'] as const) {
      const h = harness('nix-profile');
      h.packages.upgradeTo = left;
      await h.run();
      should(h.host.trail).deepEqual(['nix-upgrade:ferretry', 'nix-rollback', 'restart']);
      should(h.report().outcome).equal('rolled-back');
      should(h.report().message).startWith(`the upgrade left fyd at ${left}, not 1.3.0; rolled back`);
    }
  });
});

describe('DaemonUpdater — which version it offers', () => {
  const tag = (version: string) =>
    ({
      kind: 'found',
      release: { version, url: `https://github.com/kirinnee/ferretry/releases/tag/v${version}` },
    }) as const;
  const release = tag('1.3.0');

  it('offers the newest tag to a nix install when it is ahead of the release', async () => {
    const h = harness('nix-profile', { latest: new FakeLatest(release, tag('1.3.1')) });
    h.packages.upgradeTo = '1.3.1';
    await h.run();
    should(h.report()).match({
      target: '1.3.1',
      outcome: 'succeeded',
      message: 'fyd updated 1.2.3 → 1.3.1 and serving',
    });
    const shell = harness('nix-shell', { latest: new FakeLatest(release, tag('1.3.1')) });
    await shell.run({ check: true });
    should(shell.out.text).match(/update available: 1\.2\.3 → 1\.3\.1/u);
  });

  it('keeps the release when the tag is not ahead of it, or cannot be read', async () => {
    for (const newest of [tag('1.3.0'), tag('1.2.0'), { kind: 'failed', reason: 'offline' } as const]) {
      const h = harness('nix-profile', { latest: new FakeLatest(release, newest) });
      await h.run();
      should(h.report().target).equal('1.3.0');
    }
  });

  it('falls back to the tag when the release cannot be read, and fails when neither can', async () => {
    const failed = { kind: 'failed', reason: 'offline' } as const;
    const h = harness('nix-profile', { latest: new FakeLatest(failed, tag('1.3.0')) });
    await h.run();
    should(h.report()).match({ target: '1.3.0', outcome: 'succeeded' });
    const none = harness('nix-profile', { latest: new FakeLatest(failed, failed) });
    await none.run();
    should(none.report().message).equal('could not learn the latest release: offline');
  });

  it('never offers a tag to an install that downloads release assets', async () => {
    for (const kind of ['homebrew', 'standalone']) {
      const latest = new FakeLatest(release, tag('1.3.1'));
      const h = harness(kind, { latest });
      await h.run();
      should(latest.tagCalls).equal(0);
      should(h.report().target).equal('1.3.0');
    }
  });

  it('does not look for a tag when the version was named', async () => {
    const latest = new FakeLatest(release, tag('1.3.1'));
    await harness('nix-profile', { latest }).run({ yes: true, to: '1.3.0', report: '/r.json' });
    should(latest.tagCalls).equal(0);
  });
});

describe('DaemonUpdater — nix shell', () => {
  it('refuses without consent and names the switch', async () => {
    const h = harness('nix-shell');
    await h.run();
    should(h.host.trail).be.empty();
    should(h.report().message).match(
      /temporary nix shell store path[\s\S]*nix profile install github:kirinnee\/ferretry[\s\S]*--switch-to-profile/u,
    );
    should(h.out.exitCode).equal(1);
  });

  it('switches to the profile with --switch-to-profile, then installs the stable path', async () => {
    const h = harness('nix-shell');
    h.lifecycle.executables.add(PROFILE_DAEMON);
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.host.trail).deepEqual(['nix-install:github:kirinnee/ferretry', `install:${PROFILE_DAEMON}`]);
    should(h.host.definition).equal(PROFILE_DAEMON);
    should(h.report().outcome).equal('succeeded');
  });

  it('asks a terminal, and a yes is consent', async () => {
    const h = harness('nix-shell', { interactive: true, answers: ['yes', 'y'] });
    h.lifecycle.executables.add(PROFILE_DAEMON);
    await h.run({ report: '/r.json' });
    should(h.prompt.asked).deepEqual([
      'Switch to a nix profile install now? [y/N]',
      'Update fyd 1.2.3 → 1.3.0 via nix shell store path /nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-1.2.3? [y/N]',
    ]);
    should(h.report().outcome).equal('succeeded');
  });

  it('takes a no at the terminal as a refusal', async () => {
    const h = harness('nix-shell', { interactive: true, answers: ['no'] });
    await h.run({ report: '/r.json' });
    should(h.host.trail).be.empty();
    should(h.report().outcome).equal('failed');
  });

  it('reports a failed profile install', async () => {
    const h = harness('nix-shell');
    h.packages.failures.add('nix-install:github:kirinnee/ferretry');
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.report().message).equal(
      'nix profile install github:kirinnee/ferretry failed: error: nix-install:github:kirinnee/ferretry broke',
    );
  });

  it('reports a profile install that produced no daemon', async () => {
    const h = harness('nix-shell');
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.report().message).equal(
      'nix profile install github:kirinnee/ferretry finished, but no fyd appeared in your profile',
    );
  });

  it('puts the store path back when the profile daemon will not serve', async () => {
    const h = harness('nix-shell');
    h.lifecycle.executables.add(PROFILE_DAEMON);
    h.host.serveOnce = ['1.2.9'];
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.host.trail).deepEqual([
      'nix-install:github:kirinnee/ferretry',
      `install:${PROFILE_DAEMON}`,
      `install:${STORE}/bin/fyd`,
    ]);
    should(h.report().outcome).equal('rolled-back');
  });

  it('tells a stopped daemon to install from a new shell', async () => {
    const h = harness('nix-shell', { running: false });
    h.lifecycle.executables.add(PROFILE_DAEMON);
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.report().message).match(/run fy daemon install from a new shell to point the service at/u);
  });

  it('leaves a stopped daemon’s definition alone when the profile daemon is wrong', async () => {
    const h = harness('nix-shell', { running: false });
    h.lifecycle.executables.add(PROFILE_DAEMON);
    h.packages.upgradeTo = '1.2.9';
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.host.trail).deepEqual(['nix-install:github:kirinnee/ferretry']);
    should(h.report().outcome).equal('rolled-back');
  });
});

describe('DaemonUpdater — methods that cannot update themselves', () => {
  it('prints the steps for a system package and changes nothing', async () => {
    const h = harness('system-package');
    await h.run();
    should(h.host.trail).be.empty();
    should(h.report().message).match(/needs sudo[\s\S]*sudo apt-get update/u);
    should(h.out.exitCode).equal(1);
  });

  it('says plainly when it does not recognise the install', async () => {
    const h = harness('unknown');
    await h.run();
    should(h.report().message).equal(
      'Ferretry cannot update this daemon: this is a development build run from source.',
    );
  });

  it('prints module steps with their notes', async () => {
    const h = harness('nix-module');
    await h.run();
    should(h.report().message).match(/# in your configuration flake/u);
  });
});

describe('DaemonUpdater — what it checks first', () => {
  it('does nothing when already up to date', async () => {
    const h = harness('homebrew', { version: '1.3.0' });
    await h.run();
    should(h.host.trail).be.empty();
    should(h.report()).match({ outcome: 'succeeded', message: 'fyd 1.3.0 is already up to date' });
  });

  it('restarts an up-to-date daemon whose service definition is stale, so the remedy status names works', async () => {
    // Arrange — the plist an older client wrote declares no ProcessType, and launchd respawned the
    // daemon onto the new executable without ever passing through the restart that rewrites it.
    const h = harness('homebrew', { version: '1.3.0' });
    h.lifecycle.stale = 'its launchd job declares no ProcessType, so macOS throttles it';

    // Act
    await h.run();

    // Assert
    should(h.host.trail).deepEqual(['restart']);
    should(h.report()).match({
      outcome: 'succeeded',
      message:
        'fyd 1.3.0 is already up to date; restarted it under a rewritten service definition (its launchd job declares no ProcessType, so macOS throttles it)',
    });
  });

  it('asks before that restart, exactly as an update would', async () => {
    // Arrange
    const h = harness('homebrew', { version: '1.3.0', interactive: true, answers: ['n'] });
    h.lifecycle.stale = 'its launchd job declares no ProcessType, so macOS throttles it';

    // Act
    await h.run({ report: '/r.json' });

    // Assert
    should(h.host.trail).be.empty();
    should(h.prompt.asked[0]).match(/^Restart fyd to rewrite its service definition \(.*\)\? \[y\/N\]$/u);
    should(h.report().outcome).equal('failed');
  });

  it('leaves a stale definition on a stopped daemon to the next start, which rewrites it', async () => {
    // Arrange
    const h = harness('homebrew', { version: '1.3.0', running: false });
    h.lifecycle.stale = 'its launchd job declares no ProcessType, so macOS throttles it';

    // Act
    await h.run();

    // Assert
    should(h.host.trail).be.empty();
    should(h.report().message).equal(
      'fyd 1.3.0 is already up to date; its service definition is rewritten when it next starts',
    );
  });

  it('fails when the latest release cannot be learned', async () => {
    const h = harness('homebrew', { latest: new FakeLatest({ kind: 'failed', reason: 'could not reach GitHub' }) });
    await h.run();
    should(h.report().message).equal('could not learn the latest release: could not reach GitHub');
  });

  it('takes an explicit version, and refuses one that is not a version', async () => {
    const h = harness('homebrew');
    await h.run({ yes: true, to: '1.3.0', report: '/r.json' });
    should(h.latest.calls).equal(0);
    should(h.report().outcome).equal('succeeded');
    const bad = harness('homebrew');
    await bad.run({ yes: true, to: 'latest', report: '/r.json' });
    should(bad.report()).match({ target: '0.0.0', message: 'latest is not a version' });
  });

  it('fails when nothing says which version is installed', async () => {
    const h = harness('homebrew', { running: false, version: undefined });
    await h.run();
    should(h.report().message).match(/cannot tell which version \/opt\/homebrew\/bin\/fyd is/u);
  });

  it('fails when no daemon is installed', async () => {
    const h = harness('homebrew');
    h.lifecycle.missing = 'cannot find fyd on PATH';
    await h.run();
    should(h.report().message).equal('cannot find fyd on PATH');
  });

  it('names a non-error failure', async () => {
    const h = harness('homebrew');
    h.lifecycle.installed = () => {
      throw 'odd';
    };
    await h.run();
    should(h.report().message).equal('odd');
  });

  it('warns when the report cannot be written, and still says the outcome', async () => {
    const h = harness('homebrew');
    h.reports.fails = true;
    await h.run();
    should(h.out.text).match(/could not write the update report to \/r\.json: read-only file system/u);
    should(h.out.text).match(/ok: fyd updated/u);
  });

  it('prints the report as JSON with --json, and writes nothing without --report', async () => {
    const h = harness('homebrew');
    await h.run({ yes: true, json: true });
    should(JSON.parse(h.out.lines[0]?.slice(4) ?? '')).match({ outcome: 'succeeded' });
    should(h.reports.written.size).equal(0);
  });
});

describe('DaemonUpdater — consent', () => {
  it('refuses off a terminal without --yes', async () => {
    const h = harness('homebrew');
    await h.run({ report: '/r.json' });
    should(h.report().message).match(/Pass --yes to confirm off a terminal$/u);
  });

  it('asks a terminal, and a no cancels', async () => {
    const h = harness('homebrew', { interactive: true, answers: [''] });
    await h.run({ report: '/r.json' });
    should(h.report().message).equal('update cancelled; nothing changed');
    const yes = harness('homebrew', { interactive: true, answers: ['Y'] });
    await yes.run({ report: '/r.json' });
    should(yes.report().outcome).equal('succeeded');
  });

  it('goes ahead mid-turn with one line saying the ferrets keep running, on a terminal or off one', async () => {
    const script = harness('homebrew', { midTurn: [1] });
    await script.run({ report: '/r.json', yes: true });
    should(script.out.text).match(
      /one ferret is mid-turn; it keeps running through the restart, and Ferretry calls made meanwhile wait for the daemon to come back/u,
    );
    should(script.report().outcome).equal('succeeded');
    const terminal = harness('homebrew', { midTurn: [2], interactive: true, answers: ['y'] });
    await terminal.run({ report: '/r.json' });
    should(terminal.prompt.asked).deepEqual(['Update fyd 1.2.3 → 1.3.0 via Homebrew cask ferretry? [y/N]']);
    should(terminal.out.text).match(/2 ferrets are mid-turn; they keep running through the restart/u);
    should(terminal.report().outcome).equal('succeeded');
  });

  it('accepts --anyway, which every update now is', async () => {
    const h = harness('homebrew', { midTurn: [3] });
    await h.run({ yes: true, anyway: true, report: '/r.json' });
    should(h.out.text).match(/3 ferrets are mid-turn; they keep running/u);
    should(h.report().outcome).equal('succeeded');
  });

  it('waits for idle with --when-idle', async () => {
    const h = harness('homebrew', { midTurn: [2, 1, 0] });
    await h.run({ yes: true, whenIdle: true, report: '/r.json' });
    should(h.view.looks).equal(3);
    should(h.out.text).match(/2 ferrets are mid-turn; waiting until every ferret is idle before updating/u);
    should(h.report().outcome).equal('succeeded');
  });

  it('counts a daemon without the view as idle, and a stopped one is never asked', async () => {
    const h = harness('homebrew', { midTurn: [undefined] });
    await h.run();
    should(h.report().outcome).equal('succeeded');
    const stopped = harness('homebrew', { running: false, midTurn: [5] });
    await stopped.run();
    should(stopped.view.looks).equal(0);
  });
});

describe('DaemonUpdater — --check', () => {
  it('says what is installed, what is latest and what updating takes', async () => {
    const h = harness('homebrew');
    await h.run({ check: true });
    should(h.out.text).equal(
      [
        'ok: fyd 1.2.3, installed via Homebrew cask ferretry',
        'update available: 1.2.3 → 1.3.0 (https://github.com/kirinnee/ferretry/releases/tag/v1.3.0)',
        'to update: fy daemon update',
      ].join('\n'),
    );
    should(h.host.trail).be.empty();
    should(h.reports.written.size).equal(0);
  });

  it('says up to date, and names a failed check', async () => {
    const h = harness('homebrew', { version: '1.3.0' });
    await h.run({ check: true });
    should(h.out.text).match(/up to date \(latest is 1\.3\.0\)/u);
    const failed = harness('system-package', { latest: new FakeLatest({ kind: 'failed', reason: 'offline' }) });
    await failed.run({ check: true });
    should(failed.out.text).match(
      /latest: unknown \(could not learn the latest release: offline\)\nsteps:\n {2}sudo apt-get/u,
    );
  });

  it('answers JSON', async () => {
    const h = harness('homebrew');
    await h.run({ check: true, json: true });
    should(JSON.parse(h.out.lines[0]?.slice(4) ?? '')).match({
      current: '1.2.3',
      available: true,
      method: { kind: 'homebrew' },
    });
    const failed = harness('homebrew', { latest: new FakeLatest({ kind: 'failed', reason: 'offline' }) });
    await failed.run({ check: true, json: true });
    should(JSON.parse(failed.out.lines[0]?.slice(4) ?? '')).match({
      latest: null,
      available: false,
      failure: /offline/u,
    });
  });
});

describe('renderPlan', () => {
  it('renders no steps for a plan with none', () => {
    should(renderPlan({ kind: 'manual', explanation: 'x', steps: [] }, 'fy')).deepEqual([]);
  });
});

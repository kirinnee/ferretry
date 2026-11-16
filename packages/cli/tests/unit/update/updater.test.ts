import { decodeJson } from '../../../../core/kernel/host/state/format.ts';
import { describe, it } from 'bun:test';
import { UPDATES_REPORT } from '@ferretry/plugin-updates/contract';
import { CommandPackageManagers } from '../../../src/adapters/update/package-managers.ts';
import type { IPackageManagerPort } from '../../../src/lib/update/ports.ts';
import should from 'should';
import type { IDaemonPrompt } from '../../../src/lib/update/machine.ts';
import type { IProgress } from '../../../src/lib/update/progress.ts';
import { PlainProgress } from '../../../src/lib/update/progress.ts';
import { NixProfileSwitch } from '../../../src/lib/update/profile-switch.ts';
import { type DaemonUpdateOptions, DaemonUpdater, renderPlan } from '../../../src/lib/update/updater.ts';
import { CapturedOutput, SteppingClock } from './support.ts';
import { RecordingProgress } from './support.ts';
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
} from './fixtures.ts';

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
  'homebrew-v4': '/opt/homebrew/bin/fyd',
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
    progress?: IProgress;
    managers?: IPackageManagerPort;
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
    packages: options.managers ?? packages,
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
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
  const run = (flags: DaemonUpdateOptions = { yes: true, report: '/r.json' }) => updater.update(flags);
  const report = () => {
    const decoded = decodeJson(
      UPDATES_REPORT,
      'state/updates/update/report.json',
      reports.written.get('/r.json') ?? 'null',
    );
    if (!decoded.ok) throw new Error(decoded.error.sentence);
    return decoded.value;
  };
  return { facts, host, packages, standalone, lifecycle, out, prompt, reports, view, clock, latest, run, report };
}

const BREW_REFRESH = 'brew-refresh:kirinnee/ferretry:https://github.com/kirinnee/ferretry';

it('F-0352 transaction reports round-trip through the real kernel decodeJson for success, refusal and rollback', async () => {
  const success = harness('standalone');
  await success.run();
  const failed = harness('standalone');
  failed.standalone.refusal = 'no trusted key';
  await failed.run();
  const rollback = harness('standalone');
  rollback.host.restartFailures = 1;
  await rollback.run();
  for (const [h, outcome] of [
    [success, 'succeeded'],
    [failed, 'failed'],
    [rollback, 'rolled-back'],
  ] as const) {
    should(h.reports.written.get('/r.json')?.startsWith('{\n  "format": 1,')).equal(true);
    should(h.report().outcome).equal(outcome);
  }
});
const RECOVERY =
  'To recover by hand run: brew update && brew upgrade --cask kirinnee/ferretry/ferretry && fy daemon restart; if the tap is wedged: brew untap kirinnee/ferretry && brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry && brew reinstall --cask kirinnee/ferretry/ferretry';

describe('DaemonUpdater — artifact binding', () => {
  for (const explicit of [true, false]) {
    it(`refuses an @4 package major migration before any change (${explicit ? '--to' : 'latest'})`, async () => {
      const latest = new FakeLatest({ kind: 'found', release: { version: '5.0.0', url: 'https://example.com/v5' } });
      const h = harness('homebrew-v4', { version: '4.291.9', latest });
      h.packages.upgradeTo = '4.291.10';
      await h.run({ yes: true, major: true, report: '/r.json', ...(explicit ? { to: '5.0.0' } : {}) });
      should(h.report().outcome).equal('failed');
      should(h.report().message).equal(
        'The ferretry@4 package stays on v4. To move to 5.0 after preparing the home, run: brew uninstall --cask ferretry@4 && brew install --cask kirinnee/ferretry/ferretry',
      );
      should(h.host.trail).deepEqual([]);
      should(h.prompt.asked).deepEqual([]);
      should(h.host.running).equal('4.291.9');
    });
  }

  it('applies two consecutive v5 updates from updater-owned locked Nix elements and refuses the next major', async () => {
    const source = 'github:kirinnee/ferretry';
    let original = `${source}/${'0'.repeat(40)}`;
    let element = 'ferretry';
    let priority = 5;
    let candidate = { version: '5.0.10', rev: 'a'.repeat(40) };
    let staged = '';
    const ran: string[][] = [];
    let host: FakeHost;
    const managers = new CommandPackageManagers(async argv => {
      ran.push([...argv]);
      const command = argv.slice(3, 5).join(' ');
      const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
      if (command === 'profile list')
        return ok({
          elements: { [element]: { originalUrl: original, attrPath: 'packages.x86_64-linux.default', priority } },
        });
      if (command === 'flake metadata')
        return ok({ locked: { type: 'github', owner: 'kirinnee', repo: 'ferretry', rev: candidate.rev } });
      if (argv[3] === 'eval') return { code: 0, stdout: candidate.version, stderr: '' };
      if (command === 'profile install') {
        staged = argv.at(-1)?.split('#')[0] ?? '';
        return ok(null);
      }
      if (command === 'profile remove') {
        original = staged;
        element = element === 'ferretry' ? 'ferretry-1' : 'ferretry';
        priority += 1;
        host.versions.set(PROFILE_DAEMON, candidate.version);
        return ok(null);
      }
      throw new Error(`unexpected command ${argv.join(' ')}`);
    });
    const latest = new FakeLatest();
    latest.latest = () =>
      Promise.resolve({
        kind: 'found',
        release: {
          version: candidate.version.startsWith('6.') ? '5.0.12' : candidate.version,
          url: 'https://example.com/release',
        },
      });
    const h = harness('nix-profile', { version: '5.0.9', latest, managers });
    host = h.host;
    const facts = h.facts.facts.bind(h.facts);
    h.facts.facts = async daemon => ({ ...(await facts(daemon)), nixProfileElement: element });
    await h.run();
    should(h.report()).match({ from: '5.0.9', target: '5.0.10', outcome: 'succeeded' });
    should(original).equal(`${source}/${candidate.rev}`);
    candidate = { version: '5.0.11', rev: 'b'.repeat(40) };
    await h.run();
    should(h.report()).match({ from: '5.0.10', target: '5.0.11', outcome: 'succeeded' });
    should(original).equal(`${source}/${candidate.rev}`);
    const installs = ran.filter(argv => argv.slice(3, 5).join(' ') === 'profile install');
    should(installs.map(argv => argv.at(-1))).deepEqual([
      `${source}/${'a'.repeat(40)}#packages.x86_64-linux.default`,
      `${source}/${'b'.repeat(40)}#packages.x86_64-linux.default`,
    ]);
    should(
      ran.filter(argv => argv.slice(3, 5).join(' ') === 'flake metadata').every(argv => argv.at(-1) === source),
    ).be.true();
    candidate = { version: '6.0.0', rev: 'c'.repeat(40) };
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.host.running).equal('5.0.11');
    should(ran.filter(argv => argv.slice(3, 5).join(' ') === 'profile install').length).equal(2);
    should(h.lifecycle.restarts).have.length(2);
  });

  it('refuses an unparseable manager source before prompting', async () => {
    const h = harness('nix-profile');
    h.packages.sourceVersion = 'dev';
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.report().message).containEql('could not parse the package source version');
    should(h.host.trail).deepEqual([]);
    should(h.prompt.asked).deepEqual([]);
  });

  for (const changed of ['unknown', 'patch']) {
    it(`refuses brew metadata becoming ${changed} during confirmation`, async () => {
      const h = harness('homebrew', { interactive: true, answers: ['y'] });
      h.prompt.ask = () => {
        if (changed === 'unknown') h.packages.sourceFailure = 'metadata disappeared';
        else h.packages.sourceVersion = '1.3.1';
        return Promise.resolve('y');
      };
      await h.run({ report: '/r.json' });
      should(h.report().outcome).equal('failed');
      should(h.host.trail).deepEqual([BREW_REFRESH]);
    });
  }

  it('also leaves a standalone daemon up when the swapped binaries report a newer major', async () => {
    const h = harness('standalone');
    h.standalone.delivers = '2.0.0';
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.report().message).containEql('restore the previous binaries');
    should(h.host.running).equal('1.2.3');
    should(h.host.trail).deepEqual(['stage:1.3.0:/opt/fy', 'swap:fy,fyd']);
  });

  it('updates the pinned @4 cask through its full name even when latest is v5', async () => {
    const h = harness('homebrew-v4', {
      version: '4.291.9',
      latest: new FakeLatest({ kind: 'found', release: { version: '5.0.0', url: 'https://example.com/v5' } }),
    });
    h.packages.upgradeTo = '4.291.10';
    await h.run();
    should(h.report()).match({ target: '4.291.10', outcome: 'succeeded' });
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry@4', 'restart']);
  });

  it('refreshes brew before judging and rechecks local metadata after consent without refreshing again', async () => {
    const h = harness('homebrew', { interactive: true, answers: ['y'] });
    const events: string[] = [];
    const refresh = h.packages.brewRefresh.bind(h.packages);
    h.packages.brewRefresh = async (...args) => {
      events.push('refresh');
      return refresh(...args);
    };
    h.packages.brewCaskVersion = () => {
      events.push('judge');
      return Promise.resolve({ version: '1.3.0' });
    };
    const ask = h.prompt.ask.bind(h.prompt);
    h.prompt.ask = message => {
      events.push('consent');
      return ask(message);
    };
    const upgrade = h.packages.brewUpgrade.bind(h.packages);
    h.packages.brewUpgrade = async (...args) => {
      events.push('upgrade');
      return upgrade(...args);
    };
    await h.run({ report: '/r.json' });
    should(events).deepEqual(['refresh', 'judge', 'consent', 'judge', 'upgrade']);
    should(h.report().outcome).equal('succeeded');
  });

  it('refuses a cask that changes to v6 while confirmation waits', async () => {
    const h = harness('homebrew', { version: '5.0.9', interactive: true, answers: ['y'] });
    h.packages.sourceVersion = '5.0.10';
    const ask = h.prompt.ask.bind(h.prompt);
    h.prompt.ask = message => {
      h.packages.sourceVersion = '6.0.0';
      return ask(message);
    };
    await h.run({ to: '5.0.10', report: '/r.json' });
    should(h.report().outcome).equal('failed');
    should(h.host.trail).deepEqual([BREW_REFRESH]);
    should(h.host.running).equal('5.0.9');
  });

  it('refuses a late newer major immediately before restart and leaves the daemon up', async () => {
    const h = harness('homebrew', { version: '5.0.9' });
    h.packages.upgradeTo = '5.0.10';
    const view = h.view.view.bind(h.view);
    h.view.view = () => {
      if (h.host.trail.some(step => step.startsWith('brew:'))) h.host.versions.set('/opt/homebrew/bin/fyd', '6.0.0');
      return view();
    };
    await h.run({ yes: true, to: '5.0.10', report: '/r.json' });
    should(h.report().outcome).equal('failed');
    should(h.host.running).equal('5.0.9');
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry']);
  });

  const latest = () => new FakeLatest({ kind: 'found', release: { version: '5.0.10', url: 'https://example.com/v5' } });
  for (const kind of ['homebrew', 'nix-profile', 'nix-shell']) {
    it(`refuses when latest is v5 but the refreshed ${kind} source is v6`, async () => {
      const h = harness(kind, { version: '5.0.9', latest: latest() });
      h.packages.upgradeTo = '6.0.0';
      h.lifecycle.executables.add(PROFILE_DAEMON);
      await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
      should(h.report().outcome).equal('failed');
      should(h.host.running).equal('5.0.9');
      should(
        h.host.trail.some(
          step =>
            step === 'restart' ||
            step.startsWith('install:') ||
            step.startsWith('brew:') ||
            step.startsWith('nix-upgrade:') ||
            step.startsWith('nix-install:'),
        ),
      ).be.false();
      should(h.report().message).containEql('6.0.0 is the next major version');
    });
    it(`leaves the running daemon up when ${kind} unexpectedly installs v6`, async () => {
      const h = harness(kind, { version: '5.0.9', latest: latest() });
      h.packages.upgradeTo = '6.0.0';
      h.packages.sourceVersion = '5.0.10';
      h.lifecycle.executables.add(PROFILE_DAEMON);
      await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
      should(h.report().outcome).equal('failed');
      should(h.host.running).equal('5.0.9');
      should(h.host.trail.some(step => step === 'restart' || step.startsWith('install:'))).be.false();
      should(h.report().message).containEql(
        kind === 'homebrew'
          ? 'brew uninstall --cask ferretry, then install 5.0.9 again from https://github.com/kirinnee/ferretry/releases/tag/v5.0.9 and run fy daemon restart'
          : 'nix profile rollback',
      );
    });
  }
  for (const kind of ['nix-profile', 'nix-shell']) {
    it(`fails closed before prompts or host changes when ${kind} cannot resolve the revision`, async () => {
      const h = harness(kind, { version: '5.0.9', latest: latest(), interactive: true, answers: ['yes', 'yes'] });
      h.packages.sourceFailure = 'revision lookup failed';
      await h.run({ report: '/r.json' });
      should(h.report().outcome).equal('failed');
      should(h.report().message).containEql('revision lookup failed');
      should(h.host.trail).deepEqual([]);
      should(h.prompt.asked).deepEqual([]);
    });
  }
  it('never restarts a stale service definition onto an already installed newer major', async () => {
    const h = harness('homebrew', { version: '6.0.0', latest: latest() });
    h.host.running = '5.0.10';
    h.lifecycle.stale = 'old definition';
    await h.run();
    should(h.report().outcome).equal('failed');
    should(h.host.running).equal('5.0.10');
    should(h.host.trail).deepEqual([]);
  });
});

describe('DaemonUpdater — major versions', () => {
  for (const kind of ['homebrew', 'nix-profile', 'nix-shell']) {
    // Only v4 has a pinned cask, so a v5 Homebrew install is told no way to stay; nix can pin any release.
    const stay = (message: string, nix: string) => {
      if (kind === 'homebrew') should(message).not.containEql('brew install --cask');
      else should(message).containEql(nix);
    };

    it(`checks what an unpinnable ${kind} would install even with --to naming v5`, async () => {
      const latest = new FakeLatest({ kind: 'found', release: { version: '6.0.0', url: 'https://example.com/v6' } });
      const h = harness(kind, { version: '5.0.8', latest });
      h.host.running = '5.0.7';
      h.packages.upgradeTo = '6.0.0';
      await h.run({ yes: true, to: '5.0.10', switchToProfile: true, report: '/r.json' });
      should(h.report()).match({ from: '5.0.7', target: '5.0.10', outcome: 'failed' });
      should(h.report().message).containEql('Your daemon stays on 5.0.7.');
      stay(h.report().message, 'nix profile install github:kirinnee/ferretry/v5.0.7');
      should(h.report().message).containEql('6.0.0 is the next major version');
      should(h.latest.calls).equal(0);
      should(h.host.trail).deepEqual(kind === 'homebrew' ? [BREW_REFRESH] : []);
      should(h.prompt.asked).deepEqual([]);
      should(h.out.exitCode).equal(1);
    });

    it(`fails closed when the manager version is unreadable on ${kind}`, async () => {
      const h = harness(kind, { version: '5.0.7' });
      h.packages.sourceFailure = 'could not read package source: offline';
      await h.run({ yes: true, to: '5.0.10', switchToProfile: true, report: '/r.json' });
      should(h.report()).match({ outcome: 'failed' });
      should(h.report().message).containEql('could not read package source: offline');
      should(h.report().message).containEql('Your daemon stays on 5.0.7.');
      stay(h.report().message, 'nix profile install github:kirinnee/ferretry/v5.0.10');
      should(h.host.trail).deepEqual(kind === 'homebrew' ? [BREW_REFRESH] : []);
      should(h.prompt.asked).deepEqual([]);
    });

    it(`allows --major to override the unpinnable ${kind} guard`, async () => {
      const latest = new FakeLatest({ kind: 'found', release: { version: '6.0.0', url: 'https://example.com/v6' } });
      const h = harness(kind, { version: '5.0.7', latest });
      h.packages.upgradeTo = '6.0.0';
      h.lifecycle.executables.add(PROFILE_DAEMON);
      await h.run({ yes: true, to: '5.0.10', major: true, switchToProfile: true, report: '/r.json' });
      should(h.report()).match({ outcome: 'succeeded' });
      should(h.host.trail).containEql(
        kind === 'homebrew'
          ? 'brew:kirinnee/ferretry/ferretry'
          : kind === 'nix-profile'
            ? 'nix-upgrade:ferretry'
            : `nix-install:github:kirinnee/ferretry/${'a'.repeat(40)}`,
      );
    });
  }

  it('keeps an explicit v5 update on a pinning install independent of latest v6', async () => {
    const latest = new FakeLatest({ kind: 'found', release: { version: '6.0.0', url: 'https://example.com/v6' } });
    const h = harness('standalone', { version: '5.0.7', latest });
    h.standalone.delivers = '5.0.10';
    await h.run({ yes: true, to: '5.0.10', report: '/r.json' });
    should(h.report()).match({ outcome: 'succeeded' });
    should(latest.calls).equal(0);
  });

  for (const kind of ['homebrew', 'nix-profile', 'standalone']) {
    for (const explicit of [false, true]) {
      it(`refuses a newer major via ${kind}, ${explicit ? '--to' : 'latest'}, before changing anything`, async () => {
        const latest = new FakeLatest({ kind: 'found', release: { version: '6.0.0', url: 'https://example.com/v6' } });
        const h = harness(kind, { version: '5.0.9', latest });
        await h.run({ yes: true, report: '/r.json', ...(explicit ? { to: '6.0.0' } : {}) });
        should(h.report()).match({ from: '5.0.9', target: '6.0.0', outcome: 'failed' });
        should(h.report().message).startWith(
          "6.0.0 is the next major version, not a plain update: it comes with its own steps. Read that release's notes first: https://github.com/kirinnee/ferretry/releases/tag/v6.0.0. Your daemon stays on 5.0.9. --major allows the move.",
        );
        should(h.report().message).not.containEql('v5-to-v6');
        should(h.report().message).not.containEql('v4-to-v5');
        should(h.report().message).not.containEql('migration/');
        should(h.host.trail).deepEqual([]);
        should(h.prompt.asked).deepEqual([]);
        should(h.out.exitCode).equal(1);
      });
    }
  }

  // A v4 daemon can still answer while a 5.x `fy` runs the update (the plain cask is replaced under it), so
  // current is 4.x there. Only v4 has a pinned cask: the way back must name `ferretry@4`.
  it('names the real @4 cask as the way back when a v4 Homebrew daemon is offered v5', async () => {
    const latest = new FakeLatest({ kind: 'found', release: { version: '5.0.0', url: 'https://example.com/v5' } });
    const h = harness('homebrew', { version: '4.291.9', latest });
    await h.run({ yes: true, report: '/r.json' });
    should(h.report()).match({ from: '4.291.9', target: '5.0.0', outcome: 'failed' });
    should(h.report().message).equal(
      "5.0.0 is the next major version, not a plain update: it comes with its own steps. Read that release's notes first: https://github.com/kirinnee/ferretry/releases/tag/v5.0.0. Your daemon stays on 4.291.9. --major allows the move. To stay on v4, run: brew install --cask kirinnee/ferretry/ferretry@4",
    );
    should(h.host.trail).deepEqual([]);
    should(h.host.running).equal('4.291.9');
  });

  it('recovers a v4 Homebrew daemon through the real @4 cask when the upgrade installs v5', async () => {
    const h = harness('homebrew', { version: '4.291.9' });
    h.packages.sourceVersion = '4.291.10';
    h.packages.upgradeTo = '5.0.0';
    await h.run({ yes: true, to: '4.291.10', report: '/r.json' });
    should(h.report()).match({ from: '4.291.9', target: '4.291.10', outcome: 'failed' });
    should(h.report().message).equal(
      'The installed fyd is 5.0.0, a newer major than 4.291.9. No restart ran; the running daemon was left up. Recover with: brew uninstall --cask ferretry && brew install --cask kirinnee/ferretry/ferretry@4 && fy daemon restart. --major allows this move.',
    );
    should(h.host.running).equal('4.291.9');
    should(h.host.trail.includes('restart')).be.false();
  });

  it('keeps patch updates within v5 working', async () => {
    const h = harness('homebrew', { version: '5.0.9' });
    h.packages.upgradeTo = '5.0.10';
    await h.run({ yes: true, to: '5.0.10', report: '/r.json' });
    should(h.report()).match({ from: '5.0.9', target: '5.0.10', outcome: 'succeeded' });
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry', 'restart']);
  });

  it('allows the migration to explicitly opt in with --major', async () => {
    const h = harness('homebrew', { version: '5.0.9' });
    h.packages.upgradeTo = '6.0.0';
    await h.run({ yes: true, to: '6.0.0', major: true, report: '/r.json' });
    should(h.report()).match({ from: '5.0.9', target: '6.0.0', outcome: 'succeeded' });
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry', 'restart']);
  });

  it('refuses a newer locked Nix revision even when the latest published release is still v5', async () => {
    const latest = new FakeLatest(
      { kind: 'found', release: { version: '5.0.10', url: 'https://example.com/v5' } },
      { kind: 'found', release: { version: '6.0.0', url: 'https://example.com/v6' } },
    );
    const h = harness('nix-profile', { version: '5.0.9', latest });
    h.packages.upgradeTo = '6.0.0';
    await h.run();
    should(h.report()).match({ outcome: 'failed' });
    should(h.host.trail).deepEqual([]);
  });

  it('reports a newer major as unavailable in --check without applying anything', async () => {
    const h = harness('homebrew', { version: '5.0.9' });
    await h.run({ check: true, to: '6.0.0', json: true });
    should(JSON.parse(h.out.lines.at(-1)?.replace(/^ok: /u, '') ?? 'null')).match({ available: false });
    await h.run({ check: true, to: '6.0.0' });
    should(h.out.lines.at(-1)).containEql('6.0.0 is the next major version');
    should(h.host.trail).deepEqual([]);
  });
});

describe('DaemonUpdater — Homebrew', () => {
  it('upgrades the cask, restarts, and proves the new version serves', async () => {
    const h = harness('homebrew');
    await h.run();
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry', 'restart']);
    should(h.out.lines).containEql(
      'warn: refreshing the Homebrew tap kirinnee/ferretry so brew can see 1.3.0 (brew update)',
    );
    should(h.report()).match({ from: '1.2.3', target: '1.3.0', outcome: 'succeeded' });
    should(h.out.lines.at(-1)).equal('ok: ✔ fyd updated 1.2.3 → 1.3.0 in 2.0s');
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
    h.packages.failures.add('brew:kirinnee/ferretry/ferretry');
    await h.run();
    should(h.host.trail).deepEqual([BREW_REFRESH, 'brew:kirinnee/ferretry/ferretry']);
    should(h.report().message).equal(
      `brew upgrade --cask kirinnee/ferretry/ferretry failed, and nothing changed: error: brew:kirinnee/ferretry/ferretry broke. ${RECOVERY}`,
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
    h.packages.sourceVersion = '1.3.0';
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
    h.packages.sourceVersion = '1.3.0';
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
    h.packages.sourceVersion = '1.3.0';
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
      target: '1.3.1',
      outcome: 'succeeded',
      message: 'fyd updated 1.2.3 → 1.3.1 in 2.0s',
    });
    should(h.host.running).equal('1.3.1');
    should(h.out.exitCode).be.undefined();
  });

  it('accepts a newer Homebrew cask and a newer standalone release', async () => {
    const brew = harness('homebrew');
    brew.packages.upgradeTo = '1.4.0';
    await brew.run();
    should(brew.report().message).equal('fyd updated 1.2.3 → 1.4.0 in 2.0s');
    const standalone = harness('standalone');
    standalone.standalone.delivers = '1.3.1';
    await standalone.run();
    should(standalone.host.trail).deepEqual(['stage:1.3.0:/opt/fy', 'swap:fy,fyd', 'restart']);
    should(standalone.report().message).equal(`fyd updated 1.2.3 → 1.3.1 ${OFFERED} in 2.0s`);
  });

  it('accepts a newer build when the daemon was not running', async () => {
    const h = harness('nix-profile', { running: false });
    h.packages.upgradeTo = '1.3.1';
    await h.run();
    should(h.report().message).equal('fyd updated to 1.3.1; it was not running — start it with fy daemon start');
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
      h.packages.sourceVersion = '1.3.0';
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

  it('offers the version at the locked Nix revision, independent of tags', async () => {
    const h = harness('nix-profile', { latest: new FakeLatest(release, tag('1.3.1')) });
    h.packages.upgradeTo = '1.3.1';
    await h.run();
    should(h.report()).match({
      target: '1.3.1',
      outcome: 'succeeded',
      message: 'fyd updated 1.2.3 → 1.3.1 in 2.0s',
    });
    const shell = harness('nix-shell', { latest: new FakeLatest(release, tag('1.3.1')) });
    await shell.run({ check: true });
    should(shell.out.text).match(/update available: 1\.2\.3 → 1\.3\.0/u);
  });

  it('keeps the release when the tag is not ahead of it, or cannot be read', async () => {
    for (const newest of [tag('1.3.0'), tag('1.2.0'), { kind: 'failed', reason: 'offline' } as const]) {
      const h = harness('nix-profile', { latest: new FakeLatest(release, newest) });
      await h.run();
      should(h.report().target).equal('1.3.0');
    }
  });

  it('fails closed when the release cannot be read even if a Nix tag is known', async () => {
    const failed = { kind: 'failed', reason: 'offline' } as const;
    const h = harness('nix-profile', { latest: new FakeLatest(failed, tag('1.3.0')) });
    await h.run();
    should(h.report()).match({ outcome: 'failed' });
    should(h.report().message).containEql('nix profile install github:kirinnee/ferretry/v1.2.3');
    should(h.host.trail).deepEqual([]);
    const none = harness('nix-profile', { latest: new FakeLatest(failed, failed) });
    await none.run();
    should(none.report().message).startWith('could not learn the latest release: offline');
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

  it('checks the unversioned Nix source even when the version was named', async () => {
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
    should(h.host.trail).deepEqual([
      `nix-install:github:kirinnee/ferretry/${'a'.repeat(40)}`,
      `install:${PROFILE_DAEMON}`,
    ]);
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
    h.packages.failures.add(`nix-install:github:kirinnee/ferretry/${'a'.repeat(40)}`);
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.report().message).equal(
      `nix profile install github:kirinnee/ferretry/${'a'.repeat(40)} failed: error: nix-install:github:kirinnee/ferretry/${'a'.repeat(40)} broke`,
    );
  });

  it('reports a profile install that produced no daemon', async () => {
    const h = harness('nix-shell');
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.report().message).equal(
      `nix profile install github:kirinnee/ferretry/${'a'.repeat(40)} finished, but no fyd appeared in your profile`,
    );
  });

  it('puts the store path back when the profile daemon will not serve', async () => {
    const h = harness('nix-shell');
    h.lifecycle.executables.add(PROFILE_DAEMON);
    h.host.serveOnce = ['1.2.9'];
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.host.trail).deepEqual([
      `nix-install:github:kirinnee/ferretry/${'a'.repeat(40)}`,
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
    h.packages.sourceVersion = '1.3.0';
    await h.run({ yes: true, switchToProfile: true, report: '/r.json' });
    should(h.host.trail).deepEqual([`nix-install:github:kirinnee/ferretry/${'a'.repeat(40)}`]);
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
    should(h.report().message).startWith('could not learn the latest release: could not reach GitHub');
    should(h.report().message).containEql('Your daemon stays on 1.2.3.');
    should(h.report().message).not.containEql('brew install --cask');
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
    should(h.out.text).match(/ok: ✔ fyd updated/u);
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
    should(terminal.prompt.asked).deepEqual([
      'Update fyd 1.2.3 → 1.3.0 via Homebrew cask kirinnee/ferretry/ferretry? [y/N]',
    ]);
    should(terminal.out.text).match(/2 ferrets are mid-turn; they keep running through the restart/u);
    should(terminal.report().outcome).equal('succeeded');
  });

  it('waits for idle with --when-idle', async () => {
    const h = harness('homebrew', { midTurn: [2, 1, 0] });
    await h.run({ yes: true, whenIdle: true, report: '/r.json' });
    // three looks to wait for idle, one more to tell the restart how many ferrets keep running
    should(h.view.looks).equal(4);
    should(h.out.text).match(/2 ferrets are mid-turn; waiting until every ferret is idle before updating/u);
    should(h.report().outcome).equal('succeeded');
  });

  it('says so with --when-idle when no ferret is mid-turn at the first read, and goes ahead', async () => {
    const h = harness('homebrew', { midTurn: [0] });
    await h.run({ yes: true, whenIdle: true, report: '/r.json' });
    should(h.out.text).match(/no ferret is mid-turn/u);
    should(h.report().outcome).equal('succeeded');
    const plain = harness('homebrew', { midTurn: [0] });
    await plain.run({ yes: true, report: '/r.json' });
    should(plain.out.text).not.match(/mid-turn/u);
  });

  it('with --when-idle refuses, updating nothing, when the daemon is up but its count cannot be read', async () => {
    const h = harness('homebrew', { midTurn: [undefined] });
    await h.run({ yes: true, whenIdle: true, report: '/r.json' });
    should(h.report().outcome).equal('failed');
    should(h.report().message).match(
      /could not read how many ferrets are mid-turn, so nothing was updated; run it again, or leave out --when-idle/u,
    );
    const waiting = harness('homebrew', { midTurn: [2, undefined] });
    await waiting.run({ yes: true, whenIdle: true, report: '/r.json' });
    should(waiting.report().outcome).equal('failed');
    should(waiting.report().message).match(/nothing was updated/u);
  });

  it('with --when-idle goes ahead when the daemon is stopped: there is no count to wait for', async () => {
    const h = harness('homebrew', { running: false, midTurn: [undefined] });
    await h.run({ yes: true, whenIdle: true, report: '/r.json' });
    should(h.view.looks).equal(0);
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
        'ok: fyd 1.2.3, installed via Homebrew cask kirinnee/ferretry/ferretry',
        'update available: 1.2.3 → 1.3.0 (https://github.com/kirinnee/ferretry/releases/tag/v1.3.0)',
        'to update: fy update',
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

describe('DaemonUpdater — progress', () => {
  const NIX_ACTIVITY = [
    { phase: 'preparing' },
    { phase: 'downloading', packages: { done: 23, expected: 41 }, bytes: { done: 48_000_000, expected: 120_000_000 } },
    { phase: 'switching', packages: { done: 41, expected: 41 } },
  ] as const;

  it('names each phase of a nix profile update and ends on the one-line result', async () => {
    const progress = new RecordingProgress();
    const h = harness('nix-profile', { progress });
    h.packages.activities = [...NIX_ACTIVITY];
    await h.run();
    should(progress.steps).deepEqual([
      'Checking for an update',
      'Preparing 1.3.0',
      'Downloading 1.3.0',
      'Switching the nix profile',
    ]);
    should(progress.events).containEql('detail 23/41 packages, 48/120 MB');
    should(progress.events.at(-1)).equal('succeed');
    should(h.out.lines.at(-1)).equal('ok: ✔ fyd updated 1.2.3 → 1.3.0 in 2.0s');
  });

  it('tells the restart how many ferrets keep running', async () => {
    const h = harness('nix-profile', { midTurn: [3, 3] });
    await h.run();
    should(h.lifecycle.restarts).deepEqual([3]);
  });

  it('shows a brew update as refreshing and upgrading', async () => {
    const progress = new RecordingProgress();
    const h = harness('homebrew', { progress });
    h.packages.activities = [{ phase: 'upgrading', line: '==> Upgrading ferretry' }];
    await h.run();
    should(progress.steps).containEql('Upgrading with Homebrew');
    should(progress.events).containEql('detail ==> Upgrading ferretry');
  });

  it('shows a standalone update as downloading, verifying and unpacking, then swapping', async () => {
    const progress = new RecordingProgress();
    const h = harness('standalone', { progress });
    h.standalone.activities = [
      { phase: 'downloading', bytes: { done: 1_000_000, expected: 4_000_000 } },
      { phase: 'verifying' },
      { phase: 'unpacking' },
    ];
    await h.run();
    should(progress.steps).deepEqual([
      'Checking for an update',
      'Downloading 1.3.0',
      'Verifying the download',
      'Unpacking 1.3.0',
      'Swapping in the new binaries',
    ]);
    should(progress.events).containEql('detail 1.0/4.0 MB');
  });

  it('fails the step it was on, and says it is rolling back', async () => {
    const progress = new RecordingProgress();
    const h = harness('nix-profile', { progress });
    h.host.restartFailures = 1;
    await h.run();
    should(progress.steps).containEql('Rolling back to 1.2.3');
    should(progress.events).containEql('fail');
  });

  it('settles the step when the update is refused', async () => {
    const progress = new RecordingProgress();
    const h = harness('standalone', { progress });
    h.standalone.refusal = 'no key';
    await h.run();
    should(progress.events.at(-1)).equal('fail');
    should(h.out.exitCode).equal(1);
  });

  it('writes the same result for --json, with the progress left to stderr', async () => {
    const progress = new RecordingProgress();
    const h = harness('homebrew', { progress });
    await h.run({ yes: true, json: true });
    should(JSON.parse(h.out.lines.at(-1)?.replace('ok: ', '') ?? '')).match({ outcome: 'succeeded', target: '1.3.0' });
  });

  it('prints a fixture run the way a person reads it', async () => {
    const lines: string[] = [];
    const progress = new PlainProgress(line => lines.push(line));
    const h = harness('nix-profile', { progress });
    h.packages.activities = [...NIX_ACTIVITY];
    await h.run();
    const transcript = [...lines, ...h.out.lines].join('\n');
    should(transcript).equal(
      [
        '- Checking for an update',
        '- Preparing 1.3.0',
        '- Downloading 1.3.0',
        '- Switching the nix profile',
        'ok: ✔ fyd updated 1.2.3 → 1.3.0 in 2.0s',
      ].join('\n'),
    );
  });
});

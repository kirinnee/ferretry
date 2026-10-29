import { describe, it } from 'bun:test';
import { UpdateReportSchema } from '@ferretry/protocol';
import should from 'should';
import type { IDaemonPrompt } from '../../../src/lib/daemon/ports';
import { NixProfileSwitch } from '../../../src/lib/update/profile-switch';
import { DaemonUpdater } from '../../../src/lib/update/updater';
import { CapturedOutput, SteppingClock } from '../daemon/fixtures';
import { RecordingProgress } from '../progress/fixtures';
import {
  FakeFacts,
  FakeHost,
  FakeLatest,
  FakeLifecycle,
  FakePackages,
  FakeReports,
  FakeStandalone,
  FakeUpdateView,
  USER_HOME,
} from './fixtures';

class NeverAsked implements IDaemonPrompt {
  ask(): Promise<string> {
    return Promise.resolve('n');
  }
}

function harness() {
  const daemonPath = '/opt/homebrew/bin/fyd';
  const host = new FakeHost(daemonPath, '1.2.3', true);
  const packages = new FakePackages(host, daemonPath);
  const lifecycle = new FakeLifecycle(host, daemonPath);
  const out = new CapturedOutput();
  const prompt = new NeverAsked();
  const reports = new FakeReports();
  const facts = new FakeFacts('homebrew');
  const progress = new RecordingProgress();
  const interactive = () => false;
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
    latest: new FakeLatest(),
    packages,
    standalone: new FakeStandalone(host, daemonPath),
    lifecycle,
    updateView: new FakeUpdateView([0]),
    switcher,
    reports,
    out,
    prompt,
    interactive,
    clock: new SteppingClock(1_000),
    product: 'ferretry',
    clientName: 'fy',
    daemonName: 'fyd',
    healthTimeoutMs: 5_000,
    pollMs: 500,
    progress,
  });
  const report = () => UpdateReportSchema.parse(JSON.parse(reports.written.get('/r.json') ?? 'null'));
  return {
    host,
    packages,
    lifecycle,
    out,
    progress,
    report,
    run: () => updater.update({ yes: true, report: '/r.json' }),
  };
}

describe('DaemonUpdater — settling the step it was on', () => {
  it('should fail the running step and report the error when the package manager itself throws', async () => {
    // Arrange
    const h = harness();
    h.packages.brewUpgrade = () => Promise.reject(new Error('brew crashed: out of disk'));

    // Act
    await h.run();

    // Assert
    should(h.progress.events.at(-1)).equal('fail');
    should(h.progress.events.filter(event => event === 'succeed')).have.length(1); // only the version check
    should(h.report()).match({ from: '1.2.3', outcome: 'failed' });
    should(h.report().message).containEql('brew crashed: out of disk');
    should(h.out.exitCode).equal(1);
  });
});

describe('DaemonUpdater — waiting for the new version to serve', () => {
  it('should poll until the restarted daemon reports the new version, then settle the wait as done', async () => {
    // Arrange
    const h = harness();
    const probe = h.lifecycle.probe.bind(h.lifecycle);
    let silentProbes = 2;
    h.lifecycle.probe = async () => {
      if (h.host.trail.includes('restart') && silentProbes > 0) {
        silentProbes -= 1;
        return undefined;
      }
      return probe();
    };

    // Act
    await h.run();

    // Assert
    should(h.progress.steps).containEql('Waiting for fyd to report 1.3.0');
    const waitStart = h.progress.events.indexOf('start Waiting for fyd to report 1.3.0');
    should(h.progress.events[waitStart + 1]).equal('succeed');
    should(silentProbes).equal(0);
    should(h.report()).match({ from: '1.2.3', target: '1.3.0', outcome: 'succeeded' });
  });
});

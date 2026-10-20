import { describe, it } from 'bun:test';
import should from 'should';
import { OnboardController } from '../../../src/lib/onboard/controller.ts';
import { deps, FakeDaemon, inspection, NO_DEFINITION, printedJson } from './fixtures.ts';

const stopped = () => inspection({ serving: false });

describe('OnboardController.setup', () => {
  it('should leave a daemon that already serves under its service manager alone', async () => {
    // Arrange
    const daemon = new FakeDaemon([inspection()]);
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ yes: true });

    // Assert
    should(daemon.calls).eql(['inspect']);
    should(recorded.exitCode).be.undefined();
    should(recorded.lines[0]?.kind).equal('success');
    should(recorded.lines[0]?.text).match(/^Ferretry is set up\./);
  });

  it('should install the service with --yes when nothing runs, then read the result again', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped(), inspection()]);
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ yes: true, json: true });

    // Assert
    should(daemon.calls).eql(['inspect', 'install', 'inspect']);
    should(daemon.quiet).eql([true]);
    const summary = printedJson(recorded);
    should(summary.ready).be.true();
    should(summary.exitCode).equal(0);
    should((summary.daemon as { action: string }).action).equal('installed');
    should(recorded.exitCode).be.undefined();
  });

  it('should start the daemon directly where there is no service manager', async () => {
    // Arrange
    const daemon = new FakeDaemon([
      inspection({ serving: false, serviceManager: false }),
      inspection({ supervisor: { manager: 'direct', state: 'running', pid: 7 }, serviceManager: false }),
    ]);
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ yes: true, json: true });

    // Assert
    should(daemon.calls).eql(['inspect', 'start', 'inspect']);
    should((printedJson(recorded).daemon as { action: string }).action).equal('started');
  });

  it('should refuse to act off a terminal without --yes, and exit 2 naming the flag', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped()]);
    const { deps: wired, recorded } = deps({ daemon, interactive: false });

    // Act
    await new OnboardController(wired).setup({ json: true });

    // Assert
    should(daemon.calls).eql(['inspect']);
    const summary = printedJson(recorded);
    should(summary.exitCode).equal(2);
    should(summary.next).eql([{ command: 'fy setup --yes', why: 'install and start the daemon', ownTerminal: false }]);
    should(recorded.exitCode).equal(2);
  });

  it('should ask at a terminal, and exit 2 when the person says no', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped()]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true, answers: ['n'] });

    // Act
    await new OnboardController(wired).setup({});

    // Assert
    should(recorded.questions).eql(['Install the Ferretry daemon as a user service and start it? [Y/n]']);
    should(daemon.calls).eql(['inspect']);
    should(recorded.exitCode).equal(2);
    should(recorded.lines[0]?.kind).equal('warn');
    should(recorded.lines[0]?.text).containEql('you skipped installing it');
  });

  it('should ask to start where there is no service manager', async () => {
    // Arrange
    const daemon = new FakeDaemon([inspection({ serving: false, serviceManager: false })]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true, answers: ['no'] });

    // Act
    await new OnboardController(wired).setup({});

    // Assert
    should(recorded.questions).eql(['Start the Ferretry daemon? [Y/n]']);
  });

  it('should install on a yes, then offer the pairing QR to the person at the terminal', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped(), inspection()]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true, answers: ['', 'y'] });

    // Act
    await new OnboardController(wired).setup({});

    // Assert
    should(daemon.calls).eql(['inspect', 'install', 'inspect']);
    should(daemon.quiet).eql([false]);
    should(recorded.questions).eql([
      'Install the Ferretry daemon as a user service and start it? [Y/n]',
      'Pair your phone now? [Y/n]',
    ]);
    should(recorded.paired).equal(1);
    should(recorded.lines[0]?.text).not.containEql('fy pair');
  });

  it('should name `fy pair` for later when the person declines the QR', async () => {
    // Arrange
    const daemon = new FakeDaemon([inspection()]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true, answers: ['no'] });

    // Act
    await new OnboardController(wired).setup({});

    // Assert
    should(recorded.paired).equal(0);
    should(recorded.lines.at(-1)).eql({ kind: 'report', text: 'Pair later with `fy pair`.' });
  });

  it('should never offer the QR with --json, --yes or --check, even at a terminal', async () => {
    for (const options of [{ json: true }, { yes: true }, { check: true }]) {
      // Arrange
      const daemon = new FakeDaemon([inspection()]);
      const { deps: wired, recorded } = deps({ daemon, interactive: true });

      // Act
      await new OnboardController(wired).setup(options);

      // Assert
      should(recorded.questions).eql([]);
      should(recorded.paired).equal(0);
    }
  });

  it('should change nothing with --check, and say what it would do', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped()]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true });

    // Act
    await new OnboardController(wired).setup({ check: true, json: true });

    // Assert
    should(daemon.calls).eql(['inspect']);
    const summary = printedJson(recorded);
    should((summary.daemon as { action: string }).action).equal('would-install');
    should(summary.exitCode).equal(1);
    should(summary.next).eql([{ command: 'fy setup', why: 'install and start the daemon', ownTerminal: false }]);
  });

  it('should report --check of a host with no service manager as a start', async () => {
    // Arrange
    const daemon = new FakeDaemon([inspection({ serving: false, serviceManager: false })]);
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ check: true, json: true });

    // Assert
    should((printedJson(recorded).daemon as { action: string }).action).equal('would-start');
  });

  it('should report a failed install with its reason and exit 1', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped(), stopped()], new Error('launchctl bootstrap failed'));
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ yes: true, json: true });

    // Assert
    const summary = printedJson(recorded);
    should(summary.exitCode).equal(1);
    should(summary.daemon).containEql({ action: 'failed', problem: 'launchctl bootstrap failed' });
    should(summary.next).eql([
      { command: 'fy daemon logs', why: 'see why the daemon did not start', ownTerminal: false },
    ]);
    should(recorded.exitCode).equal(1);
  });

  it('should keep the earlier facts when the daemon cannot be read after a failure', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped()], new Error('boom'));
    const failing = Object.assign(daemon, {
      inspect: (() => {
        let first = true;
        return async () => {
          if (first) {
            first = false;
            return stopped();
          }
          throw new Error('unreadable');
        };
      })(),
    });
    const { deps: wired, recorded } = deps({ daemon: failing });

    // Act
    await new OnboardController(wired).setup({ yes: true, json: true });

    // Assert
    should(printedJson(recorded).daemon).containEql({ state: 'stopped', action: 'failed', problem: 'boom' });
  });

  it('should carry a non-Error failure as text', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped(), stopped()]);
    daemon.install = async () => {
      throw 'refused';
    };
    const { deps: wired, recorded } = deps({ daemon });

    // Act
    await new OnboardController(wired).setup({ yes: true, json: true });

    // Assert
    should(printedJson(recorded).daemon).containEql({ problem: 'refused' });
  });

  it('should fail without acting when this host has no daemon executable', async () => {
    // Arrange
    const daemon = new FakeDaemon([inspection({ serving: false, missing: true, supervisor: NO_DEFINITION })]);
    const { deps: wired, recorded } = deps({ daemon, interactive: true });

    // Act
    await new OnboardController(wired).setup({});

    // Assert
    should(daemon.calls).eql(['inspect']);
    should(recorded.questions).eql([]);
    should(recorded.exitCode).equal(1);
    should(recorded.lines[0]?.text).containEql('cannot find fyd on PATH');
  });

  it('should not ask the relay or the machine about a daemon that is not running', async () => {
    // Arrange
    const daemon = new FakeDaemon([stopped()]);
    const { deps: wired, recorded } = deps({ daemon });
    let asked = 0;
    wired.relay.reach = async () => {
      asked += 1;
      return { state: 'direct-only' };
    };

    // Act
    await new OnboardController(wired).setup({ check: true, json: true });

    // Assert
    should(asked).equal(0);
    const summary = printedJson(recorded);
    should(summary.relay).eql({ state: 'unknown', reason: 'the daemon is not running' });
    should(summary.machine).eql({ setUp: null });
  });
});

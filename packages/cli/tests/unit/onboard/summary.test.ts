import { describe, it } from 'bun:test';
import should from 'should';
import type { DaemonInspection } from '../../../src/lib/daemon/controller.ts';
import type { RelayReach } from '../../../src/lib/onboard/ports.ts';
import {
  type DaemonAction,
  planDaemon,
  renderSetupSummary,
  renderSetupSummaryJson,
  type SummaryInput,
  summarize,
} from '../../../src/lib/onboard/summary.ts';
import { inspection, NO_DEFINITION } from './fixtures.ts';

const input = (overrides: Partial<SummaryInput> = {}): SummaryInput => ({
  clientVersion: '1.2.3',
  clientName: 'fy',
  inspection: inspection(),
  action: 'none',
  problem: undefined,
  relay: { state: 'relay', url: 'wss://relay.example.test' },
  setUp: true,
  pairing: 'later',
  ...overrides,
});

describe('planDaemon', () => {
  it('should do nothing to a daemon serving under its service manager', () => {
    should(planDaemon(inspection())).equal('none');
  });

  it('should install the service over a daemon serving as a stray child', () => {
    should(planDaemon(inspection({ supervisor: { manager: 'direct', state: 'running', pid: 99 } }))).equal('install');
  });

  it('should install over a daemon the service manager did not start', () => {
    const orphan = inspection({ supervisor: { manager: 'launchd', state: 'failed' } });
    should(orphan.view.orphan).be.true();
    should(planDaemon(orphan)).equal('install');
  });

  it('should leave a serving daemon alone where there is no service manager', () => {
    const direct = inspection({ supervisor: { manager: 'direct', state: 'running', pid: 99 }, serviceManager: false });
    should(planDaemon(direct)).equal('none');
  });

  it('should install, start, or report the missing executable when nothing serves', () => {
    should(planDaemon(inspection({ serving: false }))).equal('install');
    should(planDaemon(inspection({ serving: false, serviceManager: false }))).equal('start');
    should(planDaemon(inspection({ serving: false, missing: true }))).equal('missing');
  });

  it('should leave a serving daemon alone even when its executable cannot be found', () => {
    should(planDaemon(inspection({ missing: true }))).equal('none');
  });
});

describe('summarize', () => {
  it('should report a ready machine with pairing as the first next step', () => {
    // Act
    const summary = summarize(input());

    // Assert
    should(summary).containEql({ schema: 1, ready: true, exitCode: 0 });
    should(summary.install).eql({ method: 'homebrew', description: 'Homebrew cask ferretry' });
    should(summary.daemon).eql({
      state: 'serving',
      action: 'none',
      version: '1.2.3',
      installedVersion: '1.2.3',
      manager: 'launchd',
      supervised: true,
      problem: null,
    });
    should(summary.update).eql({ available: false, current: '1.2.3', latest: null, command: null });
    should(summary.warnings).eql([]);
    should(summary.next).eql([{ command: 'fy pair', why: 'pair your phone', ownTerminal: true }]);
  });

  it('should leave pairing out of next when the QR is offered now', () => {
    should(summarize(input({ pairing: 'now' })).next).eql([]);
  });

  it('should name daemon setup when no runtime is set up, and the update command when one is out', () => {
    // Act
    const summary = summarize(input({ setUp: false, inspection: inspection({ latest: '1.3.0' }) }));

    // Assert
    should(summary.update).eql({
      available: true,
      current: '1.2.3',
      latest: '1.3.0',
      command: 'fy daemon update',
    });
    should(summary.next.map(step => step.command)).eql(['fy pair', 'fy daemon setup', 'fy daemon update']);
    should(summary.machine).eql({ setUp: false });
  });

  it('should say a stale running daemon needs a restart, and a client that differs', () => {
    // Act
    const summary = summarize(
      input({ clientVersion: '1.3.0', inspection: inspection({ version: '1.2.3', installedVersion: '1.3.0' }) }),
    );

    // Assert
    should(summary.warnings).eql([
      'The running daemon is 1.2.3 but 1.3.0 is installed.',
      'fy is 1.3.0 but the daemon is 1.2.3.',
    ]);
    should(summary.next[0]).eql({ command: 'fy daemon restart', why: 'run the installed version', ownTerminal: false });
  });

  it('should warn that a nix shell install is temporary', () => {
    should(summarize(input({ inspection: inspection({ nixShell: true }) })).warnings).eql([
      'Installed from a temporary nix shell, which garbage collection can delete.',
    ]);
  });

  it('should tolerate an installed daemon whose version could not be read', () => {
    const unread = inspection();
    const summary = summarize(
      input({ inspection: { ...unread, located: { path: '/usr/bin/fyd', source: 'PATH' } } as DaemonInspection }),
    );
    should(summary.daemon.installedVersion).be.null();
    should(summary.warnings).eql([]);
  });

  it('should report no install or update when the daemon has no update status', () => {
    const summary = summarize(input({ inspection: { ...inspection(), update: undefined } }));
    should(summary.install).be.null();
    should(summary.update).be.null();
  });

  it('should say the daemon is not installed, with the reason, when the executable is missing', () => {
    // Act
    const summary = summarize(
      input({ action: 'failed', inspection: inspection({ serving: false, missing: true, supervisor: NO_DEFINITION }) }),
    );

    // Assert
    should(summary).containEql({ ready: false, exitCode: 1 });
    should(summary.daemon.state).equal('not-installed');
    should(summary.daemon.problem).match(/^cannot find fyd on PATH/);
    should(summary.next).eql([]);
  });

  it('should say "declined" and "needs a terminal" are waiting for a person, with exit 2', () => {
    for (const action of ['declined', 'needs-terminal'] as DaemonAction[]) {
      const summary = summarize(input({ action, inspection: inspection({ serving: false }) }));
      should(summary.exitCode).equal(2);
      should(summary.ready).be.false();
    }
  });

  it('should never have a field that could carry a pairing code or a token', () => {
    const json = renderSetupSummaryJson(summarize(input()));
    should(json).not.match(/"code"|"pairingCode"|token|secret|pairUrl|fingerprint/i);
    should(JSON.parse(json)).have.keys(
      'schema',
      'ready',
      'exitCode',
      'client',
      'install',
      'daemon',
      'update',
      'relay',
      'machine',
      'warnings',
      'next',
    );
  });
});

describe('renderSetupSummary', () => {
  it('should print a short aligned report with numbered next steps', () => {
    // Act
    const text = renderSetupSummary(summarize(input({ setUp: false, inspection: inspection({ latest: '1.3.0' }) })));

    // Assert
    should(text).equal(
      [
        'Ferretry is set up.',
        '',
        '  ✓ Daemon   running 1.2.3, started by launchd',
        '  ✓ Install  Homebrew cask ferretry',
        '  ! Update   1.3.0 is available (you have 1.2.3)',
        '  ✓ Relay    on — your phone can connect from any network',
        '  ! Agents   not set up yet — no Claude Code or Codex runtime',
        '',
        'Next:',
        '  1. fy pair            pair your phone — in your own terminal',
        '  2. fy daemon setup    use your Claude Code and Codex logins — in your own terminal',
        '  3. fy daemon update   update to 1.3.0',
      ].join('\n'),
    );
  });

  it('should say when the daemon is up to date, set up, and not supervised', () => {
    const direct = inspection({ supervisor: { manager: 'direct', state: 'running', pid: 9 }, serviceManager: false });
    const text = renderSetupSummary(summarize(input({ inspection: direct, pairing: 'now' })));
    should(text).containEql('✓ Daemon   running 1.2.3, not supervised');
    should(text).containEql('✓ Update   up to date');
    should(text).containEql('✓ Agents   set up');
    should(text).not.containEql('Next:');
  });

  it('should leave the agents row out when the daemon could not say', () => {
    should(renderSetupSummary(summarize(input({ setUp: undefined })))).not.containEql('Agents');
  });

  it('should explain each relay state in one line', () => {
    const relay = (state: RelayReach): string => renderSetupSummary(summarize(input({ relay: state })));
    should(relay({ state: 'direct-only' })).containEql('! Relay    off — your phone must be on the same network');
    should(relay({ state: 'unknown', reason: 'timed out' })).containEql('! Relay    could not check (timed out)');
  });

  it('should say why the daemon is not running for every action', () => {
    const stopped = inspection({ serving: false });
    const expected: Record<DaemonAction, string> = {
      none: '! Daemon   stopped',
      installed: '! Daemon   stopped',
      started: '! Daemon   stopped',
      'would-install': '! Daemon   not running — setup would install it as a user service',
      'would-start': '! Daemon   not running — setup would start it',
      declined: '! Daemon   not running — you skipped installing it',
      'needs-terminal': '! Daemon   not running — add --yes to install it without questions',
      failed: '! Daemon   did not start: launchctl said no',
    };
    for (const [action, line] of Object.entries(expected)) {
      const problem = action === 'failed' ? 'launchctl said no' : undefined;
      const text = renderSetupSummary(
        summarize(input({ action: action as DaemonAction, problem, inspection: stopped })),
      );
      should(text.split('\n')[0]).equal('Ferretry is not running yet.');
      should(text).containEql(line);
      should(text).not.containEql('Relay');
    }
  });

  it('should list notes as their own rows', () => {
    const text = renderSetupSummary(summarize(input({ clientVersion: '9.9.9' })));
    should(text).containEql('! Note     fy is 9.9.9 but the daemon is 1.2.3.');
  });
});

import { describe, it } from 'bun:test';
import should from 'should';
import {
  livenessOf,
  parseLaunchdPrint,
  parseSystemdProperties,
  readLaunchdReport,
  readSystemdReport,
  servesOutsideSupervisor,
} from '../../../src/lib/daemon/probe';
import { health } from './fixtures';

describe('systemd property parsing', () => {
  it('should read the properties systemctl show emits', () => {
    // Act
    const actual = parseSystemdProperties('LoadState=loaded\nActiveState=active\nMainPID=4242\n');

    // Assert
    should(actual).deepEqual({ loadState: 'loaded', activeState: 'active', mainPid: 4242 });
  });

  it('should keep the whole value when it contains an equals sign', () => {
    // Act — kteam used split('=', 2), which DISCARDS the remainder rather than keeping it.
    const actual = parseSystemdProperties('LoadState=loaded\nActiveState=a=b\n');

    // Assert
    should(actual.activeState).equal('a=b');
  });

  it('should ignore blank lines and lines with no key', () => {
    // Act
    const actual = parseSystemdProperties('\n=orphan\nActiveState=active\n');

    // Assert
    should(actual).deepEqual({ activeState: 'active' });
  });

  it('should reject a main pid systemd uses to mean "none"', () => {
    // Act
    const actual = parseSystemdProperties('ActiveState=inactive\nMainPID=0\n');

    // Assert
    should(actual.mainPid).be.undefined();
  });

  it('should reject a main pid that is not a number', () => {
    // Act
    const actual = parseSystemdProperties('MainPID=nonsense\n');

    // Assert
    should(actual.mainPid).be.undefined();
  });
});

describe('systemd verdicts', () => {
  it('should report a running unit with its pid', () => {
    // Act
    const actual = readSystemdReport({ loadState: 'loaded', activeState: 'active', mainPid: 42 }, true);

    // Assert
    should(actual).deepEqual({ manager: 'systemd', state: 'running', pid: 42, detail: 'systemd reports active' });
  });

  it('should treat a unit still activating as up, because Type=simple already has a process', () => {
    // Act
    const actual = readSystemdReport({ activeState: 'activating' }, true);

    // Assert
    should(actual.state).equal('running');
  });

  it('should treat a reloading unit as up', () => {
    // Act
    const actual = readSystemdReport({ activeState: 'reloading' }, true);

    // Assert
    should(actual.state).equal('running');
  });

  it('should report a failed unit as failed, so a readiness wait can stop early', () => {
    // Act
    const actual = readSystemdReport({ activeState: 'failed' }, true);

    // Assert
    should(actual.state).equal('failed');
  });

  it('should report an inactive unit as stopped', () => {
    // Act
    const actual = readSystemdReport({ activeState: 'inactive' }, true);

    // Assert
    should(actual.state).equal('stopped');
  });

  it('should report an unloaded unit as absent', () => {
    // Act
    const actual = readSystemdReport({ loadState: 'not-found' }, false);

    // Assert
    should(actual.state).equal('absent');
    should(actual.detail).equal('no systemd user unit is installed');
  });

  it('should report absent when systemd said nothing and no definition exists', () => {
    // Act
    const actual = readSystemdReport({}, false);

    // Assert
    should(actual.state).equal('absent');
  });

  it('should report stopped, not absent, when a definition exists but systemd said nothing', () => {
    // Act
    const actual = readSystemdReport({}, true);

    // Assert
    should(actual.state).equal('stopped');
    should(actual.detail).equal('systemd reports nothing');
  });
});

const printed = `com.ferretry.fyd = {
	active count = 1
	state = running
	pid = 4242
	last exit status = 0
}`;

describe('launchd print parsing', () => {
  it('should read the fields out of the indented block', () => {
    // Act
    const actual = parseLaunchdPrint(printed);

    // Assert
    should(actual).deepEqual({ state: 'running', pid: 4242, lastExitStatus: 0 });
  });

  it('should find nothing in output that has no fields', () => {
    // Act
    const actual = parseLaunchdPrint('Could not find service');

    // Assert
    should(actual).deepEqual({});
  });

  it('should reject a pid launchd uses to mean "none"', () => {
    // Act
    const actual = parseLaunchdPrint('\tstate = waiting\n\tpid = 0\n');

    // Assert
    should(actual.pid).be.undefined();
    should(actual.state).equal('waiting');
  });
});

describe('launchd verdicts', () => {
  it('should report a running job with its pid', () => {
    // Act
    const actual = readLaunchdReport({ state: 'running', pid: 4242, lastExitStatus: 0 }, true);

    // Assert
    should(actual).deepEqual({ manager: 'launchd', state: 'running', pid: 4242, detail: 'launchd reports running' });
  });

  it('should NOT call a crash-looping job running just because launchctl exited zero', () => {
    // Act — this is the kteam bug: `launchctl print` succeeds for a loaded-but-dead job.
    const actual = readLaunchdReport({ state: 'waiting', lastExitStatus: 1 }, true);

    // Assert
    should(actual.state).equal('failed');
    should(actual.detail).equal('launchd reports waiting; last exit status 1');
  });

  it('should report a cleanly-exited loaded job as stopped', () => {
    // Act
    const actual = readLaunchdReport({ state: 'not running', lastExitStatus: 0 }, true);

    // Assert
    should(actual.state).equal('stopped');
  });

  it('should report an unloaded job with no plist as absent', () => {
    // Act
    const actual = readLaunchdReport({}, false);

    // Assert
    should(actual.state).equal('absent');
    should(actual.detail).equal('no launchd user agent is installed');
  });

  it('should report a plist that exists but is not bootstrapped as stopped', () => {
    // Act
    const actual = readLaunchdReport({}, true);

    // Assert
    should(actual.state).equal('stopped');
    should(actual.detail).equal('launchd reports nothing');
  });
});

describe('liveness mapping', () => {
  it('should translate each supervisor verdict into what a readiness wait needs', () => {
    // Act + Assert
    should(livenessOf({ manager: 'systemd', state: 'running' })).equal('alive');
    should(livenessOf({ manager: 'systemd', state: 'failed' })).equal('dead');
    should(livenessOf({ manager: 'systemd', state: 'stopped' })).equal('absent');
    should(livenessOf({ manager: 'direct', state: 'absent' })).equal('absent');
  });
});

describe('serving outside the service manager', () => {
  it('should call a daemon the manager reports as its own running pid supervised', () => {
    // Act + Assert
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'running', pid: 4242 }, health())).be.false();
  });

  it('should call a daemon serving while the unit has failed an orphan — the production state', () => {
    // Act + Assert — systemd gave up on exit 78 because this very daemon held the lock.
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'failed' }, health({ pid: 31337 }))).be.true();
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'stopped' }, health())).be.true();
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'absent' }, health())).be.true();
  });

  it('should call a daemon whose pid is not the one the manager runs an orphan', () => {
    // Act + Assert — launchd's KeepAlive respawn can be running while a stray still answers.
    should(
      servesOutsideSupervisor({ manager: 'launchd', state: 'running', pid: 4242 }, health({ pid: 31337 })),
    ).be.true();
  });

  it('should believe a running manager that names no pid, and never judge a direct child or a silent API', () => {
    // Act + Assert
    should(servesOutsideSupervisor({ manager: 'launchd', state: 'running' }, health())).be.false();
    should(servesOutsideSupervisor({ manager: 'direct', state: 'absent' }, health())).be.false();
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'failed' }, undefined)).be.false();
  });
});

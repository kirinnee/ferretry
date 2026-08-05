import { describe, it } from 'bun:test';
import should from 'should';
import {
  DirectSupervisor,
  LaunchdSupervisor,
  ServiceManagerCommandError,
  SystemdSupervisor,
  UnsupportedServiceManagerError,
} from '../../../src/lib/daemon/supervisor';
import { type CommandScript, daemonSnapshot, FakeFiles, FakeProcesses, FakeStateHomeClaim, layout } from './fixtures';

const linux = layout();
const mac = layout({ platform: 'darwin', userId: 501 });
const artifact = daemonSnapshot();
const promotedPointer = `${linux.snapshotRoot}/current`;

function systemd(script: CommandScript = []): {
  supervisor: SystemdSupervisor;
  processes: FakeProcesses;
  files: FakeFiles;
  claims: FakeStateHomeClaim;
} {
  const processes = new FakeProcesses(script);
  const files = new FakeFiles();
  const claims = new FakeStateHomeClaim(files.trail);
  return { supervisor: new SystemdSupervisor(linux, processes, files, claims), processes, files, claims };
}

function launchd(script: CommandScript = []): {
  supervisor: LaunchdSupervisor;
  processes: FakeProcesses;
  files: FakeFiles;
  claims: FakeStateHomeClaim;
} {
  const processes = new FakeProcesses(script);
  const files = new FakeFiles();
  const claims = new FakeStateHomeClaim(files.trail);
  return { supervisor: new LaunchdSupervisor(mac, processes, files, claims), processes, files, claims };
}

describe('systemd supervisor install', () => {
  it('should write the unit, then reload, enable and restart in that order', async () => {
    // Arrange
    const { supervisor, processes, files } = systemd();

    // Act
    await supervisor.install(artifact.binaryPath);

    // Assert
    should(files.written.get(linux.systemdUnitFile)).containEql(`ExecStart="${artifact.binaryPath}"`);
    should(files.written.get(linux.systemdUnitFile)).not.containEql(`ExecStart="${promotedPointer}"`);
    should(processes.ran).deepEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable fyd.service',
      'systemctl --user restart fyd.service',
    ]);
  });

  it('should create both the unit directory and the log directory first', async () => {
    // Arrange
    const { supervisor, files } = systemd();

    // Act
    await supervisor.install(artifact.binaryPath);

    // Assert
    should(files.directories).deepEqual([`${linux.systemdUnitFile.replace('/fyd.service', '')}`, linux.logDirectory]);
  });

  it('should claim the state home BEFORE creating the log directory inside it', async () => {
    // Arrange — the ordering is the whole defect. `<state home>/logs` is the first thing this CLI
    // puts inside the daemon's home, and creating it before the home is claimed is what left the
    // daemon meeting a non-empty unmarked home and refusing to boot.
    const { supervisor, files, claims } = systemd();

    // Act
    await supervisor.install(artifact.binaryPath);

    // Assert
    should(claims.claimed).deepEqual([linux.stateHome]);
    should(files.trail.indexOf(`claim:${linux.stateHome}`)).be.below(
      files.trail.indexOf(`mkdir:${linux.logDirectory}`),
    );
  });

  it('should not create anything inside a state home the claim refused', async () => {
    // Arrange — a refusal has to stop the write, not merely be reported alongside it.
    const { supervisor, files, claims } = systemd();
    claims.refusal = new Error('refusing to write into /tmp/fy-home/.ferretry');

    // Act + Assert
    await should(supervisor.install(artifact.binaryPath)).be.rejectedWith(/refusing to write into/u);
    should(files.directories).not.containEql(linux.logDirectory);
  });

  it('should surface what systemctl said when a step fails', async () => {
    // Arrange
    const { supervisor } = systemd([['enable', { code: 1, stdout: '', stderr: 'Failed to enable unit\n' }]]);

    // Act + Assert
    await should(supervisor.install(artifact.binaryPath)).be.rejectedWith(/Failed to enable unit/u);
  });

  it('should still name the command when systemctl failed silently', async () => {
    // Arrange
    const { supervisor } = systemd([['daemon-reload', { code: 1, stdout: '', stderr: '   ' }]]);

    // Act
    let caught: unknown;
    try {
      await supervisor.install(artifact.binaryPath);
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(ServiceManagerCommandError);
    should((caught as Error).message).equal('systemctl --user daemon-reload failed');
  });
});

describe('service definition paths', () => {
  it('should name the file each manager actually reads, so `install` can report it', () => {
    // Act + Assert — the supervisor owns this, so `install` needs no fallback for a path it cannot have.
    should(systemd().supervisor.definitionPath).equal(linux.systemdUnitFile);
    should(launchd().supervisor.definitionPath).equal(mac.launchAgentFile);
  });
});

describe('systemd supervisor lifecycle', () => {
  it('should report the unit installed exactly when its file is on disk', async () => {
    // Arrange
    const { supervisor, files } = systemd();

    // Act + Assert
    should(await supervisor.installed()).be.false();
    files.present.add(linux.systemdUnitFile);
    should(await supervisor.installed()).be.true();
  });

  it('should start through systemctl, which is already idempotent', async () => {
    // Arrange
    const { supervisor, processes, files } = systemd();

    // Act
    const actual = await supervisor.start(artifact.binaryPath);

    // Assert
    should(processes.ran).containEql('systemctl --user start fyd.service');
    should(files.written.get(linux.systemdUnitFile)).containEql(`ExecStart="${artifact.binaryPath}"`);
    should(actual.pid).be.undefined();
  });

  it('should stop politely first and escalate to a real kill only when asked', async () => {
    // Arrange
    const { supervisor, processes } = systemd();

    // Act
    await supervisor.stop({ escalate: false });
    await supervisor.stop({ escalate: true });

    // Assert
    should(processes.ran).deepEqual([
      'systemctl --user stop fyd.service',
      'systemctl --user kill --signal=SIGKILL fyd.service',
    ]);
  });

  it('should tolerate a disable that fails because the unit was already gone', async () => {
    // Arrange
    const { supervisor, processes, files } = systemd([
      ['disable', { code: 1, stdout: '', stderr: 'Unit file does not exist' }],
    ]);

    // Act
    await supervisor.uninstall();

    // Assert
    should(files.removed).deepEqual([linux.systemdUnitFile]);
    should(processes.ran).containEql('systemctl --user daemon-reload');
  });

  it('should fail an uninstall whose final reload fails, because the manager is then inconsistent', async () => {
    // Arrange
    const { supervisor } = systemd([['daemon-reload', { code: 1, stdout: '', stderr: 'dbus unavailable' }]]);

    // Act + Assert
    await should(supervisor.uninstall()).be.rejectedWith(/dbus unavailable/u);
  });
});

describe('systemd supervisor inspection', () => {
  it('should read the unit state out of systemctl show', async () => {
    // Arrange
    const { supervisor, files } = systemd([
      ['show', { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nMainPID=4242\n', stderr: '' }],
    ]);
    files.present.add(linux.systemdUnitFile);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual).deepEqual({ manager: 'systemd', state: 'running', pid: 4242, detail: 'systemd reports active' });
  });

  it('should report stopped when systemctl itself failed but a unit file exists', async () => {
    // Arrange
    const { supervisor, files } = systemd([['show', { code: 1, stdout: '', stderr: 'no dbus session\n' }]]);
    files.present.add(linux.systemdUnitFile);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual).deepEqual({ manager: 'systemd', state: 'stopped', detail: 'no dbus session' });
  });

  it('should report absent when systemctl failed and nothing is installed', async () => {
    // Arrange
    const { supervisor } = systemd([['show', { code: 127, stdout: '', stderr: 'systemctl: not found' }]]);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual.state).equal('absent');
  });
});

describe('launchd supervisor install', () => {
  it('should claim the state home before creating the log directory inside it', async () => {
    // Arrange — macOS takes this path, so the claim has to be on all three supervisors rather than
    // only the one whose platform the author happened to be running.
    const { supervisor, files, claims } = launchd();

    // Act
    await supervisor.install(artifact.binaryPath);

    // Assert
    should(claims.claimed).deepEqual([mac.stateHome]);
    should(files.trail.indexOf(`claim:${mac.stateHome}`)).be.below(files.trail.indexOf(`mkdir:${mac.logDirectory}`));
  });

  it('should write the plist, boot out any stale job, then bootstrap the domain', async () => {
    // Arrange
    const { supervisor, processes, files } = launchd();

    // Act
    await supervisor.install(artifact.binaryPath);

    // Assert
    should(files.written.get(mac.launchAgentFile)).containEql('<key>Label</key><string>com.ferretry.fyd</string>');
    should(files.written.get(mac.launchAgentFile)).containEql(`<string>${artifact.binaryPath}</string>`);
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      `launchctl bootstrap gui/501 ${mac.launchAgentFile}`,
    ]);
  });

  it('should ignore a bootout that fails because nothing was loaded', async () => {
    // Arrange
    const { supervisor } = launchd([['bootout', { code: 3, stdout: '', stderr: 'No such process' }]]);

    // Act + Assert — an unloaded job cannot be booted out, so this must not abort the install.
    await should(supervisor.install(artifact.binaryPath)).be.fulfilled();
  });

  it('should surface a bootstrap failure', async () => {
    // Arrange
    const { supervisor } = launchd([['bootstrap', { code: 5, stdout: '', stderr: 'Input/output error' }]]);

    // Act + Assert
    await should(supervisor.install(artifact.binaryPath)).be.rejectedWith(/Input\/output error/u);
  });
});

describe('launchd supervisor start', () => {
  it('should reload a cached legacy job after writing the exact snapshot arguments', async () => {
    // Arrange — launchd keeps the ProgramArguments loaded at bootstrap even after the plist changes.
    const { supervisor, processes, files } = launchd();

    // Act
    await supervisor.start(artifact.binaryPath);

    // Assert
    should(files.written.get(mac.launchAgentFile)).containEql(`<string>${artifact.binaryPath}</string>`);
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      `launchctl bootstrap gui/501 ${mac.launchAgentFile}`,
    ]);
    should(processes.ran.join(' ')).not.containEql('kickstart');
  });

  it('should tolerate bootout when no cached job is loaded, then bootstrap the new definition', async () => {
    // Arrange
    const { supervisor, processes } = launchd([['bootout', { code: 3, stdout: '', stderr: 'No such process' }]]);

    // Act
    await supervisor.start(artifact.binaryPath);

    // Assert
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      `launchctl bootstrap gui/501 ${mac.launchAgentFile}`,
    ]);
  });
});

describe('launchd supervisor stop and inspection', () => {
  it('should boot the job out politely and kill it only on escalation', async () => {
    // Arrange
    const { supervisor, processes } = launchd();

    // Act
    await supervisor.stop({ escalate: false });
    await supervisor.stop({ escalate: true });

    // Assert
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      'launchctl kill SIGKILL gui/501/com.ferretry.fyd',
    ]);
  });

  it('should remove the plist on uninstall even when the job was not loaded', async () => {
    // Arrange
    const { supervisor, files } = launchd([['bootout', { code: 3, stdout: '', stderr: 'No such process' }]]);

    // Act
    await supervisor.uninstall();

    // Assert
    should(files.removed).deepEqual([mac.launchAgentFile]);
  });

  it('should read the job state rather than trusting launchctl exit zero', async () => {
    // Arrange
    const { supervisor, files } = launchd([
      ['print', { code: 0, stdout: '\tstate = waiting\n\tlast exit status = 1\n', stderr: '' }],
    ]);
    files.present.add(mac.launchAgentFile);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual.state).equal('failed');
  });

  it('should report stopped when launchctl failed but the plist is installed', async () => {
    // Arrange
    const { supervisor, files } = launchd([['print', { code: 113, stdout: '', stderr: 'Could not find service\n' }]]);
    files.present.add(mac.launchAgentFile);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual).deepEqual({ manager: 'launchd', state: 'stopped', detail: 'Could not find service' });
  });

  it('should report absent when launchctl failed and no plist exists', async () => {
    // Arrange
    const { supervisor } = launchd([['print', { code: 113, stdout: '', stderr: '' }]]);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual.state).equal('absent');
  });

  it('should report the plist installed exactly when it is on disk', async () => {
    // Arrange
    const { supervisor, files } = launchd();

    // Act + Assert
    should(await supervisor.installed()).be.false();
    files.present.add(mac.launchAgentFile);
    should(await supervisor.installed()).be.true();
  });
});

describe('direct supervisor', () => {
  function direct(): {
    supervisor: DirectSupervisor;
    processes: FakeProcesses;
    files: FakeFiles;
    claims: FakeStateHomeClaim;
  } {
    const processes = new FakeProcesses();
    const files = new FakeFiles();
    const claims = new FakeStateHomeClaim(files.trail);
    return { supervisor: new DirectSupervisor(linux, processes, files, claims), processes, files, claims };
  }

  it('should never claim a service definition is installed', async () => {
    // Act + Assert
    should(await direct().supervisor.installed()).be.false();
  });

  it('should claim the state home before spawning the daemon into it', async () => {
    // Arrange — the direct spawn is the path a host with no service manager takes, so it is the one
    // an operator on such a host meets first.
    const { supervisor, files, claims } = direct();

    // Act
    await supervisor.start(artifact.binaryPath);

    // Assert
    should(claims.claimed).deepEqual([linux.stateHome]);
    should(files.trail.indexOf(`claim:${linux.stateHome}`)).be.below(
      files.trail.indexOf(`mkdir:${linux.logDirectory}`),
    );
  });

  it('should not spawn the daemon at all when the claim refused the home', async () => {
    // Arrange — launching into a home we would not write to would produce a daemon that immediately
    // refuses the same directory, reporting the failure one layer further from its cause.
    const { supervisor, processes, claims } = direct();
    claims.refusal = new Error('refusing to write into /tmp/fy-home/.ferretry');

    // Act + Assert
    await should(supervisor.start(artifact.binaryPath)).be.rejectedWith(/refusing to write into/u);
    should(processes.launched).be.empty();
  });

  it('should refuse install and uninstall, because there is nothing to install into', async () => {
    // Arrange
    const { supervisor } = direct();

    // Act + Assert
    await should(supervisor.install(artifact.binaryPath)).be.rejectedWith(UnsupportedServiceManagerError);
    await should(supervisor.uninstall()).be.rejectedWith(/systemd user services on Linux/u);
  });

  it('should launch the daemon detached with only FY_HOME and PATH in its environment', async () => {
    // Arrange
    const { supervisor, processes, files } = direct();

    // Act
    const actual = await supervisor.start(artifact.binaryPath);

    // Assert
    should(files.directories).deepEqual([linux.logDirectory]);
    should(processes.launched).have.length(1);
    should(processes.launched[0]?.argv).deepEqual([artifact.binaryPath]);
    should(processes.launched[0]?.argv).not.deepEqual([promotedPointer]);
    should(processes.launched[0]?.environment).deepEqual({ FY_HOME: linux.stateHome, PATH: linux.searchPath });
    should(processes.launched[0]?.logFile).equal(linux.logFile);
    should(actual.pid).equal(9001);
  });

  it('should signal only the pid the daemon reported for itself', async () => {
    // Arrange
    const { supervisor, processes } = direct();
    processes.livePids.add(4242);

    // Act
    await supervisor.stop({ pidHint: 4242, escalate: false });

    // Assert — kteam read a pid file, so a stale entry could get an unrelated process killed.
    should(processes.signalled).deepEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  });

  it('should escalate to SIGKILL when asked', async () => {
    // Arrange
    const { supervisor, processes } = direct();

    // Act
    await supervisor.stop({ pidHint: 77, escalate: true });

    // Assert
    should(processes.signalled).deepEqual([{ pid: 77, signal: 'SIGKILL' }]);
  });

  it('should signal nothing when it has no pid to signal', async () => {
    // Arrange
    const { supervisor, processes } = direct();

    // Act
    await supervisor.stop({ escalate: false });

    // Assert
    should(processes.signalled).be.empty();
  });

  it('should have no opinion without a process to watch', async () => {
    // Act
    const actual = await direct().supervisor.inspect();

    // Assert
    should(actual).deepEqual({
      manager: 'direct',
      state: 'absent',
      detail: 'no service manager owns the daemon on this host',
    });
  });

  it('should report the watched process running while it exists', async () => {
    // Arrange
    const { supervisor, processes } = direct();
    processes.livePids.add(555);

    // Act
    const actual = await supervisor.inspect({ pid: 555 });

    // Assert
    should(actual.state).equal('running');
    should(actual.pid).equal(555);
  });

  it('should report the watched process failed once it is gone', async () => {
    // Arrange
    const { supervisor } = direct();

    // Act
    const actual = await supervisor.inspect({ pid: 555 });

    // Assert — this is the fast-fail a readiness wait needs, without any pid file.
    should(actual.state).equal('failed');
    should(actual.detail).equal('the process this command started has exited');
  });
});

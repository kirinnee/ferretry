import { describe, it } from 'bun:test';
import should from 'should';
import {
  DaemonOwnershipError,
  DirectSupervisor,
  LaunchdSupervisor,
  ServiceManagerCommandError,
  SystemdSupervisor,
  UnsupportedServiceManagerError,
} from '../../../src/lib/daemon/supervisor';
import { type CommandScript, FakeFiles, FakeProcesses, FakeStateHomeClaim, installedDaemon, layout } from './fixtures';

const linux = layout();
const mac = layout({ platform: 'darwin', userId: 501 });
const daemonBinary = installedDaemon();
const retiredPointer = `${linux.legacySnapshotRoot}/current`;

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

describe('the engine options every launch path hands the daemon', () => {
  it('should write the stack sampler period into the systemd unit and the launchd plist alike', async () => {
    // Arrange — JavaScriptCore reads it once at VM start, so the definition is the only place it works.
    const linuxHost = systemd();
    const macHost = launchd();

    // Act
    await linuxHost.supervisor.install(daemonBinary.path);
    await macHost.supervisor.install(daemonBinary.path);

    // Assert
    should(linuxHost.files.written.get(linux.systemdUnitFile)).containEql('Environment="BUN_JSC_sampleInterval=10000"');
    should(macHost.files.written.get(mac.launchAgentFile)).containEql(
      '<key>BUN_JSC_sampleInterval</key><string>10000</string>',
    );
    should(linuxHost.files.written.get(linux.systemdUnitFile)).containEql('Environment="BUN_JSC_numberOfGCMarkers=2"');
    should(macHost.files.written.get(mac.launchAgentFile)).containEql(
      '<key>BUN_JSC_numberOfGCMarkers</key><string>2</string>',
    );
  });
});

describe('systemd supervisor install', () => {
  it('should write the unit, then reload, enable and restart in that order', async () => {
    // Arrange
    const { supervisor, processes, files } = systemd();

    // Act
    await supervisor.install(daemonBinary.path);

    // Assert
    should(files.written.get(linux.systemdUnitFile)).containEql(`ExecStart="${daemonBinary.path}"`);
    should(files.written.get(linux.systemdUnitFile)).not.containEql(`ExecStart="${retiredPointer}"`);
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
    await supervisor.install(daemonBinary.path);

    // Assert
    should(files.directories).deepEqual([`${linux.systemdUnitFile.replace('/fyd.service', '')}`, linux.logDirectory]);
  });

  it('should claim the state home BEFORE creating the log directory inside it', async () => {
    // Arrange — the ordering is the whole defect. `<state home>/logs` is the first thing this CLI
    // puts inside the daemon's home, and creating it before the home is claimed is what left the
    // daemon meeting a non-empty unmarked home and refusing to boot.
    const { supervisor, files, claims } = systemd();

    // Act
    await supervisor.install(daemonBinary.path);

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
    await should(supervisor.install(daemonBinary.path)).be.rejectedWith(/refusing to write into/u);
    should(files.directories).not.containEql(linux.logDirectory);
  });

  it('should surface what systemctl said when a step fails', async () => {
    // Arrange
    const { supervisor } = systemd([['enable', { code: 1, stdout: '', stderr: 'Failed to enable unit\n' }]]);

    // Act + Assert
    await should(supervisor.install(daemonBinary.path)).be.rejectedWith(/Failed to enable unit/u);
  });

  it('should still name the command when systemctl failed silently', async () => {
    // Arrange
    const { supervisor } = systemd([['daemon-reload', { code: 1, stdout: '', stderr: '   ' }]]);

    // Act
    let caught: unknown;
    try {
      await supervisor.install(daemonBinary.path);
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
    const actual = await supervisor.start(daemonBinary.path);

    // Assert
    should(processes.ran).containEql('systemctl --user start fyd.service');
    should(files.written.get(linux.systemdUnitFile)).containEql(`ExecStart="${daemonBinary.path}"`);
    should(actual.pid).be.undefined();
  });

  it('should restart with ONE systemctl restart, after rewriting the unit for the installed daemon', async () => {
    // Arrange — no stop this CLI watches and start it issues, so there is no window with the unit
    // down in which anything else can start a daemon beside it.
    const { supervisor, processes, files } = systemd();

    // Act
    await supervisor.restartInPlace(daemonBinary.path);

    // Assert
    should(files.written.get(linux.systemdUnitFile)).containEql(`ExecStart="${daemonBinary.path}"`);
    should(processes.ran).deepEqual(['systemctl --user daemon-reload', 'systemctl --user restart fyd.service']);
  });

  it('should surface a restart systemctl refused', async () => {
    // Arrange
    const { supervisor } = systemd([['restart', { code: 1, stdout: '', stderr: 'Job failed' }]]);

    // Act + Assert
    await should(supervisor.restartInPlace(daemonBinary.path)).be.rejectedWith(ServiceManagerCommandError);
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
    await supervisor.install(daemonBinary.path);

    // Assert
    should(claims.claimed).deepEqual([mac.stateHome]);
    should(files.trail.indexOf(`claim:${mac.stateHome}`)).be.below(files.trail.indexOf(`mkdir:${mac.logDirectory}`));
  });

  it('should write the plist, boot out any stale job, then bootstrap the domain', async () => {
    // Arrange
    const { supervisor, processes, files } = launchd();

    // Act
    await supervisor.install(daemonBinary.path);

    // Assert
    should(files.written.get(mac.launchAgentFile)).containEql('<key>Label</key><string>com.ferretry.fyd</string>');
    should(files.written.get(mac.launchAgentFile)).containEql(`<string>${daemonBinary.path}</string>`);
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      `launchctl bootstrap gui/501 ${mac.launchAgentFile}`,
    ]);
  });

  it('should ignore a bootout that fails because nothing was loaded', async () => {
    // Arrange
    const { supervisor } = launchd([['bootout', { code: 3, stdout: '', stderr: 'No such process' }]]);

    // Act + Assert — an unloaded job cannot be booted out, so this must not abort the install.
    await should(supervisor.install(daemonBinary.path)).be.fulfilled();
  });

  it('should surface a bootstrap failure', async () => {
    // Arrange
    const { supervisor } = launchd([['bootstrap', { code: 5, stdout: '', stderr: 'Input/output error' }]]);

    // Act + Assert
    await should(supervisor.install(daemonBinary.path)).be.rejectedWith(/Input\/output error/u);
  });
});

describe('launchd supervisor start', () => {
  it('should reload a cached legacy job after writing the exact snapshot arguments', async () => {
    // Arrange — launchd keeps the ProgramArguments loaded at bootstrap even after the plist changes.
    const { supervisor, processes, files } = launchd();

    // Act
    await supervisor.start(daemonBinary.path);

    // Assert
    should(files.written.get(mac.launchAgentFile)).containEql(`<string>${daemonBinary.path}</string>`);
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
    await supervisor.start(daemonBinary.path);

    // Assert
    should(processes.ran).deepEqual([
      'launchctl bootout gui/501/com.ferretry.fyd',
      `launchctl bootstrap gui/501 ${mac.launchAgentFile}`,
    ]);
  });
});

describe('launchd supervisor stop and inspection', () => {
  it('should offer no one-command restart, because launchd caches ProgramArguments at bootstrap', () => {
    // Arrange
    const { supervisor } = launchd();

    // Act
    const actual = 'restartInPlace' in supervisor;

    // Assert
    should(actual).be.false();
  });

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

  it('should report the ProcessType the installed plist declares, read from the plist itself', async () => {
    // Arrange
    const { supervisor } = launchd([['print', { code: 0, stdout: '\tstate = running\n\tpid = 812\n', stderr: '' }]]);
    await supervisor.install(daemonBinary.path);

    // Act
    const actual = await supervisor.inspect();

    // Assert
    should(actual).match({ manager: 'launchd', state: 'running', pid: 812, processType: 'Interactive' });
  });

  it('should report null for a plist an older client wrote with no ProcessType, running or not', async () => {
    // Arrange
    const old = '<plist><dict><key>Label</key><string>com.ferretry.fyd</string></dict></plist>';
    const up = launchd([['print', { code: 0, stdout: '\tstate = running\n\tpid = 812\n', stderr: '' }]]);
    const down = launchd([['print', { code: 113, stdout: '', stderr: 'Could not find service\n' }]]);
    up.files.written.set(mac.launchAgentFile, old);
    down.files.written.set(mac.launchAgentFile, old);

    // Act
    const running = await up.supervisor.inspect();
    const stopped = await down.supervisor.inspect();

    // Assert
    should(running.processType).be.null();
    should(stopped).match({ state: 'stopped', processType: null });
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
    await supervisor.start(daemonBinary.path);

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
    await should(supervisor.start(daemonBinary.path)).be.rejectedWith(/refusing to write into/u);
    should(processes.launched).be.empty();
  });

  it('should refuse install and uninstall, because there is nothing to install into', async () => {
    // Arrange
    const { supervisor } = direct();

    // Act + Assert
    await should(supervisor.install(daemonBinary.path)).be.rejectedWith(UnsupportedServiceManagerError);
    await should(supervisor.uninstall()).be.rejectedWith(/systemd user services on Linux/u);
  });

  it('should launch the daemon detached with only FY_HOME, HOME, PATH, a UTF-8 locale and its engine options', async () => {
    // Arrange
    const { supervisor, processes, files } = direct();

    // Act
    const actual = await supervisor.start(daemonBinary.path);

    // Assert
    should(files.directories).deepEqual([linux.logDirectory]);
    should(processes.launched).have.length(1);
    should(processes.launched[0]?.argv).deepEqual([daemonBinary.path]);
    should(processes.launched[0]?.argv).not.deepEqual([retiredPointer]);
    should(processes.launched[0]?.environment).deepEqual({
      FY_HOME: linux.stateHome,
      HOME: linux.homeDirectory,
      PATH: linux.searchPath,
      LANG: 'C.UTF-8',
      BUN_JSC_sampleInterval: '10000',
      BUN_JSC_numberOfGCMarkers: '2',
    });
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

describe('direct supervisor refuses a pid it cannot tie to this state home', () => {
  function direct(): { supervisor: DirectSupervisor; processes: FakeProcesses } {
    const processes = new FakeProcesses();
    const files = new FakeFiles();
    return { supervisor: new DirectSupervisor(linux, processes, files, new FakeStateHomeClaim()), processes };
  }

  it('should send nothing to a pid that does not hold this state home lock', async () => {
    // Arrange — the pid came over HTTP from whatever answered: a forwarded container port reports a
    // pid from ITS namespace, which names some unrelated process on this host.
    const { supervisor, processes } = direct();
    processes.holdsOpenAnswer = false;

    // Act + Assert
    await should(supervisor.stop({ pidHint: 4242, escalate: false })).be.rejectedWith(DaemonOwnershipError);
    await should(supervisor.stop({ pidHint: 4242, escalate: true })).be.rejectedWith(
      /does not hold .*daemon\.lock.*nothing was signalled/u,
    );
    should(processes.signalled).be.empty();
  });

  it('should send nothing, and say what to do instead, when this host cannot tell', async () => {
    // Arrange
    const { supervisor, processes } = direct();
    processes.holdsOpenAnswer = undefined;

    // Act + Assert
    await should(supervisor.stop({ pidHint: 4242, escalate: false })).be.rejectedWith(
      /neither \/proc nor lsof.*`ps -p 4242`.*`kill 4242` yourself/u,
    );
    should(processes.signalled).be.empty();
  });

  it('should ask about the lock of THIS state home, and signal once it is proved', async () => {
    // Arrange
    const { supervisor, processes } = direct();

    // Act
    await supervisor.stop({ pidHint: 4242, escalate: false });

    // Assert
    should(processes.holdQuestions).deepEqual([{ pid: 4242, path: `${linux.stateHome}/daemon.lock` }]);
    should(processes.signalled).deepEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  });

  it('should have nothing to check when there is no pid', async () => {
    // Arrange
    const { supervisor, processes } = direct();

    // Act
    await supervisor.assertServes(undefined);

    // Assert
    should(processes.holdQuestions).be.empty();
  });
});

describe('service supervisors refuse a definition or daemon belonging to another state home', () => {
  const elsewhere = '/srv/another-ferretry-home';

  it('should refuse when the one systemd unit on this host serves another state home', async () => {
    // Arrange — `fyd.service` is one name per host whatever FY_HOME says, so the primary daemon's
    // unit is what `FY_HOME=/other fy daemon reset` would have stopped.
    const { supervisor, files, processes } = systemd();
    const other = new SystemdSupervisor(layout({ stateHome: elsewhere }), processes, files, new FakeStateHomeClaim());
    await other.install(daemonBinary.path);

    // Act + Assert
    await should(supervisor.assertServes(undefined)).be.rejectedWith(DaemonOwnershipError);
    await should(supervisor.assertServes(undefined)).be.rejectedWith(
      new RegExp(`supervises the fyd for ${elsewhere}, not ${linux.stateHome}.*FY_HOME=${elsewhere}`, 'u'),
    );
  });

  it('should accept the unit it would write itself, and no unit at all', async () => {
    // Arrange
    const { supervisor, processes } = systemd();
    await supervisor.assertServes(undefined);
    await supervisor.install(daemonBinary.path);

    // Act
    await supervisor.assertServes(4242);

    // Assert — a service manager stops its own unit, so it asks about the pid but never signals it.
    should(processes.holdQuestions).deepEqual([{ pid: 4242, path: `${linux.stateHome}/daemon.lock` }]);
    should(processes.signalled).be.empty();
  });

  it('should refuse a unit that names no state home rather than guess which it serves', async () => {
    // Arrange
    const { supervisor, files } = systemd();
    await files.writePrivate(linux.systemdUnitFile, '[Service]\nExecStart=/usr/bin/fyd\n');

    // Act + Assert
    await should(supervisor.assertServes(undefined)).be.rejectedWith(/names no FY_HOME/u);
  });

  it('should refuse a daemon that answered but provably serves another state home', async () => {
    // Arrange
    const { supervisor, processes } = systemd();
    await supervisor.install(daemonBinary.path);
    processes.holdsOpenAnswer = false;

    // Act + Assert
    await should(supervisor.assertServes(4242)).be.rejectedWith(/not this state home's fyd/u);
  });

  it('should let the unit stop its own daemon on a host that cannot tell', async () => {
    // Arrange — no pid is ever signalled on this path, so an unanswerable question costs nothing.
    const { supervisor, processes } = systemd();
    await supervisor.install(daemonBinary.path);
    processes.holdsOpenAnswer = undefined;

    // Act + Assert
    await should(supervisor.assertServes(4242)).be.fulfilled();
  });

  it('should refuse when the one launchd agent on this host serves another state home', async () => {
    // Arrange
    const { supervisor, files, processes } = launchd();
    const other = new LaunchdSupervisor(
      layout({ platform: 'darwin', userId: 501, stateHome: elsewhere }),
      processes,
      files,
      new FakeStateHomeClaim(),
    );
    await other.install(daemonBinary.path);

    // Act + Assert
    await should(supervisor.assertServes(undefined)).be.rejectedWith(
      new RegExp(`supervises the fyd for ${elsewhere}`, 'u'),
    );
  });

  it('should accept the launchd agent it would write itself and check the pid it was given', async () => {
    // Arrange
    const { supervisor, processes } = launchd();
    await supervisor.install(daemonBinary.path);
    processes.holdsOpenAnswer = false;

    // Act + Assert
    await supervisor.assertServes(undefined);
    await should(supervisor.assertServes(4242)).be.rejectedWith(DaemonOwnershipError);
  });
});

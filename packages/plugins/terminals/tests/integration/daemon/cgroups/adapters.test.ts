import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIBIBYTE } from '../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import {
  activeScheduler,
  CGROUP_COMMAND_TIMEOUT_CODE,
  CgroupFleetMemory,
  CgroupServiceWeights,
  DEFAULT_CGROUP_COMMAND_TIMEOUT_MS,
  deviceOfPath,
  FileLegacyCgroupDocuments,
  FileSessionSpawnFacts,
  hostCgroupFacts,
  PaneSessionMemory,
  ProcCgroupPlacements,
  RegisteredCgroupPaneLedger,
  SpawnCgroupCommands,
  SysfsDiskScheduler,
  unmeasuredHostFacts,
} from '../../../../daemon/adapters/cgroups/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { ferretSliceName, runCgroupCommand } from '../../../../daemon/lib/cgroups/index.ts';
import {
  createFoundationPaths,
  createSessionPaths,
  type FoundationPaths,
  resolveStateHome,
} from '../../../src/lib/index.ts';
import type { RegisteredTerminalPane } from '../../../src/lib/session/reap.ts';
import type { RegisteredPaneObserver } from '../../../src/lib/session/reap-service.ts';

/**
 * The adapters behind ferret limits, against a real throwaway state home, a real `/proc`- and
 * `/sys`-shaped tree and real child processes.
 *
 * NOTHING HERE TOUCHES A REAL STATE HOME, a real host manager, or the network. The one command
 * runner test spawns `/bin/echo` and `/bin/false`, which are the two outcomes the domain branches
 * on and neither of which changes anything on this machine.
 */

async function stateHome(label: string): Promise<{ readonly paths: FoundationPaths; readonly files: StateFileSystem }> {
  const home = await mkdtemp(join(tmpdir(), `ferretry-${label}-`));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return { paths, files: new StateFileSystem(paths) };
}

describe('one session own spawn record', () => {
  const write = async (paths: FoundationPaths, id: string, document: unknown): Promise<void> => {
    const directory = createSessionPaths(paths, id as never).directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(document));
  };

  it('should read the three durable markers exclusion is decided from', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    await write(paths, 'agent-1', {
      id: 'agent-1',
      label: 'fleet-warden',
      parent: 'agent-0',
      wardenLineage: true,
      name: 'ignored',
    });

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-1')).deepEqual({
      label: 'fleet-warden',
      parent: 'agent-0',
      wardenLineage: true,
    });
  });

  it('should read the parent link off a document shaped like the one a real start writes', async () => {
    // Arrange — the exact field set the composition root persists for a spawned teammate: a parent
    // and no lineage stamp, because nothing in this daemon writes one. The parent walk is therefore
    // the only mechanism that can prove descent on a real host.
    const { paths, files } = await stateHome('cgroup-facts');
    await write(paths, 'agent-child', { id: 'agent-child', name: 'Teammate', mode: 'auto', parent: 'agent-warden' });

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-child')).deepEqual({ parent: 'agent-warden' });
  });

  it('should know a ferret a person is at, so it gets the heavier CPU weight', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    await write(paths, 'agent-mine', { id: 'agent-mine', mode: 'interactive' });

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-mine')).deepEqual({ interactive: true });
  });

  it('should answer with an empty record for an ordinary session that carries neither marker', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    await write(paths, 'agent-2', { id: 'agent-2', name: 'ordinary' });

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-2')).deepEqual({});
  });

  it('should drop a marker of the wrong type rather than coercing damage into evidence', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    await write(paths, 'agent-3', { label: 7, parent: 12, wardenLineage: 'yes' });

    // Act / Assert — a number is not a label, a number is not a parent, and a string is not descent.
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-3')).deepEqual({});
  });

  it('should answer with nothing for a session that has no document', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-missing')).be.undefined();
  });

  it('should answer with nothing when the document is not JSON', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    const directory = createSessionPaths(paths, 'agent-4' as never).directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), 'nope');

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-4')).be.undefined();
  });

  it('should answer with nothing when the document is JSON but not an object', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');
    const directory = createSessionPaths(paths, 'agent-5' as never).directory;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), '[1,2,3]');

    // Act / Assert
    should(await new FileSessionSpawnFacts(files, paths).facts('agent-5')).be.undefined();
  });

  it('should refuse an id the layout would never accept as a directory', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-facts');

    // Act / Assert — a crafted id must never address a directory outside the session tree.
    should(await new FileSessionSpawnFacts(files, paths).facts('../../etc')).be.undefined();
  });
});

describe('reading where a live process sits', () => {
  it('should hand back the placement verbatim, so the domain reads the real scope name', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-proc-'));
    await mkdir(join(root, '77'), { recursive: true });
    await writeFile(
      join(root, '77', 'cgroup'),
      '0::/user@1000.service/ferretry_fleet.slice/ferretry-agent-s1-ab.scope\n',
    );

    // Act / Assert
    should(await new ProcCgroupPlacements(root).placement(77)).match(/ferretry-agent-s1-ab\.scope/u);
  });

  it('should THROW for a pid it cannot read rather than answering "provably in no scope"', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-proc-'));

    // Act / Assert
    await should(new ProcCgroupPlacements(root).placement(999_999)).be.rejected();
  });

  it('should refuse something that is not a process id at all', async () => {
    // Arrange / Act / Assert
    await should(new ProcCgroupPlacements().placement(0)).be.rejectedWith(/not a process id/u);
  });

  it('should refuse a fractional pid', async () => {
    // Arrange / Act / Assert
    await should(new ProcCgroupPlacements().placement(1.5)).be.rejectedWith(/not a process id/u);
  });

  it('should read this very process placement from the real kernel on a Linux host', async () => {
    // Arrange / Act — the default root, exercised rather than stubbed.
    const placement = await new ProcCgroupPlacements().placement(process.pid).catch(() => undefined);

    // Assert — a non-Linux host has no `/proc/<pid>/cgroup`, and refusing is the correct answer there.
    should(placement === undefined || placement.includes('/')).be.true();
  });
});

describe('running one host-manager command', () => {
  it('should report a command that succeeded, with its output', async () => {
    // Arrange / Act
    const result = await new SpawnCgroupCommands().execute(['/bin/echo', 'configured']);

    // Assert
    should(result.code).equal(0);
    should(result.stdout.trim()).equal('configured');
  });

  it('should report a refusal as a RESULT so the domain can restate it, not as a throw', async () => {
    // Arrange / Act
    const result = await new SpawnCgroupCommands().execute(['/bin/sh', '-c', 'echo nope >&2; exit 3']);

    // Assert
    should(result.code).equal(3);
    should(result.stderr.trim()).equal('nope');
  });

  it('should refuse an empty argv rather than spawning something unspecified', async () => {
    // Arrange / Act / Assert
    await should(new SpawnCgroupCommands().execute([])).be.rejectedWith(/needs an executable/u);
  });

  it('should give up on a manager that never answers, and say so in the manager slot', async () => {
    // Arrange — a real child that would outlive this suite. Both callers run inside the session
    // lifecycle's barrier, so an unbounded wait here stalls every start, stop and resume.
    const subject = new SpawnCgroupCommands({ timeoutMs: 50 });

    // Act
    const result = await subject.execute(['/bin/sh', '-c', 'sleep 30']);

    // Assert — a refusal the domain restates like any other, not a hang and not a throw.
    should(result.code).equal(CGROUP_COMMAND_TIMEOUT_CODE);
    should(result.stderr).match(/did not answer within 50ms and was killed/u);
  });

  it('should not wait for a pipe a grandchild is still holding open', async () => {
    // Arrange — killing a child closes nothing by itself: this one leaves a descendant holding the
    // write end, so a read-to-end-of-stream after the kill would be the same unbounded wait again.
    const subject = new SpawnCgroupCommands({ timeoutMs: 50 });

    // Act
    const result = await subject.execute(['/bin/sh', '-c', 'sleep 30 & sleep 30']);

    // Assert
    should(result.code).equal(CGROUP_COMMAND_TIMEOUT_CODE);
  });

  it('should reach the domain as an actionable refusal rather than as a bare non-zero code', async () => {
    // Arrange
    const subject = new SpawnCgroupCommands({ timeoutMs: 50 });

    // Act / Assert — the taxonomy the route table restates, with the host's problem named in it.
    await should(
      runCgroupCommand(subject, ['/bin/sh', '-c', 'sleep 30'], 'could not configure the fleet slice'),
    ).be.rejectedWith(/is not responding/u);
  });

  it('should default to a bound a healthy manager under load still fits inside', () => {
    // Arrange / Act / Assert
    should(DEFAULT_CGROUP_COMMAND_TIMEOUT_MS).be.greaterThan(1_000);
  });
});

describe('measuring the host', () => {
  async function tree(
    files: Readonly<Record<string, string>>,
  ): Promise<{ cgroupRoot: string; proc: string; systemd: string[] }> {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-host-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return { cgroupRoot: join(root, 'sys'), proc: join(root, 'proc'), systemd: [join(root, 'etc')] };
  }

  const OWN = '/user.slice/user-1000.slice/user@1000.service/app.slice/fyd.service';

  it('should find the user’s memory budget below the machine’s RAM: 48 GiB on a 61 GiB box', async () => {
    // Arrange
    const places = await tree({
      'sys/cgroup.controllers': 'cpu memory pids',
      'proc/self/cgroup': `0::${OWN}\n`,
      'proc/meminfo': 'MemTotal: 63963136 kB\nSwapTotal: 33554428 kB\n',
      'proc/sys/kernel/pid_max': '4194304\n',
      'sys/user.slice/memory.max': 'max\n',
      'sys/user.slice/user-1000.slice/memory.high': `${48 * GIBIBYTE}\n`,
      'sys/user.slice/user-1000.slice/memory.max': 'max\n',
    });

    // Act
    const facts = await hostCgroupFacts({ platform: 'linux', cpus: 32, physicalBytes: 61 * GIBIBYTE }, places);

    // Assert
    should(facts.unifiedHierarchy).equal(true);
    should(facts.memoryCeilingBytes).equal(48 * GIBIBYTE);
    should(facts.ceilingSource).equal('memory.high of user-1000.slice');
    should(facts.physicalBytes).equal(61 * GIBIBYTE);
    should(facts.swapBytes).equal(33554428 * 1024);
    should(facts.pidMax).equal(4_194_304);
    should(facts.cpus).equal(32);
    should(facts.ownCgroup).equal(OWN);
  });

  it('should name the unit that holds the budget down and the drop-in that sets it: the last one wins', async () => {
    // Arrange
    const places = await tree({
      'sys/cgroup.controllers': 'cpu memory',
      'proc/self/cgroup': `0::${OWN}\n`,
      'sys/user.slice/user-1000.slice/memory.high': `${48 * GIBIBYTE}\n`,
      'etc/user-1000.slice.d/50-devbox-memory.conf': '[Slice]\nMemoryHigh=48G\n',
      'etc/user-1000.slice.d/10-unrelated.conf': '[Slice]\nTasksMax=100\n',
      'etc/user-1000.slice.d/70-later.conf': '[Slice]\nMemoryHigh=48G\n',
    });

    // Act
    const facts = await hostCgroupFacts({ platform: 'linux', cpus: 4, physicalBytes: 61 * GIBIBYTE }, places);

    // Assert
    should(facts.ceilingCap?.unit).equal('user-1000.slice');
    should(facts.ceilingCap?.file).equal('memory.high');
    should(facts.ceilingCap?.dropIn).match(/etc\/user-1000\.slice\.d\/70-later\.conf$/u);
  });

  it('should use the machine’s RAM when nothing above the daemon is capped', async () => {
    // Arrange
    const places = await tree({
      'sys/cgroup.controllers': 'cpu memory',
      'proc/self/cgroup': `0::${OWN}\n`,
      'sys/user.slice/memory.max': 'max\n',
    });

    // Act
    const facts = await hostCgroupFacts({ platform: 'linux', cpus: 4, physicalBytes: 16 * GIBIBYTE }, places);

    // Assert
    should(facts.memoryCeilingBytes).equal(16 * GIBIBYTE);
    should(facts.swapBytes).equal(0);
    should(facts.pidMax).equal(undefined);
  });

  it('should report a host without the unified hierarchy as unsupported and cap nothing', async () => {
    // Arrange
    const places = await tree({ 'proc/self/cgroup': '12:memory:/legacy\n' });

    // Act
    const facts = await hostCgroupFacts({ platform: 'linux', cpus: 4, physicalBytes: 8 * GIBIBYTE }, places);

    // Assert
    should(facts.unifiedHierarchy).equal(false);
    should(facts.memoryCeilingBytes).equal(8 * GIBIBYTE);
    should(facts.ownCgroup).equal(undefined);
  });

  it('should not read any cgroup file off Linux', async () => {
    // Arrange / Act
    const facts = await hostCgroupFacts({ platform: 'darwin', cpus: 8, physicalBytes: 16 * GIBIBYTE });

    // Assert
    should(facts).deepEqual({
      platform: 'darwin',
      cpus: 8,
      physicalBytes: 16 * GIBIBYTE,
      unifiedHierarchy: false,
      memoryCeilingBytes: 16 * GIBIBYTE,
      ceilingSource: 'the machine’s memory',
      swapBytes: 0,
    });
  });

  it('should floor an unusable reading at one rather than producing a cap nothing can run in', async () => {
    // Arrange / Act
    const facts = await hostCgroupFacts({ platform: 'darwin', cpus: 0, physicalBytes: 0.4 });

    // Assert
    should(facts.cpus).equal(1);
    should(facts.physicalBytes).equal(1);
  });

  it('should give an unmeasured world the machine’s own memory and claim no hierarchy', () => {
    // Arrange / Act
    const facts = unmeasuredHostFacts();

    // Assert
    should(facts.unifiedHierarchy).equal(false);
    should(facts.memoryCeilingBytes).equal(facts.physicalBytes);
  });
});

describe('reading the fleet slice', () => {
  const MANAGER = '/user.slice/user-1000.slice/user@1000.service';
  const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';

  async function fleet(): Promise<{ readonly memory: CgroupFleetMemory; readonly slice: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-fleet-'));
    const slice = join(root, MANAGER, 'ferretry_fleet.slice');
    const scope = join(slice, `ferretry-agent-${SESSION}-a1b2c3d4.scope`);
    await mkdir(scope, { recursive: true });
    await mkdir(join(root, 'proc', '4242'), { recursive: true });
    await writeFile(join(slice, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 1\n');
    await writeFile(join(slice, 'memory.high'), `${44 * GIBIBYTE}\n`);
    await writeFile(join(slice, 'memory.max'), `${46 * GIBIBYTE}\n`);
    await writeFile(join(slice, 'memory.swap.max'), 'max\n');
    await writeFile(join(slice, 'pids.max'), '16384\n');
    await writeFile(join(slice, 'cpu.weight'), '50\n');
    await writeFile(join(scope, 'memory.events'), 'low 0\nhigh 7\nmax 0\noom 0\noom_kill 0\n');
    await writeFile(join(scope, 'memory.current'), `${5 * GIBIBYTE}\n`);
    await writeFile(join(scope, 'memory.high'), `${12 * GIBIBYTE}\n`);
    await writeFile(join(scope, 'memory.max'), `${14 * GIBIBYTE}\n`);
    await writeFile(join(scope, 'pids.max'), '4096\n');
    await writeFile(join(scope, 'cpu.weight'), '100\n');
    await writeFile(join(scope, 'cgroup.procs'), '4242\n');
    await mkdir(join(slice, 'unrelated.scope'), { recursive: true });
    await writeFile(join(root, 'proc', '4242', 'statm'), '100 2560 1 1 0 1 0\n');
    await writeFile(join(root, 'proc', '4242', 'cmdline'), 'bun\0test\0--coverage\0');
    const host = { ...unmeasuredHostFacts(), platform: 'linux', ownCgroup: `${MANAGER}/app.slice/fyd.service` };
    return { memory: new CgroupFleetMemory(host, undefined, root, join(root, 'proc')), slice };
  }

  it('should read the slice’s counters and each agent scope, and nothing else under it', async () => {
    // Arrange
    const { memory } = await fleet();

    // Act
    const actual = await memory.read();

    // Assert
    should(actual?.events.oomKill).equal(1);
    should(actual?.scopes).have.length(1);
    should(actual?.scopes[0]).match({
      scope: `ferretry-agent-${SESSION}-a1b2c3d4.scope`,
      events: { high: 7, max: 0, oom: 0, oomKill: 0 },
      currentBytes: 5 * GIBIBYTE,
      highBytes: 12 * GIBIBYTE,
    });
  });

  it('should read back what the slice and each scope really hold, not what was asked for', async () => {
    // Arrange
    const { memory } = await fleet();

    // Act
    const actual = await memory.read();

    // Assert — `max` is "no cap", and a swap cap is only read on the slice
    should(actual?.applied).deepEqual({
      memoryHigh: 44 * GIBIBYTE,
      memoryMax: 46 * GIBIBYTE,
      swapMax: null,
      tasksMax: 16384,
      cpuWeight: 50,
    });
    should(actual?.scopes[0]?.applied).deepEqual({
      memoryHigh: 12 * GIBIBYTE,
      memoryMax: 14 * GIBIBYTE,
      tasksMax: 4096,
      cpuWeight: 100,
    });
  });

  it('should list a scope’s biggest processes by what they hold, with their command lines', async () => {
    // Arrange
    const { memory } = await fleet();

    // Act
    const actual = await memory.largest(`ferretry-agent-${SESSION}-a1b2c3d4.scope`);

    // Assert
    should(actual).deepEqual([{ argv: 'bun test --coverage', rssBytes: 2560 * 4096 }]);
  });

  it('should read a slice whose name nests the way systemd nests it', async () => {
    // Arrange — `a-b-c.slice` is `a.slice/a-b.slice/a-b-c.slice`, never `<manager>/a-b-c.slice`
    const root = await mkdtemp(join(tmpdir(), 'ferretry-nested-'));
    const nested = join(root, MANAGER, 'ferretry.slice', 'ferretry-fleet.slice');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'memory.events'), 'low 0\nhigh 12\nmax 0\noom 0\noom_kill 0\n');
    const host = { ...unmeasuredHostFacts(), platform: 'linux', ownCgroup: `${MANAGER}/app.slice/fyd.service` };

    // Act
    const actual = await new CgroupFleetMemory(host, 'ferretry-fleet.slice', root).read();
    const flat = await new CgroupFleetMemory(host, 'ferretry_fleet.slice', root).read();

    // Assert
    should(actual?.events.high).equal(12);
    should(flat).equal(undefined);
  });

  it('should answer nothing, not an error, before any ferret has launched', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-nofleet-'));
    const host = { ...unmeasuredHostFacts(), platform: 'linux', ownCgroup: `${MANAGER}/app.slice/fyd.service` };

    // Act
    const actual = await new CgroupFleetMemory(host, undefined, root).read();

    // Assert
    should(actual).equal(undefined);
  });

  it('should answer nothing when the daemon is not under a user manager', async () => {
    // Arrange
    const host = { ...unmeasuredHostFacts(), platform: 'linux', ownCgroup: '/system.slice/fyd.service' };

    // Act + Assert
    should(await new CgroupFleetMemory(host).read()).equal(undefined);
    should(await new CgroupFleetMemory(host).largest('x.scope')).deepEqual([]);
  });
});

describe('reading the daemon and voice CPU weights', () => {
  const MANAGER = '/user.slice/user-1000.slice/user@1000.service';
  const OWN = `${MANAGER}/app.slice/fyd.service`;
  const hostOf = (ownCgroup?: string) => ({
    ...unmeasuredHostFacts(),
    platform: 'linux',
    ...(ownCgroup === undefined ? {} : { ownCgroup }),
  });

  async function tree(): Promise<{ readonly root: string; readonly voice: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-weights-'));
    await mkdir(join(root, OWN), { recursive: true });
    await writeFile(join(root, OWN, 'cpu.weight'), '1000\n');
    return { root, voice: join(root, MANAGER, 'ferretry_voice.slice') };
  }

  it('should read the weight of the daemon’s own cgroup, not a constant', async () => {
    // Arrange
    const { root } = await tree();

    // Act
    const actual = await new CgroupServiceWeights(hostOf(OWN), root, 'ferretry_voice.slice').read();

    // Assert
    should(actual).deepEqual({ daemon: 1000, voiceState: 'not-running' });
  });

  it('should read the voice slice weight while a worker scope is alive in it', async () => {
    // Arrange
    const { root, voice } = await tree();
    await mkdir(join(voice, 'ferretry-voice-1.scope'), { recursive: true });
    await writeFile(join(voice, 'cpu.weight'), '200\n');

    // Act
    const actual = await new CgroupServiceWeights(hostOf(OWN), root, 'ferretry_voice.slice').read();

    // Assert
    should(actual).deepEqual({ daemon: 1000, voice: 200, voiceState: 'running' });
  });

  it('should call a voice slice with no worker not running, whatever weight it still shows', async () => {
    // Arrange
    const { root, voice } = await tree();
    await mkdir(voice, { recursive: true });
    await writeFile(join(voice, 'cpu.weight'), '200\n');

    // Act
    const actual = await new CgroupServiceWeights(hostOf(OWN), root, 'ferretry_voice.slice').read();

    // Assert
    should(actual).deepEqual({ daemon: 1000, voiceState: 'not-running' });
  });

  it('should answer unknown, never "not running", when the voice slice exists but cannot be listed', async () => {
    // Arrange — a slice that cannot be read as a directory (ENOTDIR here; EACCES or EIO on a host): a reading
    // failure says nothing about whether the worker runs. A file stands in because CI may run as root.
    const { root, voice } = await tree();
    await mkdir(join(root, MANAGER), { recursive: true });
    await writeFile(voice, 'not a directory\n');

    // Act
    const actual = await new CgroupServiceWeights(hostOf(OWN), root, 'ferretry_voice.slice').read();

    // Assert
    should(actual).deepEqual({ daemon: 1000, voiceState: 'unknown' });
  });

  it('should leave a weight out, not guess it, when its file is unreadable or malformed', async () => {
    // Arrange
    const { root, voice } = await tree();
    await writeFile(join(root, OWN, 'cpu.weight'), 'banana\n');
    await mkdir(join(voice, 'ferretry-voice-1.scope'), { recursive: true });

    // Act
    const actual = await new CgroupServiceWeights(hostOf(OWN), root, 'ferretry_voice.slice').read();

    // Assert
    should(actual).deepEqual({ voiceState: 'running' });
  });

  it('should answer unknown when the daemon is not under a user manager or has no cgroup', async () => {
    // Arrange
    const { root } = await tree();

    // Act
    const system = await new CgroupServiceWeights(hostOf('/system.slice/fyd.service'), root).read();
    const none = await new CgroupServiceWeights(hostOf(), root).read();

    // Assert
    should(system.voiceState).equal('unknown');
    should(none).deepEqual({ voiceState: 'unknown' });
  });
});

describe('reading the disk scheduler', () => {
  it('should find the active scheduler in the kernel’s bracketed list', () => {
    // Arrange / Act / Assert
    should(activeScheduler('[none] mq-deadline kyber\n')).equal('none');
    should(activeScheduler('none [bfq] mq-deadline\n')).equal('bfq');
    should(activeScheduler('')).equal(undefined);
  });

  it('should resolve a partition to its disk and report that disk’s scheduler', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-sys-'));
    const disk = join(root, 'devices', 'nvme0n1');
    const partition = join(disk, 'nvme0n1p1');
    await mkdir(join(disk, 'queue'), { recursive: true });
    await mkdir(partition, { recursive: true });
    await writeFile(join(disk, 'queue', 'scheduler'), '[none] mq-deadline\n');
    await mkdir(join(root, 'dev', 'block'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(partition, join(root, 'dev', 'block', '259:1'));
    const reader = new SysfsDiskScheduler(async () => ({ major: 259, minor: 1 }), root);

    // Act
    const actual = await reader.read();

    // Assert
    should(actual).deepEqual({ device: 'nvme0n1', scheduler: 'none' });
  });

  it('should say nothing, not guess, when the device cannot be found', async () => {
    // Arrange
    const missing = new SysfsDiskScheduler(
      async () => ({ major: 1, minor: 1 }),
      await mkdtemp(join(tmpdir(), 'ferretry-sys-')),
    );
    const unknown = new SysfsDiskScheduler(async () => undefined);

    // Act + Assert
    should(await missing.read()).deepEqual({});
    should(await unknown.read()).deepEqual({});
  });
});

describe('the retired limits document', () => {
  async function home() {
    const { paths, files } = await stateHome('cgroup-legacy');
    return { paths, files, documents: new FileLegacyCgroupDocuments(files, paths) };
  }

  it('should read none from a state home that never had one', async () => {
    // Arrange
    const { documents } = await home();

    // Act + Assert
    should(await documents.readOld()).equal(undefined);
  });

  it('should read the old document, and keep a copy beside it when it is put away', async () => {
    // Arrange
    const { paths, files, documents } = await home();
    const path = join(paths.home, 'cgroups', 'config.json');
    await files.writeTextAtomic(path, '{"enabled":true}\n');
    await files.writeTextAtomic(join(paths.home, 'cgroups', 'apply-status.json'), '{}\n');

    // Act
    const read = await documents.readOld();
    await documents.retireOld();

    // Assert
    should(read).deepEqual({ enabled: true });
    should(await files.readText(path)).equal(undefined);
    should(await files.readText(join(paths.home, 'cgroups', 'config.json.migrated'))).equal('{"enabled":true}\n');
    should(await files.readText(join(paths.home, 'cgroups', 'apply-status.json'))).equal(undefined);
  });

  it('should hand back text that is not JSON as the text, so it is reported rather than treated as no document', async () => {
    // Arrange
    const { paths, files, documents } = await home();
    await files.writeTextAtomic(join(paths.home, 'cgroups', 'config.json'), '{ broken');

    // Act + Assert
    should(await documents.readOld()).equal('{ broken');
  });
});

describe('the live panes a limit change may reach', () => {
  const pane = (sessionId: string, pid: number, daemonId = '/home/one'): RegisteredTerminalPane => ({
    daemonId,
    sessionId,
    tmuxSession: `fy-${sessionId}`,
    paneId: `%${pid}`,
    pid,
    processStartTicks: 1_000,
  });

  /** The multiplexer agreeing that each registered pane is still the incarnation it was. */
  const agreeing: RegisteredPaneObserver = {
    observe: async registration => ({
      tmuxSession: registration.tmuxSession,
      paneId: registration.paneId,
      pid: registration.pid,
      processStartTicks: registration.processStartTicks,
    }),
  };

  const scan = (
    registrations: readonly RegisteredTerminalPane[],
    damaged: readonly { readonly sessionId: string; readonly error: unknown }[] = [],
  ) => ({ list: async () => ({ registrations, damaged }) });

  it('should offer every registered pane whose session is not provably over', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11), pane('s2', 12)]),
      { list: async () => [{ daemonId: '/home/one', sessionId: 's1', status: 'running' }] },
      agreeing,
    );

    // Act / Assert — `s2` has no state row at all, which is not proof that it finished.
    should(await subject.live()).deepEqual({
      panes: [
        { sessionId: 's1', pid: 11 },
        { sessionId: 's2', pid: 12 },
      ],
      unproven: [],
    });
  });

  it('should drop a session this daemon own documents prove is over', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11), pane('s2', 12)]),
      {
        list: async () => [
          { daemonId: '/home/one', sessionId: 's2', status: 'stopped', finishedAt: '2026-08-01T00:00:00.000Z' },
        ],
      },
      agreeing,
    );

    // Act / Assert
    should((await subject.live()).panes).deepEqual([{ sessionId: 's1', pid: 11 }]);
  });

  it('should keep a finished-looking session whose evidence is incomplete', async () => {
    // Arrange — a terminal status with no persisted instant is not evidence.
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11)]),
      { list: async () => [{ daemonId: '/home/one', sessionId: 's1', status: 'stopped' }] },
      agreeing,
    );

    // Act / Assert
    should((await subject.live()).panes).have.length(1);
  });

  it('should never offer a pane another daemon registered', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11, '/home/two')]),
      { list: async () => [] },
      agreeing,
    );

    // Act / Assert
    should((await subject.live()).panes).be.empty();
  });

  it('should refuse to offer a pid the multiplexer no longer proves is the SAME incarnation', async () => {
    // Arrange — the registered pane is gone and something else now holds its pid, which is exactly
    // the state a property write must never be aimed at.
    const recycled: RegisteredPaneObserver = {
      observe: async registration => ({
        tmuxSession: registration.tmuxSession,
        paneId: registration.paneId,
        pid: registration.pid,
        processStartTicks: registration.processStartTicks + 5_000,
      }),
    };
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11)]),
      { list: async () => [] },
      recycled,
    );

    // Act
    const live = await subject.live();

    // Assert — never silently absent: unproven, named, and left for the domain to warn about.
    should(live.panes).be.empty();
    should(live.unproven).have.length(1);
    should(live.unproven[0]?.failure).match(/no longer the incarnation this daemon launched \(pid 11\)/u);
  });

  it('should treat a pane the multiplexer cannot show at all as unproven rather than gone', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11)]),
      { list: async () => [] },
      { observe: async () => undefined },
    );

    // Act / Assert
    should((await subject.live()).unproven.map(entry => entry.sessionId)).deepEqual(['s1']);
  });

  it('should carry an observation that THREW through as unproven, never as a pane', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11)]),
      { list: async () => [] },
      {
        observe: async () => {
          throw new Error('tmux is not answering');
        },
      },
    );

    // Act / Assert
    should((await subject.live()).panes).be.empty();
  });

  it('should name a damaged registration instead of taking the whole surface down with it', async () => {
    // Arrange — one hand-edited file beside one healthy session.
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan(
        [pane('s1', 11)],
        [{ sessionId: 's9', error: new Error('session s9 has a malformed terminal pane registration') }],
      ),
      { list: async () => [] },
      agreeing,
    );

    // Act
    const live = await subject.live();

    // Assert — the healthy pane is still reconfigurable; the damaged one is reported, not dropped.
    should(live.panes).deepEqual([{ sessionId: 's1', pid: 11 }]);
    should(live.unproven[0]?.sessionId).equal('s9');
    should(live.unproven[0]?.failure).match(/malformed terminal pane registration.*cannot identify the pane/su);
  });

  it('should report a ledger it could not enumerate as INCOMPLETE rather than as no panes', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      {
        list: async () => {
          throw new Error('EIO');
        },
      },
      { list: async () => [] },
      agreeing,
    );

    // Act
    const live = await subject.live();

    // Assert — "we could not look" must never be answered with an empty set and nothing else.
    should(live.panes).be.empty();
    should(live.incomplete).match(/could not be read \(EIO\)/u);
  });

  it('should report an unreadable session directory the same way', async () => {
    // Arrange
    const subject = new RegisteredCgroupPaneLedger(
      '/home/one',
      scan([pane('s1', 11)]),
      {
        list: async () => {
          throw new Error('EACCES');
        },
      },
      agreeing,
    );

    // Act / Assert
    should((await subject.live()).incomplete).match(/EACCES/u);
  });
});

describe('measuring this very machine, with no arguments', () => {
  it('should read this host’s own platform, cores and memory', async () => {
    // Arrange / Act
    const facts = await hostCgroupFacts();

    // Assert
    should(facts.platform).equal(process.platform);
    should(facts.cpus).be.greaterThan(0);
    should(facts.physicalBytes).be.greaterThan(0);
    should(facts.memoryCeilingBytes).be.greaterThan(0);
    should(facts.memoryCeilingBytes).not.be.greaterThan(facts.physicalBytes);
  });

  it('should name the device a path lives on, as a major and a minor', async () => {
    // Arrange / Act
    const actual = await deviceOfPath(tmpdir());

    // Assert
    should(actual?.major).be.a.Number();
    should(actual?.minor).be.a.Number();
  });
});

describe('a ferret’s resident memory by its pane’s process tree', () => {
  const row = (pid: number, rssBytes?: number) => ({
    pid,
    ppid: 1,
    start: 1,
    startedAtMs: 0,
    argv: 'bun',
    state: 'S',
    ...(rssBytes === undefined ? {} : { rssBytes }),
  });
  const memory = (read: 'read' | 'unavailable') =>
    new PaneSessionMemory(
      { live: async () => ({ panes: [{ sessionId: 's1', pid: 100 }] }) },
      {
        tree: async () =>
          read === 'read'
            ? { kind: 'read', rows: [row(101, 2 * GIBIBYTE), row(102), row(103, GIBIBYTE)] }
            : { kind: 'unavailable', reason: 'no ps' },
        listening: async () => undefined,
        startOf: async () => undefined,
      },
    );

  it('should list the sessions with a live pane, and add up what their processes hold', async () => {
    // Arrange / Act
    const subject = memory('read');

    // Assert
    should(await subject.sessions()).deepEqual(['s1']);
    should(await subject.total('s1')).equal(3 * GIBIBYTE);
  });

  it('should not guess for a session with no pane, or whose tree cannot be read', async () => {
    // Arrange / Act / Assert
    should(await memory('read').total('other')).equal(undefined);
    should(await memory('unavailable').total('s1')).equal(undefined);
  });
});

describe('per-ferret slice accounting and local fleet events', () => {
  it('should read the aggregate ferret slice, its CPU quota, and processes in both harness and terminal scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferretry-slice-accounting-'));
    try {
      const manager = 'user.slice/user-1000.slice/user@1000.service';
      const fleet = `${manager}/ferretry_fleet.slice`;
      const sliceName = ferretSliceName('sid-one');
      const slice = `${fleet}/${sliceName}`;
      const files: Record<string, string> = {
        [`${fleet}/memory.events`]: 'high 7\noom_kill 0\n',
        [`${fleet}/memory.events.local`]: 'high 0\noom_kill 0\n',
        [`${fleet}/cpu.max`]: 'max 100000\n',
        [`${fleet}/cpu.weight`]: '50\n',
        [`${slice}/memory.events`]: 'high 7\noom_kill 0\n',
        [`${slice}/memory.high`]: '1073741824\n',
        [`${slice}/memory.max`]: '2147483648\n',
        [`${slice}/memory.current`]: '123456\n',
        [`${slice}/cpu.max`]: '800000 100000\n',
        [`${slice}/cpu.weight`]: '200\n',
        [`${slice}/pids.max`]: '32\n',
        [`${slice}/ferretry-agent-sid-one-harness.scope/cgroup.procs`]: '4242\n',
        [`${slice}/ferretry-agent-sid-one-terminal.scope/cgroup.procs`]: '4243\n',
        // Shared browser events stay in the fleet aggregate and are never attributed to a session.
        [`${fleet}/ferretry_fleet-browser.slice/memory.events`]: 'high 2\n',
        'proc/4242/statm': '100 2\n',
        'proc/4242/cmdline': 'claude\0',
        'proc/4243/statm': '100 4\n',
        'proc/4243/cmdline': 'bun\0test\0',
      };
      for (const [path, value] of Object.entries(files)) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), value);
      }
      const memory = new CgroupFleetMemory(
        { ...unmeasuredHostFacts(), cpus: 32, ownCgroup: `/${manager}/app.slice/fyd.service` },
        undefined,
        root,
        join(root, 'proc'),
      );
      const reading = await memory.read();
      should(reading?.events.high).equal(7);
      should(reading?.localEvents?.high).equal(0);
      should(reading?.browserEvents?.high).equal(2);
      should(reading?.applied).deepEqual({ cpuPercent: null, cpuWeight: 50 });
      should(reading?.scopes).have.length(1);
      should(reading?.scopes[0]?.scope).equal(sliceName);
      should(reading?.scopes[0]?.applied).deepEqual({
        memoryHigh: 1073741824,
        memoryMax: 2147483648,
        tasksMax: 32,
        cpuWeight: 200,
        cpuPercent: 25,
      });
      should(await memory.largest(sliceName)).deepEqual([
        { argv: 'bun test', rssBytes: 4 * 4096 },
        { argv: 'claude', rssBytes: 2 * 4096 },
      ]);
      await rm(join(root, fleet, 'memory.events.local'));
      await writeFile(join(root, slice, 'cpu.max'), 'unreadable-value');
      const missing = await memory.read();
      should(missing?.localEvents).be.undefined();
      should(missing?.scopes[0]?.applied?.cpuPercent).be.undefined();
      await rm(join(root, slice, 'ferretry-agent-sid-one-harness.scope'), { recursive: true });
      await rm(join(root, slice, 'ferretry-agent-sid-one-terminal.scope'), { recursive: true });
      should((await memory.read())?.scopes).deepEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

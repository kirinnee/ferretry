import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  CGROUP_COMMAND_TIMEOUT_CODE,
  cgroupApplyStatusPath,
  cgroupConfigPath,
  DEFAULT_CGROUP_COMMAND_TIMEOUT_MS,
  FileCgroupApplyStatusStore,
  FileCgroupConfigStore,
  FileSessionSpawnFacts,
  hostCgroupFacts,
  ProcCgroupPlacements,
  RegisteredCgroupPaneLedger,
  SpawnCgroupCommands,
  UNIFIED_HIERARCHY_MARKER,
} from '../../../src/adapters/cgroups/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  cleanCgroupApplyStatus,
  defaultCgroupConfig,
  parseStoredCgroupApplyStatus,
  parseStoredCgroupConfig,
  runCgroupCommand,
} from '../../../src/lib/cgroups/index.ts';
import {
  createFoundationPaths,
  createSessionPaths,
  resolveStateHome,
  type FoundationPaths,
} from '../../../src/lib/index.ts';
import type { RegisteredTerminalPane } from '../../../src/lib/session/reap.ts';
import type { RegisteredPaneObserver } from '../../../src/lib/session/reap-service.ts';

/**
 * The five adapters behind the resource-limit surface, against a real throwaway state home, a real
 * `/proc`-shaped tree and real child processes.
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

describe('the saved resource-limit document', () => {
  it('should read an untouched state home as no document at all', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-store');

    // Act / Assert
    should(await new FileCgroupConfigStore(files, paths).read()).be.undefined();
  });

  it('should round-trip a saved configuration through its own file inside the state home', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-store');
    const subject = new FileCgroupConfigStore(files, paths);
    const saved = { ...defaultCgroupConfig, enabled: true };

    // Act
    await subject.write(saved);

    // Assert — its own document, never `config/daemon.json`.
    should(cgroupConfigPath(paths)).equal(join(paths.home, 'cgroups', 'config.json'));
    should(await subject.read()).deepEqual(saved);
    should(await Bun.file(cgroupConfigPath(paths)).text()).endWith('\n');
  });

  it('should read an empty file as no document rather than as damage', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-store');
    await mkdir(join(paths.home, 'cgroups'), { recursive: true });
    await writeFile(cgroupConfigPath(paths), '   \n');

    // Act / Assert
    should(await new FileCgroupConfigStore(files, paths).read()).be.undefined();
  });

  it('should hand text that is not JSON to the domain, so a mangled document is never silent', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-store');
    await mkdir(join(paths.home, 'cgroups'), { recursive: true });
    await writeFile(cgroupConfigPath(paths), '{ this is not json');

    // Act
    const raw = await new FileCgroupConfigStore(files, paths).read();

    // Assert — collapsing it to `undefined` would make a hand-mangled file look like a fresh home.
    should(raw).equal('{ this is not json');
    should(parseStoredCgroupConfig(raw).warnings.join(' ')).match(/did not validate/u);
  });

  it('should preserve a config read refusal as warning evidence rather than absence', async () => {
    // Arrange — the port throws for a path outside the state home. Calling that "no document"
    // would silently turn an unreadable enabled config into the disabled defaults.
    const { files } = await stateHome('cgroup-store');
    const outside = createFoundationPaths(resolveStateHome({ fyHome: '/nonexistent-home', homeDirectory: '/tmp' }));

    // Act
    const stored = parseStoredCgroupConfig(await new FileCgroupConfigStore(files, outside).read());

    // Assert
    should(stored.config.enabled).be.false();
    should(stored.warnings.join(' ')).match(/could not be read/u);
  });
});

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
      '0::/user@1000.service/ferretry-fleet.slice/ferretry-agent-s1-ab.scope\n',
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
    const started = Bun.nanoseconds();
    const result = await subject.execute(['/bin/sh', '-c', 'sleep 30']);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // Assert — a refusal the domain restates like any other, not a hang and not a throw.
    should(result.code).equal(CGROUP_COMMAND_TIMEOUT_CODE);
    should(result.stderr).match(/did not answer within 50ms and was killed/u);
    should(elapsedMs).be.lessThan(10_000);
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

describe('the record of what a save could not apply', () => {
  it('should read a state home that has never saved as no record at all', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-status');

    // Act / Assert
    should(await new FileCgroupApplyStatusStore(files, paths).read()).be.undefined();
  });

  it('should round-trip a refusal through its own document beside the configuration', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-status');
    const subject = new FileCgroupApplyStatusStore(files, paths);
    const config = { ...defaultCgroupConfig, enabled: true };
    const status = {
      config,
      fleet: 'Failed to connect to bus',
      scopes: [{ sessionId: 's1', scope: 'ferretry-agent-s1-ab.scope', failure: 'Unit vanished' }],
      unproven: [],
    };

    // Act
    await subject.write(status);

    // Assert — its own file, so recording a host refusal is never a rewrite of the saved intent.
    should(cgroupApplyStatusPath(paths)).equal(join(paths.home, 'cgroups', 'apply-status.json'));
    should(await subject.read()).deepEqual(status);
    should(parseStoredCgroupApplyStatus(await subject.read(), config).status).deepEqual(status);
  });

  it('should hand a mangled record to the domain rather than reading it as "nothing failed"', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-status');
    await mkdir(join(paths.home, 'cgroups'), { recursive: true });
    await writeFile(cgroupApplyStatusPath(paths), '{ hand edited');

    // Act
    const stored = parseStoredCgroupApplyStatus(await new FileCgroupApplyStatusStore(files, paths).read(), {
      ...defaultCgroupConfig,
      enabled: true,
    });

    // Assert
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/did not validate/u);
  });

  it('should write a CLEAN record too, so a later save supersedes an earlier refusal', async () => {
    // Arrange
    const { paths, files } = await stateHome('cgroup-status');
    const subject = new FileCgroupApplyStatusStore(files, paths);
    const config = { ...defaultCgroupConfig, enabled: true };
    await subject.write({ config, fleet: 'Failed to connect to bus', scopes: [], unproven: [] });

    // Act
    await subject.write(cleanCgroupApplyStatus(config));

    // Assert — deleting instead would make "applied cleanly" and "never saved" one state.
    should(parseStoredCgroupApplyStatus(await subject.read(), config).status).deepEqual(cleanCgroupApplyStatus(config));
  });

  it('should preserve an apply-status read refusal as warning evidence rather than absence', async () => {
    // Arrange
    const { files } = await stateHome('cgroup-status');
    const outside = createFoundationPaths(resolveStateHome({ fyHome: '/nonexistent-home', homeDirectory: '/tmp' }));
    const config = { ...defaultCgroupConfig, enabled: true };

    // Act
    const stored = parseStoredCgroupApplyStatus(await new FileCgroupApplyStatusStore(files, outside).read(), config);

    // Assert
    should(stored.unreadable).be.true();
    should(stored.warnings.join(' ')).match(/could not be read/u);
  });
});

describe('measuring the host', () => {
  it('should read the machine it is actually running on when told nothing', () => {
    // Arrange / Act
    const facts = hostCgroupFacts();

    // Assert
    should(facts.platform).equal(process.platform);
    should(facts.cpus).be.greaterThan(0);
    should(facts.memoryBytes).be.greaterThan(0);
    should(UNIFIED_HIERARCHY_MARKER).equal('/sys/fs/cgroup/cgroup.controllers');
  });

  it('should floor an unusable reading at one rather than producing a cap nothing can run in', () => {
    // Arrange / Act
    const facts = hostCgroupFacts({ platform: 'linux', cpus: 0, memoryBytes: 0.4 }, true);

    // Assert
    should(facts).deepEqual({ platform: 'linux', unifiedHierarchy: true, cpus: 1, memoryBytes: 1 });
  });

  it('should carry a host without the unified hierarchy through as unsupported', () => {
    // Arrange / Act / Assert
    should(hostCgroupFacts({ platform: 'linux', cpus: 4, memoryBytes: 8 }, false).unifiedHierarchy).be.false();
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

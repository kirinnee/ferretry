import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageSessionLifecycleRepository,
  SystemClock,
  TmuxSessionLifecycleLauncher,
} from '../../../../src/adapters/index.ts';
import {
  createSessionPaths,
  createSessionRecord,
  TmuxController,
  type TmuxCommandPort,
} from '../../../../src/lib/index.ts';

const homes = new Set<string>();
const NOW = '2026-07-31T10:00:00.000Z';

async function openTemporaryStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-lifecycle-test-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return await factory.open();
}

class RecordingTmuxPort implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  alive = false;

  async execute(arguments_: readonly string[]) {
    this.calls.push(arguments_);
    if (arguments_[0] === 'has-session') return { code: this.alive ? 0 : 1, stdout: '', stderr: '' };
    if (arguments_[0] === 'new-session') this.alive = true;
    if (arguments_[0] === 'kill-session') this.alive = false;
    return { code: 0, stdout: '', stderr: '' };
  }
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('lifecycle adapters', () => {
  it('should persist and read the lifecycle record through the authoritative daemon store', async () => {
    // Arrange
    const opened = await openTemporaryStorage();
    const repository = new StorageSessionLifecycleRepository(opened.storage);
    const created = createSessionRecord(
      {
        id: 'stored-session',
        agent: '/opt/fleet/agent',
        cwd: '/workspace/project',
        mode: 'auto',
        prompt: 'Persist me',
      },
      NOW,
    );

    // Act
    await repository.write(created.record, created.event);
    const read = await repository.read(created.record.config.id);
    const paths = createSessionPaths(opened.paths, created.record.config.id);
    const config = await opened.storage.readConfig(created.record.config.id);
    const state = await opened.storage.readState(created.record.config.id);

    // Assert
    should(read).deepEqual(created.record);
    should(config).deepEqual(created.record.config);
    should(state).deepEqual(created.record.state);
    should((await readFile(paths.events, 'utf8')).trim()).containEql('"type":"session.created"');
    should(paths.directory).endWith('/state/sessions/stored-session');
    await opened.storage.close();
  });

  it('should launch and stop only through the injected isolated tmux controller', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const launcher = new TmuxSessionLifecycleLauncher(new TmuxController(port));
    const record = createSessionRecord(
      {
        id: 'tmux-session',
        agent: '/opt/fleet/agent',
        command: ['/opt/fleet/agent', '--mode', 'auto'],
        cwd: '/workspace/project',
        mode: 'auto',
        prompt: 'Launch me',
      },
      NOW,
    ).record;

    // Act
    await launcher.launch(record);
    await launcher.stop(record);

    // Assert
    should(port.calls).deepEqual([
      ['has-session', '-t', 'fy-tmux-session'],
      ['new-session', '-d', '-s', 'fy-tmux-session', '-c', '/workspace/project', '/opt/fleet/agent', '--mode', 'auto'],
      ['set-option', '-t', 'fy-tmux-session', 'remain-on-exit', 'on'],
      ['has-session', '-t', 'fy-tmux-session'],
      ['kill-session', '-t', 'fy-tmux-session'],
    ]);
  });

  it('should reject an invalid record before issuing a tmux launch command', async () => {
    // Arrange
    const port = new RecordingTmuxPort();
    const launcher = new TmuxSessionLifecycleLauncher(new TmuxController(port));
    const record = createSessionRecord(
      { id: 'empty-command', agent: '/opt/fleet/agent', cwd: '/workspace/project', mode: 'interactive' },
      NOW,
    ).record;
    const malformed = { ...record, config: { ...record.config, command: [] } };

    // Act + Assert
    await should(launcher.launch(malformed)).be.rejectedWith(/empty/u);
    should(port.calls).deepEqual([]);
  });
});

/**
 * What a Codex runtime leaves behind, and what it says when it cannot start.
 *
 * The claims: only a published Codex runtime's own config directory inside the fleet's homes is ever
 * a candidate; only a pid whose command line runs that home's app-server package is signalled; nothing
 * is stopped while any other process uses the home, and the session's own exiting harness is waited
 * out; every unknown leaves the daemon running; the offline failure is recognised and nothing else is.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CODEX_OFFLINE_LAUNCH_ERROR,
  type CodexAppServerProcesses,
  CodexAppServerSupervisor,
  type CodexRuntimeAccount,
  codexAppServerPidFiles,
  codexLaunchFailure,
  codexRuntimeHome,
  isCodexAppServerProcess,
  parseCodexPidFile,
} from '../../../src/lib/fleet/codex-runtime.ts';

const HOMES = '/state/fleet/homes';
const HOME = `${HOMES}/00000000-0000-4000-8000-000000000001`;
const SERVER = `${HOME}/packages/app-server-daemon/releases/0.162.1/bin/codex app-server --listen unix:// --managed-daemon`;
const UPDATER = `${HOME}/packages/app-server-daemon/releases/0.162.1/bin/codex app-server daemon pid-update-loop`;

const codex = (name: string, home = `${HOMES}/${name}`): CodexRuntimeAccount => ({
  kind: 'codex',
  wrapper: `/state/fleet/bin/${name}`,
  home,
});
const PUBLISHED: readonly CodexRuntimeAccount[] = [
  codex('codex-default', HOME),
  { kind: 'claude', wrapper: '/state/fleet/bin/claude-default', home: `${HOMES}/claude-default` },
  codex('codex-outside', '/home/person/.codex'),
  codex('codex-climb', `${HOMES}/../escape`),
];

/** A host whose pid files, processes and home users are all given. */
class FakeHost implements CodexAppServerProcesses {
  readonly terminated: number[] = [];
  usersAnswers: (readonly number[] | undefined)[] = [[100, 101]];

  constructor(
    readonly files: Readonly<Record<string, string>> = {
      [`${HOME}/app-server-daemon/daemon.pid`]: '{"pid":100,"processStartTime":"x"}',
      [`${HOME}/app-server-daemon/daemon-updater.pid`]: '{"pid":101}',
    },
    readonly commands: Readonly<Record<number, string>> = { 100: SERVER, 101: UPDATER },
  ) {}

  async read(path: string): Promise<string | undefined> {
    return this.files[path];
  }

  async commandLine(pid: number): Promise<string | undefined> {
    return this.commands[pid];
  }

  async usersOf(): Promise<readonly number[] | undefined> {
    return this.usersAnswers.length > 1 ? this.usersAnswers.shift() : this.usersAnswers[0];
  }

  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid);
  }
}

const supervisor = (
  host: FakeHost,
  accounts: () => Promise<readonly CodexRuntimeAccount[]> = async () => PUBLISHED,
) => {
  const sleeps: number[] = [];
  const subject = new CodexAppServerSupervisor({
    inventory: { accounts },
    processes: host,
    homesDirectory: `${HOMES}/`,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
    },
    attempts: 3,
    intervalMs: 50,
  });
  return { subject, sleeps };
};

describe('codexLaunchFailure', () => {
  it('should name the missing network for the measured offline startup failure', () => {
    // Arrange — what codex 0.162.1 prints offline with a ChatGPT login.
    const screen =
      'Error: account/read failed during TUI bootstrap: account/read failed: workspace routing discovery failed (code -32603)';

    // Act
    const actual = codexLaunchFailure(screen);

    // Assert
    should(actual?.startsWith(`${CODEX_OFFLINE_LAUNCH_ERROR}.`)).be.true();
    should(actual).match(/start the session again/u);
  });

  it('should say nothing about any other screen', () => {
    should(codexLaunchFailure('')).be.undefined();
    should(codexLaunchFailure('Error: something else broke')).be.undefined();
  });
});

describe('the app-server daemon facts', () => {
  it('should read a pid file and refuse anything that is not one', () => {
    should(parseCodexPidFile('{"pid":4242,"processStartTime":"x"}')).equal(4242);
    for (const text of ['', 'not json', 'null', '"4242"', '{"pid":"4242"}', '{"pid":1}', '{"pid":1.5}', '{}'])
      should(parseCodexPidFile(text)).be.undefined();
  });

  it('should recognise a process only by an executable under that home', () => {
    should(isCodexAppServerProcess(HOME, SERVER)).be.true();
    should(isCodexAppServerProcess(`${HOME}/`, `  ${UPDATER}`)).be.true();
    should(isCodexAppServerProcess(HOME, '/usr/bin/codex app-server --managed-daemon')).be.false();
    should(isCodexAppServerProcess(`${HOMES}/other`, SERVER)).be.false();
  });

  it('should list both pid files under the home', () => {
    should(codexAppServerPidFiles(`${HOME}/`)).deepEqual([
      `${HOME}/app-server-daemon/daemon.pid`,
      `${HOME}/app-server-daemon/daemon-updater.pid`,
    ]);
  });

  it('should pick only a published Codex runtime home inside the fleet homes', () => {
    should(codexRuntimeHome('/state/fleet/bin/codex-default', PUBLISHED, HOMES)).equal(HOME);
    // Found by name when the record carries an older path to the same wrapper.
    should(codexRuntimeHome('/moved/bin/codex-default', PUBLISHED, HOMES)).equal(HOME);
    should(codexRuntimeHome('/state/fleet/bin/claude-default', PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome('/state/fleet/bin/codex-outside', PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome('/state/fleet/bin/codex-climb', PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome('/usr/bin/vim', PUBLISHED, HOMES)).be.undefined();
  });
});

describe('CodexAppServerSupervisor', () => {
  it('should stop the server and its updater once nothing else uses the home', async () => {
    // Arrange
    const host = new FakeHost();
    const { subject } = supervisor(host);

    // Act
    const actual = await subject.afterSessionEnded('/state/fleet/bin/codex-default');

    // Assert
    should(actual).deepEqual({ kind: 'stopped', home: HOME, pids: [100, 101] });
    should(host.terminated).deepEqual([100, 101]);
  });

  it('should wait out the session’s own exiting harness before deciding', async () => {
    // Arrange — the killed pane's codex (pid 300) is still exiting on the first look.
    const host = new FakeHost();
    host.usersAnswers = [
      [100, 101, 300],
      [100, 101],
    ];
    const { subject, sleeps } = supervisor(host);

    // Act
    const actual = await subject.afterSessionEnded('/state/fleet/bin/codex-default');

    // Assert
    should(actual.kind).equal('stopped');
    should(sleeps).deepEqual([50]);
  });

  it('should leave the daemon running while another process uses the home', async () => {
    // Arrange — another session, or the person's own terminal, on the same runtime.
    const host = new FakeHost();
    host.usersAnswers = [[100, 101, 400]];
    const { subject, sleeps } = supervisor(host);

    // Act
    const actual = await subject.afterSessionEnded('/state/fleet/bin/codex-default');

    // Assert
    should(actual).deepEqual({ kind: 'in-use', home: HOME });
    should(host.terminated).be.empty();
    should(sleeps).deepEqual([50, 50]);
  });

  it('should leave the daemon running when the users of the home cannot be listed', async () => {
    // Arrange
    const host = new FakeHost();
    host.usersAnswers = [undefined];
    const { subject } = supervisor(host);

    // Act
    const actual = await subject.afterSessionEnded('/state/fleet/bin/codex-default');

    // Assert
    should(actual.kind).equal('undecided');
    should(host.terminated).be.empty();
  });

  it('should never signal a pid whose process is not that home’s daemon', async () => {
    // Arrange — the updater's pid was reused by an unrelated program.
    const host = new FakeHost(undefined, { 100: SERVER, 101: '/usr/bin/python3 server.py' });
    host.usersAnswers = [[100]];
    const { subject } = supervisor(host);

    // Act
    const actual = await subject.afterSessionEnded('/state/fleet/bin/codex-default');

    // Assert
    should(actual).deepEqual({ kind: 'stopped', home: HOME, pids: [100] });
  });

  it('should do nothing when no daemon is recorded or none is alive', async () => {
    // Arrange
    const none = new FakeHost({});
    const gone = new FakeHost(undefined, {});

    // Act + Assert
    should(await supervisor(none).subject.afterSessionEnded('/state/fleet/bin/codex-default')).deepEqual({
      kind: 'not-running',
      home: HOME,
    });
    should(await supervisor(gone).subject.afterSessionEnded('/state/fleet/bin/codex-default')).deepEqual({
      kind: 'not-running',
      home: HOME,
    });
    should([...none.terminated, ...gone.terminated]).be.empty();
  });

  it('should touch nothing for a runtime that is not a Codex runtime in the fleet', async () => {
    // Arrange
    const host = new FakeHost();
    const { subject } = supervisor(host);

    // Act
    const claude = await subject.afterSessionEnded('/state/fleet/bin/claude-default');
    const own = await subject.afterSessionEnded('/state/fleet/bin/codex-outside');

    // Assert
    should(claude).deepEqual({ kind: 'not-a-codex-runtime' });
    should(own).deepEqual({ kind: 'not-a-codex-runtime' });
    should(host.terminated).be.empty();
  });

  it('should answer a value, never throw, when the fleet cannot be read', async () => {
    // Arrange
    const { subject } = supervisor(new FakeHost(), async () => {
      throw new Error('manifest unreadable');
    });
    const nonError = supervisor(new FakeHost(), async () => {
      throw 'bare';
    }).subject;

    // Act + Assert
    should(await subject.afterSessionEnded('/state/fleet/bin/codex-default')).deepEqual({
      kind: 'undecided',
      reason: 'manifest unreadable',
    });
    should(await nonError.afterSessionEnded('/x')).deepEqual({ kind: 'undecided', reason: 'bare' });
  });
});

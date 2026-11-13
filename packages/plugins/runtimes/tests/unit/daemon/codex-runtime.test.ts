/**
 * What a Codex runtime leaves behind, and what it says when it cannot start.
 *
 * The claims: only a published Codex runtime's own config directory inside the fleet's homes is ever
 * a candidate; the pid files are read through the fleet root scoped to that ONE home; only a process the KERNEL finds
 * still running from that home's app-server package is signalled (SIGTERM, by pid, never a command line); nothing is
 * stopped while any other process uses the home, and the session's own exiting harness is waited out; every unknown
 * leaves the daemon running; the offline failure is recognised and nothing else is.
 *
 * The supervisor stands on the kernel's REAL rule over the testing host (`kernel.roots` fleet root, `kernel.processes`
 * over a fake process table), so a plugin test hears the refusals production gives.
 */
import { afterEach, describe, it } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { type TestProcess, testHost, testProcessTable } from '@ferretry/kernel/testing';
import should from 'should';
import {
  type CodexAppServerHost,
  CodexAppServerSupervisor,
  type CodexRuntimeAccount,
  codexRuntimeHome,
  parseCodexPidFile,
  runtimeHomeId,
} from '../../../daemon/lib/service/codex-runtime.ts';
import { CODEX_OFFLINE_LAUNCH_ERROR, codexLaunchFailure } from '../../../contract/codex-launch.ts';

const HOMES = '/fleet/homes';
const ID = 'codex-a';
const HOME = `${HOMES}/${ID}`;
const PACKAGES = `${HOME}/packages/app-server-daemon`;
const SERVER = `${PACKAGES}/releases/0.162.1/bin/codex app-server --listen unix:// --managed-daemon`;
const UPDATER = `${PACKAGES}/releases/0.162.1/bin/codex app-server daemon pid-update-loop`;
const BIN = '/fleet/bin';

const codex = (name: string, home = `${HOMES}/${name}`): CodexRuntimeAccount => ({
  kind: 'codex',
  wrapper: `${BIN}/${name}`,
  home,
});
const PUBLISHED: readonly CodexRuntimeAccount[] = [
  codex('codex-default', HOME),
  { kind: 'claude', wrapper: `${BIN}/claude-default`, home: `${HOMES}/claude-default` },
  codex('codex-outside', '/home/person/.codex'),
  codex('codex-climb', `${HOMES}/../escape`),
  codex('codex-nested', `${HOME}/nested`),
];

const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

interface World {
  readonly subject: CodexAppServerSupervisor;
  readonly signals: readonly { readonly pid: number; readonly signal: 'SIGTERM' }[];
  readonly sleeps: number[];
  readonly kernel: KernelPorts;
}

/** The supervisor over the testing host: Runtimes' real permissions, the given pid files and process table. */
async function world(
  options: {
    readonly pidFiles?: Readonly<Record<string, string>>;
    readonly processes?: readonly TestProcess[];
    readonly listable?: boolean;
    readonly accounts?: () => Promise<readonly CodexRuntimeAccount[]>;
    readonly package?: boolean;
    /** Answers `terminate` for these pids instead of the kernel (a pid the kernel will not signal at that moment). */
    readonly refuse?: readonly number[];
  } = {},
): Promise<World> {
  const seen: { kernel?: KernelPorts } = {};
  const table = testProcessTable({
    processes: options.processes ?? [
      { pid: 100, commandLine: SERVER, environment: { CODEX_HOME: HOME } },
      { pid: 101, commandLine: UPDATER, environment: { CODEX_HOME: HOME } },
    ],
    ...(options.listable === undefined ? {} : { listable: options.listable }),
  });
  const host = await testHost({
    plugins: [
      implementDaemon(
        definePlugin({
          id: 'runtimes',
          title: 'Runtimes',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['fleet'], processes: { environment: ['CODEX_HOME'] } },
        }),
        {
          build: ({ kernel }) => {
            seen.kernel = kernel;
            return {};
          },
        },
      ),
    ],
    processes: table,
  });
  stoppers.push(async () => await host.stop());
  const kernel = seen.kernel as KernelPorts;
  const fleet = kernel.roots.root('fleet');
  const at = (path: string) => {
    const resolved = fleet.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  if (options.package !== false)
    await fleet.writeText(at(`homes/${ID}/packages/app-server-daemon/releases/codex`), '#!/bin/sh');
  await fleet.makeDirectory(at(`homes/${ID}/app-server-daemon`));
  const files = options.pidFiles ?? {
    'daemon.pid': '{"pid":100,"processStartTime":"x"}',
    'daemon-updater.pid': '{"pid":101}',
  };
  for (const [name, text] of Object.entries(files))
    await fleet.writeText(at(`homes/${ID}/app-server-daemon/${name}`), text);
  const sleeps: number[] = [];
  const supervisorHost: CodexAppServerHost = {
    fleet: kernel.roots.root('fleet'),
    processes: {
      runsFrom: async (pid, under) => await kernel.processes.runsFrom(pid, under),
      usersOf: async (variable, value) => await kernel.processes.usersOf(variable, value),
      terminate: async (pid, under) =>
        options.refuse?.includes(pid) === true ? 'refused' : await kernel.processes.terminate(pid, under),
    },
  };
  const subject = new CodexAppServerSupervisor({
    inventory: { accounts: options.accounts ?? (async () => PUBLISHED) },
    host: supervisorHost,
    homesDirectory: `${HOMES}/`,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
    },
    attempts: 3,
    intervalMs: 50,
  });
  return { subject, signals: table.signals, sleeps, kernel };
}

const WRAPPER = `${BIN}/codex-default`;

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

  it('should pick only a published Codex runtime home inside the fleet homes', () => {
    should(codexRuntimeHome(WRAPPER, PUBLISHED, HOMES)).equal(HOME);
    // Found by name when the record carries an older path to the same wrapper.
    should(codexRuntimeHome('/moved/bin/codex-default', PUBLISHED, HOMES)).equal(HOME);
    should(codexRuntimeHome(`${BIN}/claude-default`, PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome(`${BIN}/codex-outside`, PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome(`${BIN}/codex-climb`, PUBLISHED, HOMES)).be.undefined();
    should(codexRuntimeHome('/usr/bin/vim', PUBLISHED, HOMES)).be.undefined();
  });

  it('should name a runtime home only when it is exactly one folder below the homes', () => {
    should(runtimeHomeId(HOME, HOMES)).equal(ID);
    should(runtimeHomeId(HOME, `${HOMES}/`)).equal(ID);
    should(runtimeHomeId(`${HOME}/nested`, HOMES)).be.undefined();
    should(runtimeHomeId(HOMES, HOMES)).be.undefined();
    should(runtimeHomeId('/elsewhere/x', HOMES)).be.undefined();
  });
});

describe('CodexAppServerSupervisor', () => {
  it('should stop the server and its updater once nothing else uses the home', async () => {
    // Arrange
    const { subject, signals } = await world();

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'stopped', home: HOME, pids: [100, 101] });
    should(signals).deepEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 101, signal: 'SIGTERM' },
    ]);
  });

  it('should wait out the session’s own exiting harness before deciding', async () => {
    // Arrange — the killed pane's codex (pid 300) is still in the table on the first look.
    const { subject, sleeps, kernel } = await world({
      processes: [
        { pid: 100, commandLine: SERVER, environment: { CODEX_HOME: HOME } },
        { pid: 101, commandLine: UPDATER, environment: { CODEX_HOME: HOME } },
        { pid: 300, commandLine: 'codex --tui', environment: { CODEX_HOME: HOME } },
      ],
    });
    void kernel;

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert — pid 300 never exits in this table, so the home stays in use after every look.
    should(actual).deepEqual({ kind: 'in-use', home: HOME });
    should(sleeps).deepEqual([50, 50]);
  });

  it('should leave the daemon running while another process uses the home', async () => {
    // Arrange — another session, or the person's own terminal, on the same runtime.
    const { subject, signals } = await world({
      processes: [
        { pid: 100, commandLine: SERVER, environment: { CODEX_HOME: HOME } },
        { pid: 101, commandLine: UPDATER, environment: { CODEX_HOME: HOME } },
        { pid: 400, commandLine: 'codex', environment: { CODEX_HOME: HOME } },
      ],
    });

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'in-use', home: HOME });
    should(signals).be.empty();
  });

  it('should leave the daemon running when the users of the home cannot be listed', async () => {
    // Arrange
    const { subject, signals } = await world({ listable: false });

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'undecided', reason: `who is using ${HOME} could not be listed` });
    should(signals).be.empty();
  });

  it('should report only the pids the kernel signalled, and say so when it signalled none', async () => {
    // Arrange — the kernel refuses the updater at the moment of the signal (a reused pid).
    const some = await world({ refuse: [101] });
    const none = await world({ refuse: [100, 101] });

    // Act + Assert
    should(await some.subject.afterSessionEnded(WRAPPER)).deepEqual({ kind: 'stopped', home: HOME, pids: [100] });
    should((await none.subject.afterSessionEnded(WRAPPER)).kind).equal('undecided');
  });

  it('should never signal a pid whose process does not run from that home’s package (a reused pid)', async () => {
    // Arrange — the updater's pid was reused by an unrelated program.
    const { subject, signals } = await world({
      processes: [
        { pid: 100, commandLine: SERVER, environment: { CODEX_HOME: HOME } },
        { pid: 101, commandLine: '/usr/bin/python3 server.py' },
      ],
    });

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'stopped', home: HOME, pids: [100] });
    should(signals.map(signal => signal.pid)).deepEqual([100]);
  });

  it('should never signal another user’s process or the daemon itself', async () => {
    // Arrange — both recorded pids are ones the kernel never signals (another uid; the daemon's own pid).
    const { subject, signals } = await world({
      processes: [
        { pid: 100, uid: 0, commandLine: SERVER, environment: { CODEX_HOME: HOME } },
        { pid: 1000, commandLine: UPDATER, environment: { CODEX_HOME: HOME } },
      ],
      pidFiles: { 'daemon.pid': '{"pid":100}', 'daemon-updater.pid': '{"pid":1000}' },
    });

    // Act
    const actual = await subject.afterSessionEnded(WRAPPER);

    // Assert
    should(actual.kind).equal('not-running');
    should(signals).be.empty();
  });

  it('should do nothing when no daemon is recorded or none is alive', async () => {
    // Arrange
    const none = await world({ pidFiles: {} });
    const gone = await world({ processes: [] });
    const noPackage = await world({ package: false });

    // Act + Assert
    for (const { subject, signals } of [none, gone, noPackage]) {
      should(await subject.afterSessionEnded(WRAPPER)).deepEqual({ kind: 'not-running', home: HOME });
      should(signals).be.empty();
    }
  });

  it('should touch nothing for a runtime that is not a Codex runtime in the fleet', async () => {
    // Arrange
    const { subject, signals } = await world();

    // Act
    const claude = await subject.afterSessionEnded(`${BIN}/claude-default`);
    const own = await subject.afterSessionEnded(`${BIN}/codex-outside`);
    const nested = await subject.afterSessionEnded(`${BIN}/codex-nested`);

    // Assert — a home that is not exactly homes/<id> is never a candidate.
    should(claude).deepEqual({ kind: 'not-a-codex-runtime' });
    should(own).deepEqual({ kind: 'not-a-codex-runtime' });
    should(nested).deepEqual({ kind: 'not-a-codex-runtime' });
    should(signals).be.empty();
  });

  it('should answer a value, never throw, when the fleet cannot be read', async () => {
    // Arrange
    const { subject } = await world({
      accounts: async () => {
        throw new Error('manifest unreadable');
      },
    });
    const nonError = (
      await world({
        accounts: async () => {
          throw 'bare';
        },
      })
    ).subject;

    // Act + Assert
    should(await subject.afterSessionEnded(WRAPPER)).deepEqual({ kind: 'undecided', reason: 'manifest unreadable' });
    should(await nonError.afterSessionEnded('/x')).deepEqual({ kind: 'undecided', reason: 'bare' });
  });

  it('should hold the kernel rule: another home’s folder is refused to the process port', async () => {
    // Arrange — the supervisor's root is homes/<id>; the kernel refuses any folder outside homes/<id>.
    const { kernel } = await world();
    const fleet = kernel.roots.root('fleet');
    const bin = fleet.resolve('.');
    if (!bin.ok) throw new Error(bin.error);

    // Act + Assert — the whole fleet folder is not a runtime's own folder.
    await should(kernel.processes.usersOf('CODEX_HOME', { root: fleet, path: bin.value })).be.rejected();
  });
});

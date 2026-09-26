import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../daemon/src/adapters/index.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';

/**
 * A session started on a daemon that `fy daemon start` launched — the way the bug hid.
 *
 * Every other journey boots `fyd` inside the test process, so it inherits the developer's UTF-8
 * locale. `fy daemon start` hands the daemon only what the supervisor puts in its environment, and a
 * tmux client with no UTF-8 locale prints a tab as `_`. The pane identity a launch must prove came
 * back as `%0_2475105`, and every session failed with "tmux did not prove the launched pane
 * identity". Nothing caught it because nothing started a session under that environment.
 *
 * So this uses the CLI's real `DirectSupervisor` over its real process adapter to launch a real
 * `fyd`, then starts a session with the repository's fake harness and requires it to be RUNNING.
 * Like `fresh-home-bootstrap.test.ts`, it is a test-only reach from `packages/cli` into
 * `packages/daemon`: the seam between them has no compiler to check it.
 *
 * IT SPENDS NOTHING and reads no credential. The harness is `scripts/test/fake-harness.ts`, and the
 * daemon's `PATH` is a private directory holding only `bun` and `tmux` plus the system directories —
 * asserted below to resolve no `claude` or `codex`, because a daemon that found one would prepare a
 * default account and copy this machine's login into it.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const TMUX = Bun.which('tmux');
const WRAPPER = 'claude-auto-probe';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();

afterEach(async () => {
  for (const pid of daemons) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  daemons.clear();
  for (const socket of sockets) {
    if (TMUX !== null)
      await Bun.spawn([TMUX, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
  }
  sockets.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('the fixture server reported no port');
  return port;
}

async function executable(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`);
  await chmod(path, 0o755);
}

/** What the harness does once its prompt has been answered with `go`, and how often the daemon checks. */
interface Journey {
  readonly afterPrompt: readonly Readonly<Record<string, unknown>>[];
  readonly healthIntervalSeconds?: number;
}

/** A harness that sits at its prompt for the whole test, as the original journey needs. */
const STAYS_AT_PROMPT: Journey = { afterPrompt: [] };

/** The daemon's whole world: a private bin directory, a launcher for `fyd`, and a fake account. */
async function arrange(
  root: string,
  port: number,
  journey: Journey = STAYS_AT_PROMPT,
): Promise<{ bin: string; stateHome: string; fyd: string }> {
  if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
  const bin = join(root, 'bin');
  const stateHome = join(root, 'state');
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'bun'));
  await symlink(TMUX, join(bin, 'tmux'));

  // `fyd.ts` is not itself executable; the supervisor launches whatever path it is handed.
  const fyd = join(bin, 'fyd');
  await executable(fyd, ['#!/bin/sh', `exec bun '${join(REPOSITORY, 'packages/daemon/bin/fyd.ts')}' "$@"`]);

  // The daemon's own bootstrap first, so the configuration below lands in a home it has adopted.
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
  ).open();
  await opened.storage.close();
  await writeFile(
    join(stateHome, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port,
      relay: { url: 'https://off.example', enabled: false },
      ...(journey.healthIntervalSeconds === undefined ? {} : { healthIntervalSeconds: journey.healthIntervalSeconds }),
    }),
    { mode: 0o600 },
  );

  const harnessHome = join(root, 'harness');
  const scenario = join(root, 'scenario.json');
  await mkdir(harnessHome, { recursive: true });
  // A prompt line with the cursor left on it, which is what a ready harness shows.
  await writeFile(
    scenario,
    JSON.stringify({
      version: 1,
      steps: [
        { type: 'say', text: 'probe ready' },
        { type: 'ask', text: '>\u001b[1A', expect: journey.afterPrompt.length === 0 ? '__never__' : 'go' },
        ...journey.afterPrompt,
      ],
    }),
  );
  const wrapper = join(bin, WRAPPER);
  await executable(wrapper, [
    '#!/bin/sh',
    `export CLAUDE_CONFIG_DIR="${harnessHome}"`,
    `export FY_E2E_HARNESS_SCRIPT="${scenario}"`,
    `export FY_E2E_HARNESS_INVOCATIONS="${join(root, 'invocations.jsonl')}"`,
    `exec bun '${join(REPOSITORY, 'scripts/test/fake-harness.ts')}' "$@"`,
  ]);
  const { buildFleetManifest } = await import('@ferretry/fleet');
  await writeFile(
    join(stateHome, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2026-09-26T00:00:00.000Z',
        accounts: [
          {
            id: ACCOUNT,
            kind: 'claude',
            mode: 'auto',
            wrapper,
            home: harnessHome,
            displayName: 'Probe',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );
  return { bin, stateHome, fyd };
}

async function waitForHealth(port: number, logFile: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)) !== undefined) return;
    await Bun.sleep(50);
  }
  const log = await readFile(logFile, 'utf8').catch(() => '(no log)');
  throw new Error(`the daemon never answered its health probe:\n${log}`);
}

interface BootedDaemon {
  readonly root: string;
  readonly port: number;
  readonly stateHome: string;
  readonly token: string;
  readonly logFile: string;
}

/** A real `fyd` launched by the CLI's real supervisor, as `fy daemon start` would. */
async function boot(journey?: Journey): Promise<BootedDaemon> {
  const root = await mkdtemp(join(tmpdir(), 'fy-sup-'));
  roots.add(root);
  const port = await freeLoopbackPort();
  const { bin, stateHome, fyd } = await arrange(root, port, journey);
  const searchPath = `${bin}:/usr/bin:/bin`;
  // Fail closed rather than let the daemon find a real harness and copy this machine's login.
  should(Bun.which('claude', { PATH: searchPath })).equal(null);
  should(Bun.which('codex', { PATH: searchPath })).equal(null);
  sockets.add(join(stateHome, 'tmux.sock'));
  const layout = resolveDaemonLayout({
    platform: process.platform,
    homeDirectory: root,
    stateHome,
    configHome: join(root, 'config-home'),
    stateDirectory: join(root, 'cli-state'),
    userId: 1000,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath,
    // No locale at all: what a service manager, cron or a bare `env -i` gives the CLI.
  });
  const supervisor = new DirectSupervisor(
    layout,
    new BunDaemonProcess(),
    new FileServiceStore(),
    new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
  );
  const handle = await supervisor.start(fyd);
  if (handle.pid !== undefined) daemons.add(handle.pid);
  await waitForHealth(port, layout.logFile);
  const token = (await readFile(join(stateHome, 'api-token'), 'utf8')).trim();
  return { root, port, stateHome, token, logFile: layout.logFile };
}

function headers(daemon: BootedDaemon, requestId: string): Record<string, string> {
  return {
    authorization: `Bearer ${daemon.token}`,
    'content-type': 'application/json',
    'x-ferretry-client': 'cli',
    'x-fy-request-id': requestId,
  };
}

async function startSession(daemon: BootedDaemon): Promise<Response> {
  return await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
    method: 'POST',
    headers: headers(daemon, 'req-supervised-1'),
    body: JSON.stringify({ agent: WRAPPER, mode: 'interactive', name: 'Probe', cwd: daemon.root }),
  });
}

/** The daemon log, attached to an assertion so a failure names its cause rather than only its status. */
async function logOf(daemon: BootedDaemon): Promise<string> {
  const log = await readFile(daemon.logFile, 'utf8').catch(() => '');
  return `--- ${dirname(daemon.logFile)}/fyd.log ---\n${log}`;
}

describe('a session on a daemon `fy daemon start` launched', () => {
  it('should reach running, although the supervisor hands the daemon almost no environment', async () => {
    // Arrange
    const daemon = await boot();

    // Act
    const response = await startSession(daemon);
    const body = await response.text();

    // Assert
    should(response.status).equal(201, `${body}\n${await logOf(daemon)}`);
    should(JSON.parse(body)).match({ state: { status: 'running' } });
  }, 60_000);

  it('should stop reading running within one health interval once its harness exits', async () => {
    // Arrange — a one-second interval stands in for the thirty-second default; the rule under test
    // is "within one interval", and the daemon reads the operator's number rather than a constant.
    const daemon = await boot({ afterPrompt: [{ type: 'exit', code: 3 }], healthIntervalSeconds: 1 });
    const response = await startSession(daemon);
    const body = await response.text();
    should(response.status).equal(201, `${body}\n${await logOf(daemon)}`);
    const started = JSON.parse(body) as { config: { id: string } };
    const read = async (): Promise<{ state: Record<string, unknown> }> =>
      (await (
        await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions/${encodeURIComponent(started.config.id)}`, {
          headers: headers(daemon, 'req-supervised-read'),
        })
      ).json()) as { state: Record<string, unknown> };

    // Act — answer the prompt, so the harness runs to its scripted exit exactly as a finished agent would.
    if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
    const socket = join(daemon.stateHome, 'tmux.sock');
    // The wire carries no terminal name, and this private server holds exactly the one session.
    const listed = Bun.spawn([TMUX, '-S', socket, 'list-sessions', '-F', '#{session_name}']);
    const [terminal] = (await new Response(listed.stdout).text()).split('\n').filter(Boolean);
    if (terminal === undefined) throw new Error(`the daemon's tmux server has no session\n${await logOf(daemon)}`);
    await Bun.spawn([TMUX, '-S', socket, 'send-keys', '-t', terminal, '-l', 'go']).exited;
    await Bun.spawn([TMUX, '-S', socket, 'send-keys', '-t', terminal, 'Enter']).exited;
    const exitedAt = Date.now();
    let actual = await read();
    // Three intervals of slack for a loaded CI host; the old behaviour never left `running` at all.
    while (actual.state.status === 'running' && Date.now() - exitedAt < 3_000) {
      await Bun.sleep(100);
      actual = await read();
    }

    // Assert
    should(actual.state).match(
      {
        status: 'failed',
        health: 'crashed',
        reason: 'the agent exited on its own (exit status 3)',
        exitCode: 3,
      },
      `${JSON.stringify(actual.state)}\n${await logOf(daemon)}`,
    );
  }, 60_000);
});

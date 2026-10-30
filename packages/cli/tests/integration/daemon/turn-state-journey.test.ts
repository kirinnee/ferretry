import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type SessionView, SessionViewSchema } from '@ferretry/protocol';
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
import { OS_CHOSEN_PORT, recordedPort } from '../../../../daemon/tests/integration/support/os-port.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';
import { TEARDOWN_TIMEOUT_MS, tearDownSupervisedDaemons } from '../support/supervised-daemon-teardown.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * WHOSE TURN IT IS, end to end: a real `fyd`, real tmux, and a fake harness for a Claude AND a Codex
 * runtime that draws exactly what each harness draws — an idle prompt, its working line, a permission
 * prompt — and can crash on cue. The session's `turnState` is read back through the API, the field
 * the spinner, the status dots and the notifications all read.
 *
 * The harness is a frame player: it redraws whatever the test writes to its frame file, with the
 * cursor left on the prompt line, and exits with status 3 when the frame says `EXIT`. It spends
 * nothing, and the daemon's `PATH` resolves no real `claude` or `codex`.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const TMUX = Bun.which('tmux');
const CLAUDE = { wrapper: 'claude-auto-gabriela', account: '00000000-0000-4000-8000-0000000000c1' } as const;
const CODEX = { wrapper: 'codex-auto-gabriela', account: '00000000-0000-4000-8000-0000000000c2' } as const;

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();

afterEach(async () => {
  await tearDownSupervisedDaemons({ daemons, sockets, roots }, { tmux: TMUX });
}, TEARDOWN_TIMEOUT_MS);

async function executable(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`);
  await chmod(path, 0o755);
}

const CLAUDE_IDLE = '  ? for shortcuts\n╭──────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CLAUDE_PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';
const CODEX_PERMISSION = 'Would you like to run the following command?\n  $ git push\n› 1. Yes, proceed\n  2. No';

/** One fake runtime: a frame player under the wrapper name, with its own frame file. */
async function runtime(root: string, bin: string, harness: 'claude' | 'codex', wrapper: string): Promise<string> {
  const home = join(root, `${harness}-home`);
  await mkdir(home, { recursive: true });
  const frame = join(root, `${harness}-frame.txt`);
  await writeFile(frame, harness === 'claude' ? CLAUDE_IDLE : CODEX_IDLE);
  await executable(join(bin, wrapper), [
    '#!/bin/sh',
    `export ${harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}="${home}"`,
    'last=""',
    'while :; do',
    `  now="$(cat '${frame}')"`,
    '  if [ "$now" = EXIT ]; then exit 3; fi',
    '  if [ "$now" != "$last" ]; then printf \'\\033[H\\033[2J%s\\n\\033[1A\' "$now"; last="$now"; fi',
    '  sleep 0.05',
    'done',
  ]);
  return home;
}

interface BootedDaemon {
  readonly port: number;
  readonly token: string;
  readonly logFile: string;
  readonly root: string;
}

/** A real `fyd`, launched by the CLI's real supervisor, with one Claude and one Codex runtime. */
async function boot(): Promise<BootedDaemon> {
  if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-turn-'));
  roots.add(root);
  const bin = join(root, 'bin');
  const stateHome = join(root, 'state');
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'bun'));
  await symlink(TMUX, join(bin, 'tmux'));
  const fyd = join(bin, 'fyd');
  await executable(fyd, ['#!/bin/sh', `exec bun '${join(REPOSITORY, 'packages/daemon/bin/fyd.ts')}' "$@"`]);

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
      port: OS_CHOSEN_PORT,
      relay: { url: 'https://off.example', enabled: false },
      // One-second health ticks, so a crashed harness is noticed within the test's budget.
      healthIntervalSeconds: 1,
    }),
    { mode: 0o600 },
  );

  const claudeHome = await runtime(root, bin, 'claude', CLAUDE.wrapper);
  const codexHome = await runtime(root, bin, 'codex', CODEX.wrapper);
  const { buildFleetManifest } = await import('@ferretry/fleet');
  const account = (harness: 'claude' | 'codex', id: string, wrapper: string, home: string, model: string) => ({
    id,
    kind: harness,
    mode: 'auto' as const,
    wrapper: join(bin, wrapper),
    home,
    displayName: `Gabriela ${harness}`,
    defaultModel: model,
    models: [{ id: model, available: true as const }],
    available: true,
    unavailableReason: null,
  });
  await writeFile(
    join(stateHome, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2026-10-16T00:00:00.000Z',
        accounts: [
          account('claude', CLAUDE.account, CLAUDE.wrapper, claudeHome, 'claude-opus-5[1m]'),
          account('codex', CODEX.account, CODEX.wrapper, codexHome, 'gpt-5.6-codex'),
        ],
      }),
    ),
    { mode: 0o600 },
  );

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
  });
  const supervisor = new DirectSupervisor(
    layout,
    new BunDaemonProcess(),
    new FileServiceStore(),
    new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
  );
  const handle = await supervisor.start(fyd);
  if (handle.pid !== undefined) daemons.add(handle.pid);
  const port = await recordedPort(stateHome);
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true,
    'the daemon to answer its health probe',
    { pollMs: 50, evidence: async () => await readFile(layout.logFile, 'utf8').catch(() => '(no log)') },
  );
  const token = (await readFile(join(stateHome, 'api-token'), 'utf8')).trim();
  return { port, token, logFile: layout.logFile, root };
}

const headers = (daemon: BootedDaemon, requestId: string): Record<string, string> => ({
  authorization: `Bearer ${daemon.token}`,
  'content-type': 'application/json',
  'x-ferretry-client': 'cli',
  'x-fy-request-id': requestId,
});

const logOf = async (daemon: BootedDaemon): Promise<string> =>
  `--- fyd.log ---\n${await readFile(daemon.logFile, 'utf8').catch(() => '(no log)')}`;

/** Starts a session with NOTHING to do — no prompt — exactly as the owner did. */
async function startIdle(daemon: BootedDaemon, wrapper: string): Promise<SessionView> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
    method: 'POST',
    headers: headers(daemon, `req-${wrapper}`),
    body: JSON.stringify({ agent: wrapper, mode: 'interactive', name: 'Gabriela', cwd: tmpdir() }),
  });
  const body = await response.text();
  should(response.status).equal(201, `${body}\n${await logOf(daemon)}`);
  return SessionViewSchema.parse(JSON.parse(body));
}

/** Reads the session's state through the API, the way every client does. */
async function stateOf(daemon: BootedDaemon, id: string): Promise<SessionView['state']> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions/${encodeURIComponent(id)}`, {
    headers: headers(daemon, `read-${Date.now()}`),
  });
  return SessionViewSchema.parse(await response.json()).state;
}

/** Waits for `turnState` to read `expected`. */
async function until(daemon: BootedDaemon, id: string, expected: string | undefined): Promise<void> {
  const last: { state?: SessionView['state'] } = {};
  await waitFor(
    async () => {
      last.state = await stateOf(daemon, id);
      return last.state.turnState === expected;
    },
    `turnState to read ${String(expected)}`,
    {
      pollMs: 150,
      evidence: async () =>
        `it read ${String(last.state?.turnState)}: ${JSON.stringify(last.state)}\n${await logOf(daemon)}`,
    },
  );
}

const frameOf = (daemon: BootedDaemon, harness: 'claude' | 'codex') => async (text: string) =>
  await writeFile(join(daemon.root, `${harness}-frame.txt`), text);

describe('whose turn it is, through a real daemon', () => {
  for (const [harness, wrapper, idle, working, permission] of [
    ['claude', CLAUDE.wrapper, CLAUDE_IDLE, CLAUDE_WORKING, CLAUDE_PERMISSION],
    ['codex', CODEX.wrapper, CODEX_IDLE, CODEX_WORKING, CODEX_PERMISSION],
  ] as const) {
    it(`${harness}: your turn at the prompt, working mid-turn, needs input on a permission prompt, your turn again within seconds of the turn ending, and nothing once it crashes`, async () => {
      // Arrange
      const daemon = await boot();
      const frame = frameOf(daemon, harness);
      const view = await startIdle(daemon, wrapper);
      const id = view.config.id;

      // Idle at its prompt.
      await until(daemon, id, 'your-turn');
      // Mid-turn.
      await frame(working);
      await until(daemon, id, 'working');
      // A permission prompt: blocked on a person.
      await frame(permission);
      await until(daemon, id, 'needs-input');
      // Back to work, then the turn ends. REGRESSION: the spinner stops within a few seconds.
      await frame(working);
      await until(daemon, id, 'working');
      await frame(idle);
      await until(daemon, id, 'your-turn');
      // The harness crashes: the session is over, so it has no turn at all.
      await frame('EXIT');
      await until(daemon, id, undefined);
      should((await stateOf(daemon, id)).status).equal('failed');
    }, 120_000);
  }
});

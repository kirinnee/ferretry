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
import { parsePaneActivity } from '../../../../pwa/src/lib/pane-activity.ts';
import { sessionAtPrompt } from '../../../../pwa/src/lib/session-activity.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';
import { TEARDOWN_TIMEOUT_MS, tearDownSupervisedDaemons } from '../support/supervised-daemon-teardown.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * A BRAND-NEW SESSION, IDLE AT ITS PROMPT, through a real `fyd`, real tmux and a fake harness.
 *
 * The owner started a session and, before sending anything, saw `Running`, a `Working…` spinner,
 * `model unavailable`, a blank effort chip and quota dashes. This starts exactly that session — no
 * prompt — for a Claude runtime and a Codex runtime, each with its own home holding the level the
 * harness persisted, and reads back everything the session page renders from:
 *
 *   - the document: `running` on turn zero, the model the launch argv named, and the level it launched
 *     on — so the composer can name both before any transcript exists;
 *   - the LIVE pane frame, read through the same route the page polls, which the page's own model
 *     (`lib/session-activity.ts`) must call ready — while a harness painting its spinner stays working.
 *
 * IT SPENDS NOTHING and reads no credential: the harness is `scripts/test/fake-harness.ts`, and the
 * daemon's `PATH` holds only `bun` and `tmux` plus the system directories — asserted to resolve no
 * real `claude` or `codex`. Like `supervised-session-start.test.ts`, it reaches from `packages/cli`
 * into `packages/daemon` (and here `packages/pwa`) on purpose: the seam between them has no compiler.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const TMUX = Bun.which('tmux');
const CLAUDE = { wrapper: 'claude-auto-gabriela', account: '00000000-0000-4000-8000-0000000000c1' } as const;
const CODEX = { wrapper: 'codex-auto-gabriela', account: '00000000-0000-4000-8000-0000000000c2' } as const;

/** What each fake harness paints and then sits on, waiting for a line nobody sends. */
const CLAUDE_IDLE = ['╭────────────────────────────╮', '│ > ', '╰────────────────────────────╯', '  ? for shortcuts'];
const CODEX_IDLE = ['› Ask Codex to do anything', '', '  100% context left'];
/** A harness mid-turn: the status line both harnesses paint while they work. */
const CLAUDE_WORKING = ['⏺ Reading the brief.', '✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)'];

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();

afterEach(async () => {
  await tearDownSupervisedDaemons({ daemons, sockets, roots }, { tmux: TMUX });
}, TEARDOWN_TIMEOUT_MS);

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

/** One fake runtime: its own home with the settings file its harness persists a level in. */
async function runtime(
  root: string,
  bin: string,
  harness: 'claude' | 'codex',
  wrapper: string,
  screen: readonly string[],
): Promise<string> {
  const home = join(root, `${harness}-home`);
  await mkdir(home, { recursive: true });
  if (harness === 'claude') await writeFile(join(home, 'settings.json'), '{"effortLevel":"high"}');
  else await writeFile(join(home, 'config.toml'), 'model = "gpt-5.6-codex"\nmodel_reasoning_effort = "medium"\n');
  const scenario = join(root, `${harness}-scenario.json`);
  const last = screen.length - 1;
  await writeFile(
    scenario,
    JSON.stringify({
      version: 1,
      steps: [
        ...screen.slice(0, last).map(text => ({ type: 'say', text })),
        // The last line is the prompt itself, with the cursor left on it: a ready harness.
        { type: 'ask', text: `${screen[last]}\u001b[1A`, expect: '__never__' },
      ],
    }),
  );
  await executable(join(bin, wrapper), [
    '#!/bin/sh',
    `export ${harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}="${home}"`,
    `export FY_E2E_HARNESS_SCRIPT="${scenario}"`,
    `export FY_E2E_HARNESS_INVOCATIONS="${join(root, `${harness}-invocations.jsonl`)}"`,
    `exec bun '${join(REPOSITORY, 'scripts/test/fake-harness.ts')}' "$@"`,
  ]);
  return home;
}

interface BootedDaemon {
  readonly port: number;
  readonly token: string;
  readonly logFile: string;
}

/** A real `fyd`, launched by the CLI's real supervisor, with one Claude and one Codex runtime. */
async function boot(claudeScreen: readonly string[]): Promise<BootedDaemon> {
  if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-idle-'));
  roots.add(root);
  const port = await freeLoopbackPort();
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
    JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'https://off.example', enabled: false } }),
    { mode: 0o600 },
  );

  const claudeHome = await runtime(root, bin, 'claude', CLAUDE.wrapper, claudeScreen);
  const codexHome = await runtime(root, bin, 'codex', CODEX.wrapper, CODEX_IDLE);
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
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true,
    'the daemon to answer its health probe',
    { pollMs: 50, evidence: async () => await readFile(layout.logFile, 'utf8').catch(() => '(no log)') },
  );
  const token = (await readFile(join(stateHome, 'api-token'), 'utf8')).trim();
  return { port, token, logFile: layout.logFile };
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

/**
 * The pane frame the session page polls, once the harness has painted `marker`.
 *
 * The page reads this route on a timer while the session is live; here it is read until the fake has
 * painted its screen, because a frame captured before the harness drew anything proves nothing.
 */
async function liveFrame(daemon: BootedDaemon, view: SessionView, marker: string): Promise<string> {
  const url = `http://127.0.0.1:${daemon.port}/v1/sessions/${encodeURIComponent(view.config.id)}/snapshot?live=true`;
  let frame = '';
  let attempt = 0;
  await waitFor(
    async () => {
      attempt += 1;
      const response = await fetch(url, { headers: headers(daemon, `snap-${attempt}`) });
      frame = response.ok ? await response.text() : '';
      return frame.includes(marker);
    },
    `the pane to show ${marker}`,
    { pollMs: 50, evidence: async () => `${frame}\n${await logOf(daemon)}` },
  );
  return frame;
}

describe('a brand-new session nobody has asked anything yet', () => {
  it('should read ready, with its launch model and level, for both a Claude and a Codex runtime', async () => {
    // Arrange
    const daemon = await boot(CLAUDE_IDLE);

    for (const [wrapper, model, effort, marker] of [
      [CLAUDE.wrapper, 'claude-opus-5[1m]', 'high', '? for shortcuts'],
      [CODEX.wrapper, 'gpt-5.6-codex', 'medium', '100% context left'],
    ] as const) {
      // Act
      const view = await startIdle(daemon, wrapper);
      const frame = await liveFrame(daemon, view, marker);

      // Assert — the document the page renders from names the launch runtime before any transcript.
      should(view.state).match({ status: 'running', turn: 0 });
      should(view.config.model).equal(model);
      should(view.config.launchReasoningEffort).equal(effort);
      // The live frame carries no status line, and the page's own model calls the session ready.
      should(parsePaneActivity(frame)).be.null();
      should(sessionAtPrompt(view, { read: true, activity: parsePaneActivity(frame) })).be.true();
    }
  }, 90_000);

  it('should still read working while the harness paints its own status line', async () => {
    // Arrange — a Claude harness that is mid-turn on screen.
    const daemon = await boot(CLAUDE_WORKING);

    // Act
    const view = await startIdle(daemon, CLAUDE.wrapper);
    const frame = await liveFrame(daemon, view, 'Pontificating');

    // Assert
    const activity = parsePaneActivity(frame);
    should(activity).match({ harness: 'claude', verb: 'Pontificating…', elapsed: '3s' });
    should(sessionAtPrompt(view, { read: true, activity })).be.false();
  }, 90_000);
});

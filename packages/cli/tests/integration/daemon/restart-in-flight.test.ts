import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type SendRecord,
  SendRecordSchema,
  SendResultSchema,
  type SessionView,
  SessionViewSchema,
} from '@ferretry/protocol';
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
import { FileDaemonRestartMarker, restartMarkerPath } from '../../../src/adapters/daemon/restart-marker.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';
import { TEARDOWN_TIMEOUT_MS, tearDownSupervisedDaemons } from '../support/supervised-daemon-teardown.ts';

/**
 * THE DAEMON RESTARTS UNDER A FERRET THAT IS MID-TURN, end to end (docs/updating.md § Ferrets keep
 * running): a real `fyd`, real tmux, a fake Claude that reads what is typed into it and writes the
 * transcript record real Claude writes, and the real `fy` and `fy mcp serve` processes a ferret runs.
 *
 * The daemon is taken down and brought back the way a restart does it — SIGTERM, then a new process on
 * the same state home and port — while three things are in flight: a `fy` call the ferret makes, an MCP
 * tool call, and a message sent to it. All three must land once the new daemon serves; none may fail.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const FY_ENTRY = join(REPOSITORY, 'packages/cli/bin/fy.ts');
const TMUX = Bun.which('tmux');
const BASH = Bun.which('bash');
const CLAUDE = { wrapper: 'claude-auto-gabriela', account: '00000000-0000-4000-8000-0000000000c1' } as const;

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();
const children = new Set<Bun.Subprocess>();

afterEach(async () => {
  for (const child of children) child.kill();
  children.clear();
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

/**
 * A fake Claude: an idle prompt that echoes what is typed into its composer and, on Enter, appends the
 * `type: "user"` record real Claude writes to `<CLAUDE_CONFIG_DIR>/projects/<cwd slug>/<session>.jsonl`,
 * then shows the empty prompt again. While `<root>/claude-working` exists it draws Claude's working
 * line instead, which is what makes the daemon read the ferret as mid-turn. It also writes down the
 * environment it was launched with — the session's own id and credential, which a ferret's `fy` and
 * `fy mcp serve` inherit.
 */
async function fakeClaude(root: string, bin: string, cwd: string): Promise<string> {
  const home = join(root, 'claude-home');
  await mkdir(home, { recursive: true });
  const projects = join(home, 'projects', cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-'));
  const script = FAKE_CLAUDE.replaceAll('@BASH@', String(BASH))
    .replaceAll('@HOME@', home)
    .replaceAll('@ROOT@', root)
    .replaceAll('@PROJECTS@', projects);
  await executable(join(bin, CLAUDE.wrapper), script.trimEnd().split('\n'));
  return home;
}

/** The fake's script. An empty composer parks the cursor at the start of the prompt line; typed text moves it past. */
const FAKE_CLAUDE = String.raw`#!@BASH@
export CLAUDE_CONFIG_DIR="@HOME@"
env > '@ROOT@/claude-env.txt'
sid=""
while [ $# -gt 0 ]; do if [ "$1" = --session-id ]; then sid="$2"; shift; fi; shift; done
mkdir -p '@PROJECTS@'
file='@PROJECTS@'/"$sid".jsonl
working='@ROOT@/claude-working'
stty -echo -icanon 2>/dev/null
buf=""; n=0
draw() {
  printf '\033[H\033[2J'
  if [ -f "$working" ]; then printf '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > \n\033[1A'
  elif [ -z "$buf" ]; then printf '  ? for shortcuts\n╭──────────────╮\n│ > \n\033[1A'
  else printf '  ? for shortcuts\n╭──────────────╮\n│ > %s' "$buf"; fi
}
state() { if [ -f "$working" ]; then echo w; else echo "i$buf"; fi; }
draw; last="$(state)"
while :; do
  if IFS= read -r -s -n1 -t 0.1 ch; then
    if [ -z "$ch" ]; then
      if [ -n "$buf" ]; then
        n=$((n+1)); ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
        printf '{"type":"user","uuid":"u-%s-%s","sessionId":"%s","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$sid" "$n" "$sid" "$ts" "$buf" >> "$file"
        buf=""
      fi
      draw
    elif [ "$ch" = $'\x15' ]; then buf=''
    else buf="$buf$ch"; fi
  fi
  now="$(state)"
  if [ "$now" != "$last" ]; then draw; last="$now"; fi
done
`;

interface BootedDaemon {
  readonly port: number;
  readonly token: string;
  readonly root: string;
  readonly stateHome: string;
  readonly cwd: string;
  readonly searchPath: string;
  readonly logFile: string;
  /** Starts a new daemon process on the same state home and port. */
  start(): Promise<void>;
  /** SIGTERMs the running daemon and waits until nothing answers. */
  stop(): Promise<void>;
}

const healthy = async (port: number): Promise<boolean> =>
  (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok === true;

/** A real `fyd`, launched by the CLI's real supervisor, with one fake Claude runtime. */
async function boot(): Promise<BootedDaemon> {
  if (TMUX === null || BASH === null) throw new Error('tmux and bash are required for this journey');
  const root = await mkdtemp(join(tmpdir(), 'fy-restart-'));
  roots.add(root);
  const port = await freeLoopbackPort();
  const bin = join(root, 'bin');
  const stateHome = join(root, 'state');
  const cwd = join(root, 'work');
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
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
  const claudeHome = await fakeClaude(root, bin, cwd);
  const { buildFleetManifest } = await import('@ferretry/fleet');
  await writeFile(
    join(stateHome, 'fleet', 'manifest.json'),
    JSON.stringify(
      buildFleetManifest({
        generatedAt: '2026-10-21T00:00:00.000Z',
        accounts: [
          {
            id: CLAUDE.account,
            kind: 'claude',
            mode: 'auto',
            wrapper: join(bin, CLAUDE.wrapper),
            home: claudeHome,
            displayName: 'Gabriela claude',
            defaultModel: 'claude-opus-5[1m]',
            models: [{ id: 'claude-opus-5[1m]', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ),
    { mode: 0o600 },
  );

  const searchPath = `${bin}:/usr/bin:/bin`;
  // Fail closed rather than let the daemon find a real harness and copy this machine's login.
  should(Bun.which('claude', { PATH: searchPath })).equal(null);
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
  let pid: number | undefined;
  const start = async (): Promise<void> => {
    const handle = await supervisor.start(fyd);
    pid = handle.pid;
    if (pid !== undefined) daemons.add(pid);
    for (let attempt = 0; attempt < 400 && !(await healthy(port)); attempt += 1) await Bun.sleep(50);
    if (!(await healthy(port))) throw new Error(`fyd never served\n${await logOf(layout.logFile)}`);
  };
  const stop = async (): Promise<void> => {
    if (pid === undefined) throw new Error('no daemon to stop');
    process.kill(pid, 'SIGTERM');
    daemons.delete(pid);
    for (let attempt = 0; attempt < 400 && (await healthy(port)); attempt += 1) await Bun.sleep(25);
    for (let attempt = 0; attempt < 400 && alive(pid); attempt += 1) await Bun.sleep(25);
    pid = undefined;
  };
  await start();
  const token = (await readFile(join(stateHome, 'api-token'), 'utf8')).trim();
  return { port, token, root, stateHome, cwd, searchPath, logFile: layout.logFile, start, stop };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const logOf = async (logFile: string): Promise<string> =>
  `--- fyd.log ---\n${await readFile(logFile, 'utf8').catch(() => '(no log)')}`;

const headers = (daemon: BootedDaemon, requestId: string): Record<string, string> => ({
  authorization: `Bearer ${daemon.token}`,
  'content-type': 'application/json',
  'x-ferretry-client': 'cli',
  'x-fy-request-id': requestId,
});

async function startIdle(daemon: BootedDaemon): Promise<SessionView> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
    method: 'POST',
    headers: headers(daemon, 'req-start'),
    body: JSON.stringify({ agent: CLAUDE.wrapper, mode: 'interactive', name: 'Gabriela', cwd: daemon.cwd }),
  });
  const body = await response.text();
  should(response.status).equal(201, `${body}\n${await logOf(daemon.logFile)}`);
  return SessionViewSchema.parse(JSON.parse(body));
}

/** The environment the fake Claude was launched with: what a ferret's own `fy` inherits. */
async function ferretEnvironment(daemon: BootedDaemon): Promise<Record<string, string>> {
  const path = join(daemon.root, 'claude-env.txt');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.includes('FY_SESSION_ID=')) {
      const pairs = text
        .split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const)
        .filter(([name]) => name.startsWith('FY_'));
      return Object.fromEntries(pairs);
    }
    await Bun.sleep(50);
  }
  throw new Error(`the fake Claude never wrote its environment\n${await logOf(daemon.logFile)}`);
}

/** A process with the environment `fy` sees on this host: the state home, and nothing of the real one. */
function fy(
  daemon: BootedDaemon,
  argv: readonly string[],
  ferret: Record<string, string>,
): Bun.Subprocess<'pipe', 'pipe', 'pipe'> {
  const child = Bun.spawn({
    cmd: [process.execPath, FY_ENTRY, ...argv],
    env: {
      PATH: daemon.searchPath,
      HOME: daemon.root,
      XDG_STATE_HOME: join(daemon.root, 'xdg-state'),
      XDG_CONFIG_HOME: join(daemon.root, 'config-home'),
      FY_HOME: daemon.stateHome,
      // The session commands read FY_URL or the default port, never the state home's own port.
      FY_URL: `http://127.0.0.1:${String(daemon.port)}`,
      NO_COLOR: '1',
      ...ferret,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  return child;
}

const finished = async (child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) => {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const NOTE = /daemon restarting, retrying for up to 60s/gu;

describe('a daemon restart under a ferret that is mid-turn', () => {
  it('lands the ferret’s fy call, its MCP tool call and a message in flight once the new daemon serves', async () => {
    // Arrange — a ferret at its prompt, and the identity its own `fy` would carry.
    const daemon = await boot();
    const session = await startIdle(daemon);
    const ferret = await ferretEnvironment(daemon);
    should(ferret.FY_SESSION_ID).equal(session.config.id);
    // The MCP server a harness starts, initialised while the daemon serves.
    const mcp = fy(daemon, ['mcp', 'serve'], ferret);
    const lines: string[] = [];
    const reader = (async () => {
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of mcp.stdout) {
        pending += decoder.decode(chunk);
        const split = pending.split('\n');
        pending = split.pop() ?? '';
        lines.push(...split.filter(line => line.trim() !== ''));
      }
    })();
    const rpc = (message: unknown): void => {
      mcp.stdin.write(`${JSON.stringify(message)}\n`);
      mcp.stdin.flush();
    };
    const answerTo = async (id: number, budgetMs: number): Promise<Record<string, unknown>> => {
      const started = Date.now();
      for (;;) {
        const found = lines.map(line => JSON.parse(line) as Record<string, unknown>).find(each => each.id === id);
        if (found !== undefined) return found;
        if (Date.now() - started > budgetMs) throw new Error(`no MCP answer to ${String(id)}: ${lines.join('\n')}`);
        await Bun.sleep(50);
      }
    };
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await answerTo(1, 15_000);

    // A message to the ferret, accepted and typed — and the daemon goes down before its first look.
    const sent = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions/${session.config.id}/send`, {
      method: 'POST',
      headers: headers(daemon, 'send-across-the-restart'),
      body: JSON.stringify({ message: 'hello from before the restart' }),
    });
    const sentBody = await sent.text();
    should(sent.ok).be.true(`${sentBody}\n${await logOf(daemon.logFile)}`);
    // Typed, but not yet proven: only a look at the transcript does that, and the first is 2 s away.
    should(SendResultSchema.parse(JSON.parse(sentBody)).fate).not.equal('delivered');
    // A lead's `fy wait` on this ferret, already polling when the daemon goes down.
    const waiting = fy(daemon, ['wait', session.config.id, '--timeout', '12', '--interval', '1', '--keep'], ferret);
    await Bun.sleep(1_000);

    // Act — the restart, with the ferret's calls made while nothing answers.
    await daemon.stop();
    const call = fy(daemon, ['status', session.config.id, '--json'], ferret);
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terminal_list', arguments: {} } });
    await Bun.sleep(1_500);
    await daemon.start();

    // Assert — the wait rode the restart out and ended on its own deadline, never "daemon lost" (69).
    const waited = await finished(waiting);
    should(waited.code).equal(124, waited.stderr);
    should(waited.stderr.match(NOTE)).have.length(1);
    // The fy call answered, saying once that it waited.
    const status = await finished(call);
    should(status.code).equal(0, `${status.stderr}\n${await logOf(daemon.logFile)}`);
    should(SessionViewSchema.parse(JSON.parse(status.stdout)).config.id).equal(session.config.id);
    should(status.stderr.match(NOTE)).have.length(1);
    // The MCP tool call answered as a result, not an error.
    const listed = await answerTo(2, 60_000);
    should(listed).have.property('result');
    should((listed.result as { isError?: boolean }).isError).not.equal(true, JSON.stringify(listed));
    mcp.stdin.end();
    await mcp.exited;
    await reader;
    should(await new Response(mcp.stderr).text()).match(NOTE);
    // The message in flight is confirmed by the new daemon, from the transcript, without being retyped.
    let record: SendRecord | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const read = await fetch(
        `http://127.0.0.1:${daemon.port}/v1/sessions/${session.config.id}/sends/send-across-the-restart`,
        { headers: headers(daemon, `read-send-${String(attempt)}`) },
      );
      record = SendRecordSchema.parse(await read.json());
      if (record.fate === 'delivered') break;
      await Bun.sleep(250);
    }
    should(record?.fate).equal('delivered', `${JSON.stringify(record)}\n${await logOf(daemon.logFile)}`);
    should(record?.attempt ?? 1).equal(1);
  }, 180_000);

  it('keeps a ferret mid-turn mid-turn: the new daemon adopts its pane with its turn state as it was', async () => {
    // Arrange — the ferret is working, and the daemon has seen it working.
    const daemon = await boot();
    const session = await startIdle(daemon);
    await writeFile(join(daemon.root, 'claude-working'), '');
    const state = async () => {
      const read = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions/${session.config.id}`, {
        headers: headers(daemon, `read-${String(Date.now())}`),
      });
      return SessionViewSchema.parse(await read.json()).state;
    };
    for (let attempt = 0; attempt < 120 && (await state()).turnState !== 'working'; attempt += 1) await Bun.sleep(150);
    should((await state()).turnState).equal('working', await logOf(daemon.logFile));

    // Act
    await daemon.stop();
    await daemon.start();
    const after = await state();

    // Assert — the same live session, still mid-turn, from its first answer.
    should(after.status).not.equal('stopped');
    should(after.turnState).equal('working', JSON.stringify(after));
  }, 120_000);

  it('makes a person’s fy call wait only while a restart is vouched for', async () => {
    // Arrange
    const daemon = await boot();
    const marker = new FileDaemonRestartMarker(restartMarkerPath(daemon.stateHome));
    await daemon.stop();

    // Act — no marker: a stopped daemon fails at once. A marker: the call waits for the new daemon.
    const refused = await finished(fy(daemon, ['ps', '--json'], {}));
    await marker.mark(Date.now() + 120_000);
    const waiting = fy(daemon, ['ps', '--json'], {});
    await Bun.sleep(1_500);
    await daemon.start();
    await marker.clear();
    const listed = await finished(waiting);

    // Assert
    should(refused.code).not.equal(0);
    should(refused.stderr).not.match(NOTE);
    should(listed.code).equal(0, listed.stderr);
    should(JSON.parse(listed.stdout)).be.an.Array();
    should(listed.stderr.match(NOTE)).have.length(1);
  }, 120_000);
});

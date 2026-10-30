/**
 * A STEADY DAEMON TOUCHES ITS STATE HOME A BOUNDED NUMBER OF TIMES A SECOND.
 *
 * On the owner's Mac — 36 sessions, 5 running, endpoint security inspecting every file operation — the
 * daemon spent most of its time in its own state home: every background watcher re-read every session's
 * documents every few seconds, each read walking the home with an `lstat` per directory, opening the
 * layout marker and the document, and parsing the JSON; Codex discovery re-listed and `stat`ed every
 * rollout. Measured here on main before the fix: about 1,700 file system calls a second, 355 of them
 * opens.
 *
 * This boots a REAL `fyd` over a fleet of that shape under `strace`, lets it settle, and counts every
 * file system call on a path inside the state home for a steady window. Only the state home is
 * counted: what a child process (tmux) costs to start belongs to the budget of whoever spawns it.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import { freeLoopbackPort } from '../../integration/support/booted-daemon.ts';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';
import { OWNER_MAC_FLEET, scaledFleet } from '../../integration/support/scaled-fleet.ts';

/** File system calls a second on paths inside the state home, steady. Measured: ~90 after, ~1,700 before. */
const STATE_CALLS_PER_SECOND = 200;
/** Opens of session documents in the whole window: a steady fleet whose documents do not change reads none. */
const DOCUMENT_OPENS = 20;
/** How long the daemon settles before the window opens, and how long the window is. */
const SETTLE_MS = 15_000;
const WINDOW_MS = 15_000;

const TRACED = 'openat,open,statx,newfstatat,lstat,stat,getdents64,readlink,readlinkat';

/** Whether this host can trace a child: strace installed and allowed to attach. */
function canTrace(): boolean {
  if (process.platform !== 'linux' || Bun.which('strace') === null) return false;
  return Bun.spawnSync(['strace', '-f', '-qq', '-o', '/dev/null', 'true']).exitCode === 0;
}

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

const program = (home: string, userHome: string, runMs: number): string => `
  import { buildWorld, start } from ${modulePath('../../../bin/fyd.ts')};
  import { NO_RELAY_DIRECTORY } from ${modulePath('../../../src/lib/relay/discovery.ts')};
  process.env.FY_HOME = ${JSON.stringify(home)};
  const built = buildWorld({}, { userHome: ${JSON.stringify(userHome)} });
  await start({
    ...built,
    notices: {
      step: (name, detail) => {
        if (name === 'ready') process.stdout.write('READY ' + String(Date.now()) + '\\n');
        built.notices.step(name, detail);
      },
      state: message => built.notices.state(message),
    },
    relayDirectory: { read: async () => NO_RELAY_DIRECTORY },
    untilShutdown: () => new Promise(done => setTimeout(done, ${String(runMs)})),
  });
  process.exit(0);
`;

interface Counted {
  readonly calls: number;
  readonly documentOpens: number;
  readonly byPath: ReadonlyMap<string, number>;
}

/** Every traced call inside `home` whose start falls in `[fromMs, toMs)`, from `strace -f -ttt` output. */
function count(trace: string, home: string, fromMs: number, toMs: number): Counted {
  let calls = 0;
  let documentOpens = 0;
  const byPath = new Map<string, number>();
  for (const line of trace.split('\n')) {
    const match = /^\d+\s+(\d+\.\d+)\s+([a-z0-9_]+)\((.*)$/.exec(line);
    if (match === null) continue;
    const atMs = Number(match[1]) * 1_000;
    if (atMs < fromMs || atMs >= toMs) continue;
    const path = /"([^"]*)"/.exec(match[3] ?? '')?.[1];
    if (path === undefined || !path.startsWith(home)) continue;
    calls += 1;
    const shape = `${match[2] ?? ''} ${path.slice(home.length).replace(/scaled-\d\d/g, '<id>')}`;
    byPath.set(shape, (byPath.get(shape) ?? 0) + 1);
    if (match[2] === 'openat' && /\/(session-version|config\.json|state\.json|terminal-pane\.json)$/.test(path))
      documentOpens += 1;
  }
  return { calls, documentOpens, byPath };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('a steady daemon over a fleet the size of the owner’s Mac', () => {
  it.skipIf(!canTrace())(
    `should make at most ${String(STATE_CALLS_PER_SECOND)} state-home file system calls a second`,
    async () => {
      // Arrange — 36 sessions, 5 running, two Codex sessions still undiscovered; small transcripts,
      // because this measures what each tick touches, not what a parse costs.
      const root = await tempDirectory('fyd-state-syscalls-');
      const fleet = await scaledFleet(root, {
        ...OWNER_MAC_FLEET,
        running: 5,
        hugeTranscripts: 0,
        transcriptBytes: 512 * 1024,
        rollouts: 200,
      });
      const port = await freeLoopbackPort();
      await mkdir(join(fleet.home, 'config'), { recursive: true });
      await writeFile(
        join(fleet.home, 'config', 'daemon.json'),
        JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
      );
      const traceFile = join(root, 'trace.txt');
      const runMs = SETTLE_MS + WINDOW_MS + 5_000;

      // Act
      const child = Bun.spawn(
        [
          'strace',
          '-f',
          '-qq',
          '-ttt',
          '-e',
          `trace=${TRACED}`,
          '-o',
          traceFile,
          process.execPath,
          '-e',
          program(fleet.home, fleet.userHome, runMs),
        ],
        {
          stdout: 'pipe',
          stderr: 'ignore',
          env: { ...process.env, FYD_BACKGROUND_DELAY_SECONDS: '0', FYD_WATCHDOG_SECONDS: '0', FYD_STACK_SAMPLER: '0' },
        },
      );
      const output = await new Response(child.stdout).text();
      await child.exited;
      const ready = /READY (\d+)/.exec(output)?.[1];
      if (ready === undefined) throw new Error(`the daemon never reported ready:\n${output}`);
      const fromMs = Number(ready) + SETTLE_MS;
      const counted = count(await readFile(traceFile, 'utf8'), fleet.home, fromMs, fromMs + WINDOW_MS);

      // Assert — a failure names the paths that spent the budget.
      const perSecond = counted.calls / (WINDOW_MS / 1_000);
      const heaviest = [...counted.byPath]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([shape, calls]) => `${String(calls).padStart(6)} ${shape}`)
        .join('\n');
      should(perSecond).be.belowOrEqual(STATE_CALLS_PER_SECOND, `${String(perSecond)}/s:\n${heaviest}`);
      should(counted.documentOpens).be.belowOrEqual(DOCUMENT_OPENS, heaviest);
    },
    120_000,
  );
});

/**
 * AN IDLE DAEMON OVER THE OWNER'S FLEET MAY START NO MORE THAN 30 CHILD PROCESSES A MINUTE.
 *
 * A live daemon with forty-odd sessions, five of them running, was measured starting twenty-three
 * child processes a SECOND while nobody did anything: a `tmux` client per question asked of every pane
 * — alive?, its metadata, its whole scrollback, its visible screen, its identity — plus a system-wide
 * `ps` every few seconds. On a Mac every one of those is an exec the endpoint-security agent inspects
 * and a dynamic link of tmux's libraries, so the polling alone cost a core. None of it shows on a
 * two-session fixture, and nothing failed when it crept back, so this boots a REAL `fyd` over a fleet
 * the owner's size — thirty-six sessions, five running in real panes on the daemon's own tmux server —
 * waits past the boot, and counts every `Bun.spawn` and `Bun.spawnSync` (all of `node:child_process`
 * routes through them in Bun) for the measured window.
 *
 * In a child process, because a boot binds a port, opens a state home and arms timers, and the count
 * must be the daemon's alone.
 */
import { afterAll, describe, it } from 'bun:test';
import { join, resolve } from 'node:path';
import should from 'should';
import { freeLoopbackPort } from '../support/booted-daemon.ts';
import { startFleetPanes } from '../support/fleet-panes.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { type ScaledFleetShape, scaledFleet } from '../support/scaled-fleet.ts';

/** The budget, per minute of an idle daemon. */
const SPAWNS_PER_MINUTE_BUDGET = 30;
/** How long the boot gets before counting starts: its one-off reads are not the idle cost. */
const WARMUP_SECONDS = 12;
/** The counted window: long enough for a liveness tick (30 s) and the reaper sweep the lane opens with. */
const MEASURE_SECONDS = 32;

/** The owner's fleet as the brief measured it, without the 200 MB transcripts a boot test needs. */
const OWNER_IDLE_FLEET: ScaledFleetShape = Object.freeze({
  sessions: 36,
  running: 5,
  hugeTranscripts: 0,
  hugeTranscriptBytes: 0,
  transcriptBytes: 64 * 1024,
  rollouts: 4,
  rolloutBytes: 8 * 1024,
  undiscoveredCodex: 0,
});

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

interface SpawnMeasurement {
  readonly exit: number;
  readonly readyS: number | undefined;
  /** Spawns inside the measured window, keyed by executable basename and its first argument. */
  readonly spawns: Readonly<Record<string, number>>;
  readonly seconds: number;
}

/** The child's whole program: the real `start`, with every spawn counted once the warm-up is over. */
const program = (home: string, userHome: string, port: number): string => `
  import { mkdir, writeFile } from 'node:fs/promises';
  import { basename } from 'node:path';
  import { buildWorld, start } from ${modulePath('../../../bin/fyd.ts')};
  import { NO_RELAY_DIRECTORY } from ${modulePath('../../../src/lib/relay/discovery.ts')};
  process.env.FY_HOME = ${JSON.stringify(home)};
  await mkdir(${JSON.stringify(join(home, 'config'))}, { recursive: true });
  await writeFile(${JSON.stringify(join(home, 'config', 'daemon.json'))}, JSON.stringify({
    host: '127.0.0.1', port: ${String(port)}, relay: { url: 'ws://127.0.0.1:9', enabled: false },
  }));
  const spawns = {};
  let counting = false;
  const label = argv => {
    const words = Array.isArray(argv) ? argv : (argv?.cmd ?? []);
    const name = basename(String(words[0] ?? '?'));
    // tmux's own options come first; the subcommand is the first word after the socket.
    const rest = name === 'tmux' ? words.slice(1).filter((word, index, all) => !word.startsWith('-') && all[index - 1] !== '-S') : words.slice(1);
    return name + ' ' + String(rest[0] ?? '');
  };
  const count = argv => {
    if (!counting) return;
    const key = label(argv);
    spawns[key] = (spawns[key] ?? 0) + 1;
  };
  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  Bun.spawn = (argv, options) => { count(argv); return spawn(argv, options); };
  Bun.spawnSync = (argv, options) => { count(argv); return spawnSync(argv, options); };
  const startedAt = performance.now();
  let readyS;
  const built = buildWorld({}, { userHome: ${JSON.stringify(userHome)} });
  const world = {
    ...built,
    boot: { ...built.boot, stackSampler: async () => undefined },
    notices: {
      step: (name, detail) => {
        if (name === 'ready') readyS = (performance.now() - startedAt) / 1000;
        built.notices.step(name, detail);
      },
      state: message => built.notices.state(message),
    },
    relayDirectory: { read: async () => NO_RELAY_DIRECTORY },
    untilShutdown: () => new Promise(done => {
      setTimeout(() => { counting = true; }, ${String(WARMUP_SECONDS * 1_000)});
      setTimeout(() => { counting = false; done(); }, ${String((WARMUP_SECONDS + MEASURE_SECONDS) * 1_000)});
    }),
  };
  const exit = await start(world);
  process.stdout.write('MEASUREMENT ' + JSON.stringify({ exit, readyS, spawns, seconds: ${String(MEASURE_SECONDS)} }) + '\\n');
  process.exit(0);
`;

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('an idle daemon over a fleet the size of the owner’s', () => {
  it(`should start no more than ${String(SPAWNS_PER_MINUTE_BUDGET)} child processes a minute`, async () => {
    // Arrange
    const fleet = await scaledFleet(await tempDirectory('fyd-idle-spawns'), OWNER_IDLE_FLEET);
    // The running sessions’ panes, named as `scaledFleet` names their tmux sessions.
    const panes = await startFleetPanes(
      fleet.home,
      Array.from({ length: OWNER_IDLE_FLEET.running }, (_, index) => `fy-scaled-${String(index).padStart(2, '0')}`),
      ['sleep', '600'],
      { columns: 120, rows: 40 },
    );
    const port = await freeLoopbackPort();
    const child = Bun.spawn([process.execPath, '-e', program(fleet.home, fleet.userHome, port)], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FYD_BACKGROUND_DELAY_SECONDS: '0', FYD_WATCHDOG_SECONDS: '0' },
    });

    try {
      // Act
      const [output, journal] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      const line = output.split('\n').find(each => each.startsWith('MEASUREMENT '));
      if (line === undefined) throw new Error(`the daemon reported no measurement:\n${output}\n${journal}`);
      const measured = JSON.parse(line.slice('MEASUREMENT '.length)) as SpawnMeasurement;
      const total = Object.values(measured.spawns).reduce((sum, value) => sum + value, 0);
      const perMinute = (total * 60) / measured.seconds;
      // Assert — the boot finished, and the idle window stayed inside the budget; a failure names what spawned.
      should(measured.exit).equal(0);
      should(measured.readyS).be.a.Number();
      should(perMinute).be.belowOrEqual(
        SPAWNS_PER_MINUTE_BUDGET,
        `an idle daemon started ${String(perMinute)} child processes a minute: ${JSON.stringify(measured.spawns)}`,
      );
    } finally {
      await panes.close();
    }
  }, 240_000);
});

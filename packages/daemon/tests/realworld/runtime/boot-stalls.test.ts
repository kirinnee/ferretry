/**
 * NO BOOT STEP MAY HOLD THE EVENT LOOP FOR MORE THAN 200 MS ON A FLEET THE SIZE OF THE ONE THAT STALLED.
 *
 * The owner's Mac — thirty-six sessions, three 200 MB transcripts, thousands of Codex rollouts — stalled
 * its loop for seconds at a time for minutes after every boot until the daemon answered nothing. Each
 * cause was a synchronous pass that grows with the fleet: a whole transcript parsed in one call, lines
 * counted byte by byte through an iterator, every session's tail read at once. None of them shows on a
 * two-session fixture, so this boots a REAL `fyd` over {@link OWNER_MAC_FLEET} — with its housekeeping
 * lane open at once, the worst case — and measures the loop with an independent 20 ms probe the whole
 * time. A block over the budget fails with the stacks JavaScriptCore sampled during it, so the failure
 * names the code to fix rather than only the number.
 *
 * In a child process, because a boot binds a port, opens a state home and arms timers that a test runner
 * shared with other files would also feel — and the probe must measure the daemon's loop alone.
 */
import { afterAll, describe, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import should from 'should';
import { OWNER_MAC_FLEET, scaledFleet } from '../../integration/support/scaled-fleet.ts';
import { freeLoopbackPort } from '../../integration/support/booted-daemon.ts';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';

/** The budget: no single block of the event loop longer than this, from the first step to the last. */
const BLOCK_BUDGET_MS = 200;
/** How long the daemon runs after it starts, so the first housekeeping passes all happen inside it. */
const RUN_SECONDS = 25;

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

interface Block {
  readonly atS: number;
  readonly ms: number;
  readonly stacks: readonly { readonly stack: string; readonly share: number }[];
}

interface BootMeasurement {
  readonly exit: number;
  readonly readyS: number | undefined;
  readonly blocks: readonly Block[];
}

/** The child's whole program: the real `start`, a probe on its loop, and the stack sampler the probe drains. */
const program = (home: string, userHome: string, port: number): string => `
  import { mkdir, writeFile } from 'node:fs/promises';
  import { buildWorld, start } from ${modulePath('../../../bin/fyd.ts')};
  import { JscStackSampler } from ${modulePath('../../../src/adapters/runtime/stall-attribution.ts')};
  import { summariseStacks } from ${modulePath('../../../src/lib/runtime/liveness.ts')};
  import { NO_RELAY_DIRECTORY } from ${modulePath('../../../src/lib/relay/discovery.ts')};
  process.env.FY_HOME = ${JSON.stringify(home)};
  await mkdir(${JSON.stringify(join(home, 'config'))}, { recursive: true });
  await writeFile(${JSON.stringify(join(home, 'config', 'daemon.json'))}, JSON.stringify({
    host: '127.0.0.1', port: ${String(port)}, relay: { url: 'ws://127.0.0.1:9', enabled: false },
  }));
  const sampler = await JscStackSampler.start();
  const startedAt = performance.now();
  const blocks = [];
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    const samples = sampler?.drain() ?? [];
    const late = now - last - 20;
    if (late > ${String(BLOCK_BUDGET_MS)}) blocks.push({ atS: (now - startedAt) / 1000, ms: Math.round(late), stacks: summariseStacks(samples) });
    last = now;
  }, 20);
  let readyS;
  const built = buildWorld({}, { userHome: ${JSON.stringify(userHome)} });
  const world = {
    ...built,
    // The probe owns the sampler: two drains of one profiler would split every stall's samples.
    boot: { ...built.boot, stackSampler: async () => undefined },
    notices: {
      step: (name, detail) => {
        if (name === 'ready') readyS = (performance.now() - startedAt) / 1000;
        built.notices.step(name, detail);
      },
      state: message => built.notices.state(message),
    },
    relayDirectory: { read: async () => NO_RELAY_DIRECTORY },
    untilShutdown: () => new Promise(done => setTimeout(done, ${String(RUN_SECONDS * 1_000)})),
  };
  const exit = await start(world);
  clearInterval(probe);
  process.stdout.write('MEASUREMENT ' + JSON.stringify({ exit, readyS, blocks }) + '\\n');
  process.exit(0);
`;

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('a boot over a fleet the size of the owner’s Mac', () => {
  it(`should never block the event loop for more than ${String(BLOCK_BUDGET_MS)} ms`, async () => {
    // Arrange
    const fleet = await scaledFleet(await tempDirectory('fyd-boot-stalls-'), OWNER_MAC_FLEET);
    const port = await freeLoopbackPort();
    const child = Bun.spawn([process.execPath, '-e', program(fleet.home, fleet.userHome, port)], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        // Housekeeping at once, all of it inside the measured window: the worst case, not the default.
        FYD_BACKGROUND_DELAY_SECONDS: '0',
        FYD_WATCHDOG_SECONDS: '0',
      },
    });

    // Act
    const [output, journal] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    const line = output.split('\n').find(each => each.startsWith('MEASUREMENT '));
    if (line === undefined) throw new Error(`the boot reported no measurement:\n${output}\n${journal}`);
    const measured = JSON.parse(line.slice('MEASUREMENT '.length)) as BootMeasurement;

    // Assert — the boot finished, and nothing held the loop past the budget; a failure names the stacks.
    should(measured.exit).equal(0);
    should(measured.readyS).be.a.Number().and.be.below(15);
    should(measured.blocks).deepEqual([]);
    // And the housekeeping really ran inside the window, so a quiet loop is not a loop with nothing to do.
    const analytics = new Database(join(fleet.home, 'state', 'index', 'analytics.sqlite'), { readonly: true });
    const ingested = analytics.query('select count(*) as rows from analytics_sessions').get() as { rows: number };
    analytics.close();
    should(ingested.rows).be.aboveOrEqual(8);
  }, 240_000);
});

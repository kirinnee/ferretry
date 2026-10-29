/**
 * NO MAIN-THREAD TRANSCRIPT PARSE MAY HOLD THE EVENT LOOP FOR 200 MS, EVEN ON A HOST SHORT OF MEMORY.
 *
 * On an EC2 box whose disk other jobs had saturated, the daemon's loop stalled for 5–38 s at a time, and
 * the sampled stacks named `parseTranscriptJsonl ← parseInSlices ← reconcileFollow` and `Buffer` beside
 * a 272 MB Claude transcript. The parse was already sliced and yielding; what was not sliced was the
 * MEMORY each read moved in single synchronous calls — the read gathered in chunks and joined (one copy
 * of up to 32 MiB), joined again to the line carried from the last read (another), and decoded whole to
 * a string nothing read (a third) — while the history readers parsed whole files of up to 32 MiB in one
 * call. On a host that is swapping to a saturated disk, an allocation is where a thread waits, and the
 * daemon's one thread was making them 32 MiB at a time.
 *
 * So every main-thread path that parses a transcript runs here over a generated transcript far past one
 * bounded read, with multi-megabyte single records, under an independent 10 ms probe. It runs twice:
 * as it is, and — where this host lets an unprivileged user cap a process's memory with
 * `systemd-run --user` — throttled at {@link MEMORY_HIGH}, which reproduces the box. Throttled, before the
 * fix, the window blocked the loop for 0.6–1.8 s (stacks: `concat ← reconcileFollow`, `concat ← readFrom`),
 * the whole read for 0.2–0.3 s and the history listing for 0.3–0.8 s; after it, none past 80 ms. Unthrottled,
 * every path stayed under 110 ms before the fix as well, so the first case guards the budget and the
 * second one is what fails without the fix.
 *
 * In a child process, so the probe measures those paths alone, and so the throttle caps only them.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/** The budget: no single block of the event loop longer than this, on any path. */
const BLOCK_BUDGET_MS = 200;
/** The memory a throttled run may hold before the kernel makes each further allocation wait. */
const MEMORY_HIGH = '250M';
const SESSION = '11111111-1111-4111-8111-111111111111';
const IMPORTED = '22222222-2222-4222-8222-222222222222';

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

interface PathMeasurement {
  readonly path: string;
  readonly maxLagMs: number;
  readonly events: number;
  readonly stacks: readonly { readonly stack: string; readonly share: number }[];
}

/**
 * A Claude transcript of at least `megabytes`, shaped like a long working session: tool calls and their
 * results, and now and then one record of a few megabytes — a pasted screenshot, an edit whose
 * structured patch is sixty thousand lines. The largest record of the owner's 283 MB transcript is 1.3 MB.
 */
async function claudeTranscript(file: string, megabytes: number): Promise<void> {
  let record = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 0, 1) + record * 1_000).toISOString();
  const base = { sessionId: SESSION, parentUuid: null, cwd: '/work', version: '2.1.0' };
  const exchange = (): string => {
    record += 2;
    const id = `tool-${String(record)}`;
    const call = JSON.stringify({
      ...base,
      type: 'assistant',
      uuid: `a-${String(record)}`,
      timestamp: stamp(),
      message: {
        id: `m-${String(record)}`,
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the next file. '.repeat(40) },
          { type: 'tool_use', id, name: 'Read', input: { file_path: '/work/src/index.ts' } },
        ],
      },
    });
    const result = JSON.stringify({
      ...base,
      type: 'user',
      uuid: `u-${String(record)}`,
      timestamp: stamp(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'const x = 1;\n'.repeat(120) }],
      },
      toolUseResult: { type: 'text', file: { filePath: '/work/src/index.ts', content: 'const x = 1;\n'.repeat(120) } },
    });
    return `${call}\n${result}\n`;
  };
  const screenshot = (): string => {
    record += 1;
    return `${JSON.stringify({
      ...base,
      type: 'user',
      uuid: `s-${String(record)}`,
      timestamp: stamp(),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What is wrong on this screen?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(250_000) } },
        ],
      },
    })}\n`;
  };
  const patch = (): string => {
    record += 1;
    const lines = Array.from(
      { length: 60_000 },
      (_, line) => `+  const value${String(line)} = compute(${String(line)});`,
    );
    return `${JSON.stringify({
      ...base,
      type: 'user',
      uuid: `p-${String(record)}`,
      timestamp: stamp(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `edit-${String(record)}`, content: 'Updated.' }],
      },
      toolUseResult: { filePath: '/work/src/generated.ts', structuredPatch: [{ oldStart: 1, newStart: 1, lines }] },
    })}\n`;
  };
  const handle = await open(file, 'w');
  try {
    let written = 0;
    for (let block = 0; written < megabytes * 1024 * 1024; block += 1) {
      const chunk =
        Array.from({ length: 200 }, exchange).join('') +
        (block % 4 === 1 ? screenshot() : block % 4 === 3 ? patch() : '');
      await handle.write(chunk);
      written += Buffer.byteLength(chunk);
    }
    // Ending on ordinary records: a tail that starts inside one record larger than its first window finds
    // no record boundary, and that is a different question from how long the loop is held.
    await handle.write(Array.from({ length: 200 }, exchange).join(''));
  } finally {
    await handle.close();
  }
}

/** The child's whole program: each main-thread parse path, one after another, each under its own probe. */
const program = (transcript: string, userHome: string): string => `
  import { join } from 'node:path';
  import { JscStackSampler } from ${modulePath('../../../src/adapters/runtime/stall-attribution.ts')};
  import { summariseStacks } from ${modulePath('../../../src/lib/runtime/liveness.ts')};
  import { LOOP_PARSE_PACING, NodeTranscriptSource } from ${modulePath('../../../src/adapters/transcript/index.ts')};
  import { NodeConversationFiles } from ${modulePath('../../../src/adapters/imports/node-conversation-files.ts')};
  import { NodeForeignHistoryFiles } from ${modulePath('../../../src/adapters/imports/node-foreign-history-files.ts')};
  import { ConversationImportService } from ${modulePath('../../../src/lib/imports/conversations.ts')};
  import { ForeignHistoryImporter } from ${modulePath('../../../src/lib/imports/foreign-history.ts')};
  import { tailTranscriptEvents } from ${modulePath('../../../src/lib/session/transcript/reader.ts')};
  import { ClaudeTranscriptParser, CodexTranscriptParser, PacedTranscriptParser } from ${modulePath('../../../src/lib/transcript/index.ts')};
  const file = ${JSON.stringify(transcript)};
  const home = ${JSON.stringify(userHome)};
  const claude = new ClaudeTranscriptParser();
  const source = new NodeTranscriptSource(claude);
  const paced = {
    claude: new PacedTranscriptParser(claude, LOOP_PARSE_PACING),
    codex: new PacedTranscriptParser(new CodexTranscriptParser(), LOOP_PARSE_PACING),
  };
  const sampler = await JscStackSampler.start();
  const measurements = [];
  const measure = async (path, run) => {
    await new Promise(done => setTimeout(done, 30));
    sampler?.drain();
    let maxLagMs = 0;
    let stacks = [];
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      const samples = sampler?.drain() ?? [];
      const late = now - last - 10;
      if (late > maxLagMs) { maxLagMs = late; stacks = summariseStacks(samples); }
      last = now;
    }, 10);
    const events = await run();
    // One more turn of the probe, so a block that ended the run is seen before the probe stops.
    await new Promise(done => setTimeout(done, 40));
    clearInterval(probe);
    measurements.push({ path, maxLagMs: Math.round(maxLagMs), events, stacks });
  };
  // A window from long before the transcript began: every bounded read of it, partial lines carried across.
  await measure('window', async () => {
    const window = source.window(file, { sessionId: ${JSON.stringify(SESSION)}, start: { at: 'since', instant: '2000-01-01T00:00:00.000Z' } });
    let events = 0;
    for (let more = true; more; ) {
      const step = await window.next();
      events += step.batch?.events.length ?? 0;
      more = step.more;
    }
    return events;
  });
  await measure('read', async () => (await source.read(file, { sessionId: ${JSON.stringify(SESSION)} })).events.length);
  await measure('tail', async () => (await tailTranscriptEvents(source, file, ${JSON.stringify(SESSION)}, 400)).length);
  await measure('history listing', async () => {
    const roots = { claudeProjects: join(home, '.claude', 'projects'), codexSessions: join(home, '.codex', 'sessions') };
    const listing = await new ForeignHistoryImporter(new NodeForeignHistoryFiles(), roots, paced).list();
    return listing.conversations.reduce((sum, row) => sum + row.eventCount, 0);
  });
  const imports = new ConversationImportService(
    new NodeConversationFiles(),
    [{ harness: 'claude', home: join(home, '.claude'), source: 'computer' }],
    paced,
    { owners: async () => new Map() },
    { adopt: async () => { throw new Error('this measurement adopts nothing'); } },
  );
  await measure('import listing', async () => (await imports.list()).matched);
  process.stdout.write('MEASUREMENT ' + JSON.stringify(measurements) + '\\n');
  process.exit(0);
`;

let transcript = '';
let userHome = '';

beforeAll(async () => {
  const root = await tempDirectory('fyd-io-pressure-transcript-');
  transcript = join(root, 'session.jsonl');
  userHome = join(root, 'home');
  const project = join(userHome, '.claude', 'projects', '-work');
  await mkdir(project, { recursive: true });
  // Three bounded reads and more, so a window carries a partial line across every read boundary.
  await claudeTranscript(transcript, 100);
  // Under the history listing's 32 MiB whole-file cap, so it is parsed whole rather than skipped.
  await claudeTranscript(join(project, `${IMPORTED}.jsonl`), 28);
}, 60_000);

afterAll(async () => {
  await cleanupTempDirectories();
});

/** Runs the program, under `prefix` when one is given, and returns what each path measured. */
async function measured(prefix: readonly string[] = []): Promise<readonly PathMeasurement[]> {
  const child = Bun.spawn([...prefix, process.execPath, '-e', program(transcript, userHome)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = output.split('\n').find(each => each.startsWith('MEASUREMENT '));
  if (line === undefined) throw new Error(`the measurement reported nothing:\n${output}\n${errors}`);
  return JSON.parse(line.slice('MEASUREMENT '.length)) as readonly PathMeasurement[];
}

/** Every path ran over real records, and none held the loop past the budget; a failure names the stacks. */
function assertWithinBudget(measurements: readonly PathMeasurement[]): void {
  should(measurements.map(each => each.path)).deepEqual([
    'window',
    'read',
    'tail',
    'history listing',
    'import listing',
  ]);
  for (const each of measurements.slice(0, 4)) should(each.events).be.above(0, `${each.path} parsed nothing`);
  const over = measurements.filter(each => each.maxLagMs >= BLOCK_BUDGET_MS);
  should(over).deepEqual([]);
}

/** The prefix that caps the child's memory, or nothing where this host does not let a user do that. */
async function memoryThrottle(): Promise<readonly string[] | undefined> {
  const prefix = ['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryHigh=${MEMORY_HIGH}`];
  try {
    const probe = Bun.spawn([...prefix, 'true'], { stdout: 'ignore', stderr: 'ignore' });
    return (await probe.exited) === 0 ? prefix : undefined;
  } catch {
    return undefined;
  }
}

const throttle = await memoryThrottle();

describe('main-thread transcript parsing over a transcript past one bounded read', () => {
  it(`should never block the event loop for ${String(BLOCK_BUDGET_MS)} ms`, async () => {
    // Act
    const measurements = await measured();

    // Assert
    assertWithinBudget(measurements);
  }, 60_000);

  it.if(throttle !== undefined)(
    `should never block the event loop for ${String(BLOCK_BUDGET_MS)} ms while memory is capped at ${MEMORY_HIGH}`,
    async () => {
      // Act
      const measurements = await measured(throttle);

      // Assert
      assertWithinBudget(measurements);
    },
    90_000,
  );
});

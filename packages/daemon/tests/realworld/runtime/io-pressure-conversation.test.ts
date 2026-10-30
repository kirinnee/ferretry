/**
 * A MESSAGES READ OVER A LONG TRANSCRIPT MAY NOT HOLD THE EVENT LOOP FOR 200 MS, EVEN SHORT OF MEMORY.
 *
 * A messages page used to be one complete read of the transcript from byte zero, bounded at 32 MiB, so a
 * long session could not be paged at all and the PWA's "Last messages" — up to forty pages from the
 * start — would have been forty whole-file reads if it could. The conversation index folds the file once,
 * a bounded read at a time, and extends that fold by what was appended. Folding is now the expensive
 * path: up to 32 MiB per step read, parsed, and hashed into the raw-prefix chain. It runs on the main
 * thread, paced — the parse in slices, the hashing in budgeted steps — and this is the proof that the
 * pacing holds.
 *
 * The transcript is past one bounded read, shaped like the owner's 272 MB session: tool exchanges,
 * conversation turns whose assistant records report usage, multi-megabyte screenshot records (whose
 * base64 #875 references rather than parses) and one record past the old 4 MiB pending bound, placed
 * across a bounded-read boundary. The first fold and an incremental extend are each measured under an
 * independent 10 ms probe, as they are and — where this host lets an unprivileged user cap a process's
 * memory with `systemd-run --user` — throttled at {@link MEMORY_HIGH}, which is how the EC2 box that
 * stalled for 5–38 s looked. The throttled run is repeated, because one quiet run proves little.
 *
 * In a child process, so the probe measures the fold alone, and so the throttle caps only it.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';

/** The budget: no single block of the event loop longer than this, on either path. */
const BLOCK_BUDGET_MS = 200;
/** The memory a throttled run may hold before the kernel makes each further allocation wait. */
const MEMORY_HIGH = '250M';
/** How many times the throttled run repeats. */
const THROTTLED_RUNS = 3;
const SESSION = '11111111-1111-4111-8111-111111111111';
const MiB = 1024 * 1024;

const modulePath = (relative: string): string => JSON.stringify(resolve(import.meta.dir, relative));

interface PathMeasurement {
  readonly path: string;
  readonly maxLagMs: number;
  readonly rows: number;
  readonly elapsedMs: number;
  readonly stacks: readonly { readonly stack: string; readonly share: number }[];
}

let record = 0;
const stamp = (): string => {
  record += 1;
  return new Date(Date.UTC(2026, 0, 1) + record * 1_000).toISOString();
};
const base = { sessionId: SESSION, parentUuid: null, cwd: '/work', version: '2.1.0' };

/** A question, the assistant's answer with its usage, a tool call and its result. */
function exchange(): string {
  const id = `tool-${String(record)}`;
  return [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Why does this fail? '.repeat(10) }] } },
    {
      type: 'assistant',
      message: {
        id: `m-${String(record)}`,
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'Reading the next file. '.repeat(40) },
          { type: 'tool_use', id, name: 'Read', input: { file_path: '/work/src/index.ts' } },
        ],
        usage: { input_tokens: 2, output_tokens: 93, cache_read_input_tokens: 41_943 },
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'const x = 1;\n'.repeat(120) }],
      },
      toolUseResult: { type: 'text', file: { filePath: '/work/src/index.ts', content: 'const x = 1;\n'.repeat(120) } },
    },
  ]
    .map(value => `${JSON.stringify({ ...base, uuid: `r-${String(record)}`, timestamp: stamp(), ...value })}\n`)
    .join('');
}

/** A pasted screenshot of about `bytes`: one record, almost all of it one base64 string. */
function screenshot(bytes: number): string {
  return `${JSON.stringify({
    ...base,
    type: 'user',
    uuid: `s-${String(record)}`,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is wrong on this screen?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(Math.ceil(bytes / 11)) },
        },
      ],
    },
  })}\n`;
}

/**
 * At least `megabytes` of transcript, with a 2.75 MB screenshot every few blocks and one 6 MiB screenshot
 * straddling the first 32 MiB bounded-read boundary, so a step carries it partly read across into the next.
 */
async function transcript(file: string, megabytes: number): Promise<void> {
  const handle = await open(file, 'w');
  try {
    let written = 0;
    let straddled = false;
    for (let block = 0; written < megabytes * MiB; block += 1) {
      let chunk = Array.from({ length: 100 }, exchange).join('');
      if (block % 6 === 2) chunk += screenshot(2_750_000);
      if (!straddled && written + Buffer.byteLength(chunk) > 29 * MiB) {
        chunk += screenshot(6 * MiB);
        straddled = true;
      }
      await handle.write(chunk);
      written += Buffer.byteLength(chunk);
    }
  } finally {
    await handle.close();
  }
}

/** A few more exchanges and a screenshot, as a working session appends between two looks. */
const appended = (): string => Array.from({ length: 50 }, exchange).join('') + screenshot(2_750_000);

/** The child's whole program: the first fold, then an extend over the bytes in `append`, each under its own probe. */
const program = (file: string, append: string): string => `
  import { appendFile } from 'node:fs/promises';
  import { JscStackSampler } from ${modulePath('../../../src/adapters/runtime/stall-attribution.ts')};
  import { summariseStacks } from ${modulePath('../../../src/lib/runtime/liveness.ts')};
  import { LOOP_PARSE_PACING, NodeTranscriptFileRuntime, NodeTranscriptSource } from ${modulePath('../../../src/adapters/transcript/index.ts')};
  import { ConversationIndex } from ${modulePath('../../../src/lib/session/transcript/conversation-index.ts')};
  import { ClaudeTranscriptParser } from ${modulePath('../../../src/lib/transcript/index.ts')};
  const file = ${JSON.stringify(file)};
  const index = new ConversationIndex([new NodeTranscriptSource(new ClaudeTranscriptParser())], new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING);
  const target = { sessionId: ${JSON.stringify(SESSION)}, harness: 'claude' };
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
    const started = performance.now();
    const rows = await run();
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    const elapsedMs = Math.round(performance.now() - started);
    // One more turn of the probe, so a block that ended the run is seen before the probe stops.
    await new Promise(done => setTimeout(done, 40));
    clearInterval(probe);
    measurements.push({ path, maxLagMs: Math.round(maxLagMs), rows, elapsedMs, rssMb, stacks });
  };
  await measure('first fold', async () => (await index.rows(target, file)).length);
  await appendFile(file, await Bun.file(${JSON.stringify(append)}).bytes());
  await measure('extend', async () => (await index.rows(target, file)).length);
  process.stdout.write('MEASUREMENT ' + JSON.stringify(measurements) + '\\n');
  process.exit(0);
`;

let directory = '';
let source = '';
/** What a working session appends between the two looks, as a file the child appends from. */
let append = '';

beforeAll(async () => {
  directory = await tempDirectory('fyd-io-pressure-conversation-');
  source = join(directory, 'session.jsonl');
  // Past one bounded read, so the fold steps and carries a record across a read boundary.
  await transcript(source, 100);
  append = join(directory, 'appended.jsonl');
  await Bun.write(append, appended());
}, 60_000);

afterAll(async () => {
  await cleanupTempDirectories();
});

/**
 * Runs the program, under `prefix` when one is given. Each run appends to the same transcript, so a later
 * run folds a slightly longer file: what is asserted is relative to its own first fold.
 */
async function measured(prefix: readonly string[] = []): Promise<readonly PathMeasurement[]> {
  const child = Bun.spawn([...prefix, process.execPath, '-e', program(source, append)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = output.split('\n').find(each => each.startsWith('MEASUREMENT '));
  if (line === undefined) throw new Error(`the measurement reported nothing:\n${output}\n${errors}`);
  return JSON.parse(line.slice('MEASUREMENT '.length)) as readonly PathMeasurement[];
}

/** Both paths folded every row, and neither held the loop past the budget; a failure names the stacks. */
function assertWithinBudget(measurements: readonly PathMeasurement[]): void {
  should(measurements.map(each => each.path)).deepEqual(['first fold', 'extend']);
  const [first, extend] = measurements as [PathMeasurement, PathMeasurement];
  should(first.rows).be.above(5_000);
  // 50 exchanges of a question and an answer, and the screenshot's own text.
  should(extend.rows).equal(first.rows + 101);
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

describe('folding a conversation past one bounded read on the main thread', () => {
  it(`should never block the event loop for ${String(BLOCK_BUDGET_MS)} ms`, async () => {
    // Act
    const measurements = await measured();

    // Assert
    assertWithinBudget(measurements);
  }, 60_000);

  it.if(throttle !== undefined)(
    `should never block the event loop for ${String(BLOCK_BUDGET_MS)} ms while memory is capped at ${MEMORY_HIGH}, run after run`,
    async () => {
      for (let run = 0; run < THROTTLED_RUNS; run += 1) {
        // Act
        const measurements = await measured(throttle);

        // Assert
        assertWithinBudget(measurements);
      }
    },
    120_000,
  );
});

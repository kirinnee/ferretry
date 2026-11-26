import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FOLDER_PART_NAMES } from 'durian-markdown';
import { answer } from '../../app/hypermedia/durian-answer.ts';
import type { ReadRequest, WorkerMessage } from '../../app/hypermedia/durian-wire.ts';
import { durianBuild } from '../../app/vite-durian.ts';
import { buildFiles } from './support/bundle-size.ts';

/**
 * THE BUILT PARSER WORKER, WITH ITS PARTS AND KATEX FETCHED ON DEMAND, ANSWERS AS THE EAGER PARSER DOES (U1 review, item 2).
 *
 * The size budget (`hypermedia-size.test.ts`) holds that the folder parts' parsers and KaTeX are chunks of their own. This holds that
 * nothing is lost by it: the production Vite build, with the shell's own Durian plugin, is written to a folder and run as a real worker,
 * and each message below is answered by it and by Durian's own registry with every part in it, in this process. The two documents must be
 * equal, whatever the worker had to fetch to make its own.
 *
 *  - THE PRODUCT'S WORKER (`app/hypermedia/durian-worker.ts`): a message the way the page reads it. The product holds every folder part as
 *    code before Durian reads it, so the one lazy thing a message reaches is KaTeX, through a formula in a sentence.
 *  - THE WORKER WITH NOTHING HELD (`fixtures/lazy-parts-worker.ts`): Durian's `parse` behind the same loop, given the sample of EVERY part
 *    Durian ships (its own `sample.md`), so the parser of each part is fetched and used, which is what the unit that un-holds a part relies on.
 */
const conversation = resolve(import.meta.dir, '../..');
const durianRoot = dirname(createRequire(join(conversation, 'package.json')).resolve('durian-markdown/package.json'));
const scratch = mkdtempSync(join(tmpdir(), 'fy-lazy-worker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Running {
  /** Asks for a message and waits for its answer: every note the worker sent for the ask, in order. */
  readonly ask: (source: string) => { readonly request: ReadRequest; readonly notes: Promise<WorkerMessage[]> };
  readonly stop: () => void;
}

/** Builds `entry` the way the page's worker is built, writes the chunks to a folder of their own, and runs the entry as a real worker. */
async function run(name: string, entry: string): Promise<Running> {
  const built = await buildFiles({
    root: conversation,
    entry,
    // A worker's own build, with the plugins a worker is given (no DOM entity decoder), and without the preload helper Vite leaves out of a worker.
    plugins: [durianBuild.plugin, durianBuild.workerPlugin],
    modulePreload: false,
  });
  const folder = join(scratch, name);
  for (const [file, code] of built.files) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), code);
  }
  const worker = new Worker(join(folder, built.entry));
  const waiting = new Map<number, (notes: WorkerMessage[]) => void>();
  const notes = new Map<number, WorkerMessage[]>();
  const up = Promise.withResolvers<void>();
  worker.onmessage = event => {
    const message = event.data as WorkerMessage;
    if (message.kind === 'ready') {
      up.resolve();
      return;
    }
    const seen = notes.get(message.id) ?? [];
    seen.push(message);
    notes.set(message.id, seen);
    if (message.kind === 'read' || message.kind === 'text' || message.kind === 'failed')
      waiting.get(message.id)?.(seen);
  };
  await up.promise;
  let next = 1;
  return {
    ask: source => {
      const request: ReadRequest = { kind: 'read', id: next++, source, idPrefix: 'dh-x-', arriving: false };
      const result = new Promise<WorkerMessage[]>((resolveNotes, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer for ${source.slice(0, 40)}`)), 20_000);
        waiting.set(request.id, seen => {
          clearTimeout(timer);
          resolveNotes(seen);
        });
      });
      worker.postMessage(request);
      return { request, notes: result };
    },
    stop: () => worker.terminate(),
  };
}

let product: Running;
let open: Running;
/** Durian's own `parse` of every part's sample, from a process with nothing locked (`fixtures/eager-parse.ts`), by part. */
const eagerDocuments = new Map<string, unknown>();
beforeAll(async () => {
  const files = FOLDER_PART_NAMES.map(name => join(durianRoot, 'src/parts', name, 'sample.md'));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/eager-parse.ts'), ...files], {
    cwd: conversation,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [text, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the eager parse did not run (${code}):\n${errors}`);
  const documents = JSON.parse(text) as Record<string, unknown>;
  for (const [at, name] of FOLDER_PART_NAMES.entries()) eagerDocuments.set(name, documents[files[at] ?? '']);
  product = await run('product', resolve(conversation, 'app/hypermedia/durian-worker.ts'));
  open = await run('open', resolve(import.meta.dir, 'fixtures/lazy-parts-worker.ts'));
}, 240_000);
afterAll(() => {
  product.stop();
  open.stop();
});

const kinds = (seen: readonly WorkerMessage[]): string[] => seen.map(message => message.kind);
const FENCE = '`'.repeat(3);

/** The eager answer to the same ask, from Durian's own registry, through the product's own `answer`. */
const eager = (request: ReadRequest): WorkerMessage => ({ ...answer(request), id: request.id }) as WorkerMessage;
const sampleOf = (name: string): string => readFileSync(join(durianRoot, 'src/parts', name, 'sample.md'), 'utf8');

describe("the product's built worker", () => {
  test('a message that uses no part and no formula fetches nothing: its answer is its only note', async () => {
    const source = [
      '# A heading',
      '',
      'Some **prose**, a [link](https://example.com) and `code`.',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const { request, notes: seen } = product.ask(source);
    const got = await seen;
    expect(kinds(got)).toEqual(['read']);
    expect(got[0]).toEqual(eager(request));
  });

  test('a formula in a sentence fetches KaTeX, says so, and answers what the eager parser does', async () => {
    const source = 'The area is $\\pi r^2$ and the sum $\\sum_{k=1}^{n} k$.';
    const { request, notes: seen } = product.ask(source);
    const got = await seen;
    expect(kinds(got)).toEqual(['loading', 'working', 'read']);
    expect(got[2]).toEqual(eager(request));
    expect(JSON.stringify(got[2])).toContain('annotation');
  });

  test('a formula that KaTeX refuses is the same problem the eager parser reports', async () => {
    const source = 'Broken: $\\frac{1}{$ and a banned $\\href{x}{y}$.';
    const { request, notes: seen } = product.ask(source);
    const got = await seen;
    expect(got[got.length - 1]).toEqual(eager(request));
  });

  test('the second message with a formula fetches nothing more: the library stays', async () => {
    const { request, notes: seen } = product.ask('And again $e^{i\\pi}+1=0$.');
    const got = await seen;
    expect(kinds(got)).toEqual(['read']);
    expect(got[0]).toEqual(eager(request));
  });

  test('two asks sent together are answered one at a time, in the order they came', async () => {
    const first = product.ask(`${FENCE}log\n2026-01-01 INFO started\n2026-01-01 ERROR failed\n${FENCE}`);
    const second = product.ask('plain text');
    const [a, b] = await Promise.all([first.notes, second.notes]);
    expect(a[a.length - 1]).toEqual(eager(first.request));
    expect(kinds(b)).toEqual(['read']);
    expect(b[0]).toEqual(eager(second.request));
  });

  for (const name of FOLDER_PART_NAMES)
    test(`the ${name} part's own sample reads as the eager parser reads it (held as code in a message)`, async () => {
      const { request, notes: seen } = product.ask(sampleOf(name));
      const got = await seen;
      expect(got[got.length - 1]).toEqual(eager(request));
    });
});

/** Whether the part's parse reaches an evaluator the build leaves out on purpose: charts are held as code (`chart-held.ts`), so the chart kinds are read as a problem. */
const HELD_EVALUATOR = new Set(['chart-kinds']);

describe('the built worker with nothing held', () => {
  /** The part samples that name a part whose parser is fetched when the message is read: all of them. */
  for (const name of FOLDER_PART_NAMES)
    test(`the ${name} part is fetched when its sample is read, and the document is Durian's own`, async () => {
      const { notes: seen } = open.ask(sampleOf(name));
      const got = await seen;
      const last = got[got.length - 1];
      expect(last?.kind).toBe('read');
      // The first message with a part is the one that fetches it.
      expect(kinds(got)).toContain('loading');
      if (HELD_EVALUATOR.has(name)) return;
      expect(last?.kind === 'read' ? last.doc : null).toEqual(eagerDocuments.get(name) as never);
    });

  test('a part is fetched once: the second message with it says nothing on the way', async () => {
    const second = await open.ask(sampleOf('sequence')).notes;
    expect(kinds(second)).toEqual(['read']);
  });

  test('a message that has two parts and a formula fetches all three, however many rounds that takes, and reads each as Durian reads it', async () => {
    const source = [sampleOf('gantt'), '', 'And a formula $\\sqrt{2}$ beside a graph:', '', sampleOf('graph')].join(
      '\n',
    );
    const { notes: seen } = open.ask(source);
    const got = await seen;
    expect(got.slice(0, -1).every(message => message.kind === 'loading' || message.kind === 'working')).toBe(true);
    const last = got[got.length - 1];
    expect(last?.kind).toBe('read');
    const blocks = JSON.stringify(last?.kind === 'read' ? last.doc : null);
    for (const type of ['gantt', 'graph']) expect(blocks).toContain(`"type":"${type}"`);
    expect(blocks).toContain('annotation');
  });
});

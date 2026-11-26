/**
 * THE FOLDER PARTS AND KATEX THAT ARRIVE WHEN A MESSAGE FIRST NEEDS THEM (U1 review, item 2): the stand-ins the build puts in place of
 * Durian's part registry and of KaTeX (`app/hypermedia/durian-shims/lazy-part.ts`, `katex-late.ts`, `app/vite-durian-lazy.ts`), held to
 * the installed release, and the worker's loop that fetches what a parse named and parses again (`durian-serve.ts`). That the BUILT
 * worker answers as the eager parser does is `tests/perf/lazy-worker.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { FOLDER_PART_NAMES, FOLDER_PARTS } from 'durian-markdown';
import { lazyRegistry } from '../../../../app/vite-durian-lazy.ts';
import { redirectedImport } from '../../../../app/vite-durian.ts';
import { answer } from '../../../../app/hypermedia/durian-answer.ts';
import { MOST_ROUNDS, serve } from '../../../../app/hypermedia/durian-serve.ts';
import katexLate from '../../../../app/hypermedia/durian-shims/katex-late.ts';
import { PART_SHAPES } from '../../../../app/hypermedia/durian-shims/lazy-part-shapes.ts';
import {
  lazyPart,
  loadNeeded,
  registerKatexLoader,
  registerPartLoaders,
  takeNeeds,
} from '../../../../app/hypermedia/durian-shims/lazy-part.ts';
import {
  isReadRequest,
  isWorkerMessage,
  type ReadRequest,
  type WorkerMessage,
} from '../../../../app/hypermedia/durian-wire.ts';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-markdown/package.json'),
);
const registrySource = readFileSync(join(root, 'src/parts/generated/registry.ts'), 'utf8');

type Real = Record<string, unknown> & {
  steps: boolean;
  llmKind: string;
  llm?: unknown;
  llmExempt?: unknown;
  fences?: unknown;
  chartKinds?: unknown;
};

describe('PART_SHAPES is the installed registry', () => {
  it('has one row for every folder part, and no other', () => {
    expect(Object.keys(PART_SHAPES).sort()).toEqual([...FOLDER_PART_NAMES].sort());
  });

  for (const name of FOLDER_PART_NAMES)
    it(`${name}: the row is what the part says of itself, and the stand-in answers the same before it parses`, () => {
      const real = FOLDER_PARTS[name] as unknown as Real;
      const shape = PART_SHAPES[name];
      expect(shape).toBeDefined();
      expect(shape?.steps).toBe(real.steps);
      expect(shape?.llmKind).toBe(real.llmKind as never);
      expect(shape?.llm).toBe(typeof real.llm === 'function');
      expect(shape?.llmExempt).toBe(typeof real.llmExempt === 'function');
      expect(shape?.fences).toEqual(real.fences as never);
      expect(shape?.chartKinds).toEqual(real.chartKinds as never);
      expect(real.form).toBe('fenced');
      const stand = lazyPart(name) as Real;
      expect(stand.name).toBe(name);
      expect(stand.form).toBe('fenced');
      for (const key of ['steps', 'llmKind', 'fences', 'chartKinds'] as const) expect(stand[key]).toEqual(real[key]);
      expect(typeof stand.llm).toBe(typeof real.llm);
      expect(typeof stand.llmExempt).toBe(typeof real.llmExempt);
    });
});

describe('lazyRegistry rewrites the generated registry and nothing else', () => {
  const shim = '/shim/lazy-part.ts';
  const out = lazyRegistry(registrySource, shim);

  it('leaves no static import of a part’s module, and keeps the inline parts and the lists', () => {
    expect(out).not.toMatch(/^import \w+ from "\.\.\/[\w-]+\/part";/mu);
    for (const inline of ['glossary', 'math', 'references', 'spark'])
      expect(out).toContain(`from "../${inline}/inline";`);
    expect(out).toContain('export const FOLDER_PARTS = {');
    expect(out).toContain('export const INLINE_PART_NAMES');
    expect(out).toContain(`from ${JSON.stringify(shim)}`);
  });

  it('makes every part a stand-in and gives every part, and KaTeX, a dynamic import', () => {
    for (const name of FOLDER_PART_NAMES) {
      const local = name.replace(/-(\w)/gu, (_dash, letter: string) => letter.toUpperCase());
      expect(out).toContain(`const ${local} = lazyPart("${name}");`);
      expect(out).toContain(`"${name}": () => import("../${name}/part"),`);
    }
    expect(out).toContain('registerKatexLoader(() => import("katex"));');
  });

  it('fails the build, not a page, when the registry has none of the lines it rewrites', () => {
    expect(() => lazyRegistry('export const FOLDER_PARTS = {};', shim)).toThrow(/no `import x from/u);
  });
});

describe('the build redirects what it must and only that', () => {
  it('sends the maths library’s own import to the stand-in, from the maths part alone', () => {
    const render = join(root, 'src/parts/math/render.ts');
    expect(redirectedImport('katex', render, root)).toEndWith('durian-shims/katex-late.ts');
    expect(redirectedImport('katex', join(root, 'src/parts/math/inline.ts'), root)).toBeNull();
    expect(redirectedImport('katex', join(root, 'src/parts/graph/part.ts'), root)).toBeNull();
    expect(readFileSync(render, 'utf8')).toContain('import katex from "katex";');
  });
});

/** A part module as `import()` gives it: the definition is the default export. */
const moduleOf = (parse: (input: unknown, context: unknown) => unknown, extra: object = {}) =>
  Promise.resolve({ default: { parse, ...extra } });

describe('a part whose code has not arrived', () => {
  it('names itself and answers nothing, and the parse that read it is the caller’s to throw away', () => {
    takeNeeds();
    const stand = lazyPart('gantt') as unknown as { parse(input: unknown, context: unknown): unknown };
    expect(stand.parse({ body: 'x' }, {})).toBeNull();
    expect(takeNeeds()).toEqual(['gantt']);
    expect(takeNeeds()).toEqual([]);
  });

  it('is the part’s own parse, llm, llmExempt and check once it has arrived, and needs nothing', async () => {
    takeNeeds();
    registerPartLoaders({
      audio: () =>
        moduleOf((input, context) => ({ parsed: input, context }), {
          llm: (data: unknown) => `llm:${JSON.stringify(data)}`,
          llmExempt: () => true,
          check: () => [{ message: 'a problem' }],
        }),
    });
    const stand = lazyPart('audio') as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(stand.parse?.(1, 2)).toBeNull();
    expect(stand.llm?.({}, 1)).toBe('');
    expect(stand.llmExempt?.({})).toBe(false);
    expect(stand.check?.({}, 1)).toEqual([]);
    expect(takeNeeds()).toEqual(['audio']);
    await loadNeeded(['audio']);
    expect(stand.parse?.(1, 2)).toEqual({ parsed: 1, context: 2 });
    expect(stand.llm?.({ a: 1 }, 1)).toBe('llm:{"a":1}');
    expect(stand.llmExempt?.({})).toBe(true);
    expect(stand.check?.({}, 1)).toEqual([{ message: 'a problem' }]);
    expect(takeNeeds()).toEqual([]);
  });

  it('cannot be fetched when nothing says how, and says so', async () => {
    await expect(loadNeeded(['no-such-part'])).rejects.toThrow('no-such-part part has no loader');
  });

  it('is refused at build time when the part has no row in PART_SHAPES', () => {
    expect(() => lazyPart('brand-new')).toThrow('add it to lazy-part-shapes.ts');
  });
});

describe('KaTeX, until it has arrived', () => {
  it('throws and names itself, so a formula is a problem for one parse and is never cached', async () => {
    takeNeeds();
    expect(() => katexLate.renderToString('x^2', { displayMode: false })).toThrow('KaTeX has not arrived');
    expect(takeNeeds()).toEqual(['katex']);
    const calls: unknown[][] = [];
    registerKatexLoader(() =>
      Promise.resolve({
        default: {
          renderToString: (...args: unknown[]) => {
            calls.push(args);
            return '<math/>';
          },
        },
      }),
    );
    await loadNeeded(['katex']);
    expect(katexLate.renderToString('x^2', { displayMode: true })).toBe('<math/>');
    expect(calls).toEqual([['x^2', { displayMode: true }]]);
    expect(takeNeeds()).toEqual([]);
  });
});

describe('the worker’s loop', () => {
  const request: ReadRequest = { kind: 'read', id: 5, source: 'text', idPrefix: 'dh-x-', arriving: false };
  const final: WorkerMessage = { kind: 'text', id: 5 };

  /** A worker whose parse names `rounds[0]`, then `rounds[1]`, …, and is clean after them. */
  function rig(
    rounds: readonly (readonly string[])[],
    load: (names: readonly string[]) => Promise<void> = () => Promise.resolve(),
  ) {
    const said: WorkerMessage[] = [];
    const log: string[] = [];
    let round = 0;
    let pending: string[] = ['left over from an earlier parse'];
    const deps = {
      answer: (() => {
        log.push(`parse ${round}`);
        pending = [...(rounds[round] ?? [])];
        round += 1;
        return final;
      }) as typeof answer,
      takeNeeds: () => pending.splice(0),
      loadNeeded: (async (names: readonly string[]) => {
        log.push(`load ${names.join('+')}`);
        await load(names);
      }) as typeof loadNeeded,
      say: (message: WorkerMessage) => {
        said.push(message);
        log.push(message.kind);
      },
    };
    return { deps, said, log };
  }

  it('answers a message that needs nothing lazy with its answer alone, once', async () => {
    const { deps, log } = rig([[]]);
    await serve(request, deps);
    expect(log).toEqual(['parse 0', 'text']);
  });

  it('throws away a parse that needed code, fetches what it named, and parses again', async () => {
    const { deps, log } = rig([['graph', 'katex'], []]);
    await serve(request, deps);
    expect(log).toEqual(['parse 0', 'loading', 'load graph+katex', 'working', 'parse 1', 'text']);
  });

  it('goes another round when a part’s own formula needs KaTeX only once the part is here', async () => {
    const { deps, log } = rig([['math'], ['katex'], []]);
    await serve(request, deps);
    expect(log).toEqual([
      'parse 0',
      'loading',
      'load math',
      'working',
      'parse 1',
      'loading',
      'load katex',
      'working',
      'parse 2',
      'text',
    ]);
  });

  it('is `failed` when a fetch fails, and says nothing after', async () => {
    const { deps, log } = rig([['log']], () => Promise.reject(new Error('offline')));
    await serve(request, deps);
    expect(log).toEqual(['parse 0', 'loading', 'load log', 'failed']);
  });

  it('is `failed` when a message is still missing something after the most rounds, and ends', async () => {
    const { deps, said } = rig(Array.from({ length: MOST_ROUNDS + 3 }, () => ['log']));
    await serve(request, deps);
    expect(said.filter(message => message.kind === 'loading').length).toBe(MOST_ROUNDS);
    expect(said[said.length - 1]).toEqual({ kind: 'failed', id: 5 });
    expect(said.some(message => message.kind === 'text')).toBe(false);
  });

  it('forgets what an earlier parse left, so a clean message is never made to wait for another’s part', async () => {
    const { deps, log } = rig([[]]);
    await serve(request, deps);
    expect(log).not.toContain('loading');
  });
});

describe('the wire carries the two notes', () => {
  it('accepts loading and working for an ask, and nothing without an id', () => {
    expect(isWorkerMessage({ kind: 'loading', id: 1 })).toBe(true);
    expect(isWorkerMessage({ kind: 'working', id: 1 })).toBe(true);
    expect(isWorkerMessage({ kind: 'loading' })).toBe(false);
    expect(isWorkerMessage({ kind: 'sleeping', id: 1 })).toBe(false);
    expect(isReadRequest({ kind: 'loading', id: 1 })).toBe(false);
  });
});

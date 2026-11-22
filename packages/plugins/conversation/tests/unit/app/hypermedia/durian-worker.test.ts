/**
 * r12 H11 — WHAT THE DURIAN WORKER DOES AND WHAT CROSSES TO IT: the wire is plain data (structured-clone safe, proved on real
 * documents), a slow parse is a parse that is stopped (a stub that busy-loops stands in for one; the worker is ended from
 * outside, which is the reader's test), and a small message that grows into a huge document is never sent. Nothing here
 * names what makes a real parse slow: the only slow parse is a loop the test wrote.
 */
import { describe, expect, it } from 'bun:test';
import { answer } from '../../../../app/hypermedia/durian-answer.ts';
import {
  type DrawableEntries,
  isReadRequest,
  isWorkerMessage,
  type ReadRequest,
  type WorkerMessage,
} from '../../../../app/hypermedia/durian-wire.ts';
import {
  DOCUMENT_BYTES_FLOOR,
  DOCUMENT_BYTES_PER_BYTE,
  DOCUMENT_NODES_FLOOR,
  DOCUMENT_NODES_PER_BYTE,
  exceedsDocumentBudget,
} from '../../../../app/hypermedia/limits.ts';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import { withIdPrefix } from '../../../../app/hypermedia/with-id-prefix.ts';
import { mustRead } from './must-read.ts';

const FENCE = '`'.repeat(3);
/** Durian's parser, as `readMessage` takes it: the one thing a test replaces. */
type Parser = NonNullable<Parameters<typeof readMessage>[4]>;
const request = (source: string, patch: Partial<ReadRequest> = {}): ReadRequest => ({
  kind: 'read',
  id: 7,
  source,
  idPrefix: 'dh-x-',
  arriving: false,
  ...patch,
});

/** A message that exercises every kind of node the reader makes: headings, a reference, a table, parts, a held fence and an fy-render block. */
const RICH = [
  '# Plan :zelda',
  '',
  'See &F12 and @src/api.ts, **bold**, `a &lt; b` and [a link](https://example.com).',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  `${FENCE}terminal`,
  '$ bun test',
  'ok',
  FENCE,
  '',
  `${FENCE}chart`,
  'type: line',
  FENCE,
  '',
  `${FENCE}fy-render`,
  'type: svg',
  'alt: A square',
  '---',
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  FENCE,
].join('\n');

describe('what crosses to and from the worker', () => {
  it('is plain data: the answer for a message of every kind of node survives a structured clone unchanged', () => {
    const message = answer(request(RICH));
    expect(message.kind).toBe('read');
    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    // And it is JSON: nothing in it needs a class, a function or a React node to come back.
    expect(JSON.parse(JSON.stringify(message))).toEqual(JSON.parse(JSON.stringify(cloned)));
    expect(isWorkerMessage(cloned)).toBe(true);
  });

  it('carries the drawable fy-render bodies as entries, which are the same bodies the reader draws', () => {
    const message = answer(request(RICH));
    if (message.kind !== 'read') throw new Error('the message was not read');
    expect(message.drawable.length).toBe(1);
    expect(message.drawable[0]?.[1][0]).toContain('<svg');
    const entries: DrawableEntries = message.drawable;
    expect(new Map(entries).size).toBe(1);
  });

  it('recognises a well-formed ask, and nothing else', () => {
    expect(isReadRequest(request('hello'))).toBe(true);
    for (const bad of [
      null,
      'hello',
      42,
      {},
      { ...request('x'), kind: 'ready' },
      { ...request('x'), id: '7' },
      { ...request('x'), source: 7 },
      { ...request('x'), idPrefix: undefined },
      { ...request('x'), arriving: 'no' },
    ])
      expect(isReadRequest(bad)).toBe(false);
  });

  it('recognises a well-formed message from the worker, and nothing else', () => {
    const good: WorkerMessage[] = [
      { kind: 'ready' },
      { kind: 'text', id: 1 },
      { kind: 'failed', id: 1 },
      { kind: 'read', id: 1, doc: mustRead('hi', 'p-').doc, drawable: [] },
    ];
    for (const message of good) expect(isWorkerMessage(message)).toBe(true);
    for (const bad of [
      null,
      'ready',
      {},
      { kind: 'read', id: 1, doc: null, drawable: [] },
      { kind: 'read', id: 1, doc: {}, drawable: 'no' },
      { kind: 'read', id: '1', doc: {}, drawable: [] },
      { kind: 'text' },
      { kind: 'nope', id: 1 },
    ])
      expect(isWorkerMessage(bad)).toBe(false);
  });
});

describe('answer', () => {
  it('reads a message with the message reader and keeps the id of the ask', () => {
    const message = answer(request('Some *prose*.', { id: 41 }));
    expect(message.kind).toBe('read');
    expect(message).toMatchObject({ id: 41 });
  });

  it('says "text" for a message the reader shows as text (over its cap)', () => {
    expect(answer(request('x'.repeat(300_001), { id: 3 }))).toEqual({ kind: 'text', id: 3 });
  });

  it('says "failed" for a parse that throws, never throws itself', () => {
    const throws = (): never => {
      throw new Error('boom');
    };
    expect(answer(request('hi', { id: 9 }), throws)).toEqual({ kind: 'failed', id: 9 });
  });

  it('reads with no front matter and the chart held, which is the Durian rule', () => {
    const message = answer(request(['---', 'title: x', '---', '', `${FENCE}chart`, 'type: line', FENCE].join('\n')));
    if (message.kind !== 'read') throw new Error('the message was not read');
    const types = message.doc.blocks.map(block => block.type);
    expect(types).not.toContain('chart');
    expect(types).toContain('host');
  });
});

describe('the budget on how big the document may be (the worker checks it before anything is sent)', () => {
  /** A parser stub that turns a small input into a huge tree, and counts how often it was asked. */
  const expanding = (nodes: number) => {
    const calls = { n: 0 };
    const parser: Parser = () => {
      calls.n += 1;
      return { blocks: Array.from({ length: nodes }, (_, index) => ({ type: 'markdown', index })) } as never;
    };
    return { calls, parser };
  };

  it('shows a message as text when its document has far more nodes than the message can account for', () => {
    const { parser, calls } = expanding(DOCUMENT_NODES_FLOOR + DOCUMENT_NODES_PER_BYTE * 20 + 1);
    expect(readMessage('twenty bytes of text', 'p-', false, false, parser)).toBeNull();
    expect(calls.n).toBe(1);
  });

  it('shows a message as text when its document is too many bytes for the message, even within the node count', () => {
    const big = 'y'.repeat(DOCUMENT_BYTES_FLOOR + DOCUMENT_BYTES_PER_BYTE * 10);
    const parser: Parser = () => ({ blocks: [{ type: 'markdown', text: big }] }) as never;
    expect(readMessage('ten bytes.', 'p-', false, false, parser)).toBeNull();
  });

  it('lets a document through that is within both budgets', () => {
    const parser: Parser = () => ({ blocks: [{ type: 'markdown', text: 'fine' }] }) as never;
    expect(readMessage('ten bytes.', 'p-', false, false, parser)?.doc as unknown).toEqual({
      blocks: [{ type: 'markdown', text: 'fine' }],
    });
  });

  it('answers "text" through the worker for an expanding parse', () => {
    const { parser } = expanding(DOCUMENT_NODES_FLOOR * 4);
    const message = answer(request('tiny', { id: 5 }), (source, prefix, arriving) =>
      readMessage(source, prefix, arriving, false, parser),
    );
    expect(message).toEqual({ kind: 'text', id: 5 });
  });

  it('counts what it measures: nodes first (it stops at the cap), serialized bytes second', () => {
    const nested: unknown[] = [];
    let at = nested;
    for (let depth = 0; depth < 5; depth++) {
      const next: unknown[] = [];
      at.push(next, { a: 1 }, 'text', null, undefined);
      at = next;
    }
    expect(exceedsDocumentBudget(nested, 'x'.repeat(1000))).toBe(false);
    expect(exceedsDocumentBudget({ list: Array.from({ length: DOCUMENT_NODES_FLOOR + 10 }, () => ({})) }, '')).toBe(
      true,
    );
    expect(exceedsDocumentBudget({ text: 'z'.repeat(DOCUMENT_BYTES_FLOOR + 1) }, '')).toBe(true);
    expect(exceedsDocumentBudget({ text: 'z'.repeat(DOCUMENT_BYTES_FLOOR) }, 'a'.repeat(100))).toBe(false);
    expect(DOCUMENT_BYTES_PER_BYTE).toBeGreaterThan(8);
  });

  it('measures a multi-byte message in bytes, not characters', () => {
    // 3 bytes per character: 25,000 characters are 75,000 bytes, so the budget is 24 x 75,000 + the floor, not 24 x 25,000.
    const text = '€'.repeat(25_000);
    expect(
      exceedsDocumentBudget({ text: 'z'.repeat(DOCUMENT_BYTES_FLOOR + DOCUMENT_BYTES_PER_BYTE * 25_000 + 1) }, text),
    ).toBe(false);
    expect(
      exceedsDocumentBudget({ text: 'z'.repeat(DOCUMENT_BYTES_FLOOR + DOCUMENT_BYTES_PER_BYTE * 75_000 + 1) }, text),
    ).toBe(true);
  });

  it("lets an ordinary, dense message through: the reader's own documents for real prose are far inside it", () => {
    const dense = Array.from(
      { length: 500 },
      (_, index) => `*a${index}* **b** \`c\` [d](https://e.example) :zelda &F1`,
    ).join('\n\n');
    expect(readMessage(dense, 'p-')).not.toBeNull();
    expect(readMessage(RICH, 'p-')).not.toBeNull();
  });
});

describe('withIdPrefix', () => {
  it("puts a message's own prefix where the document had the one made of its text, and nowhere else", () => {
    const read = mustRead('# Plan\n\nSee [the plan](#plan).', 'dh-aaa-');
    const mine = withIdPrefix(read.doc, 'dh-aaa-', 'dh-r1-');
    const text = JSON.stringify(mine);
    expect(text).toContain('dh-r1-plan');
    expect(text).not.toContain('dh-aaa-');
    expect(JSON.parse(text.replaceAll('dh-r1-', 'dh-aaa-'))).toEqual(read.doc);
  });

  it('is the same document when the prefixes are the same', () => {
    const read = mustRead('# Plan', 'dh-aaa-');
    expect(withIdPrefix(read.doc, 'dh-aaa-', 'dh-aaa-')).toBe(read.doc);
  });
});

describe('the worker module', () => {
  it('says it is ready, answers an ask, and ignores anything else', async () => {
    const posted: unknown[] = [];
    const scope = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown): void => void posted.push(message),
    };
    const real = globalThis.self;
    Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
    try {
      await import('../../../../app/hypermedia/durian-worker.ts');
    } finally {
      Object.defineProperty(globalThis, 'self', { configurable: true, value: real });
    }
    expect(posted).toEqual([{ kind: 'ready' }]);
    scope.onmessage?.({ data: 'not an ask' });
    scope.onmessage?.({ data: request('hello', { id: 2 }) });
    expect(posted.length).toBe(2);
    expect(posted[1]).toMatchObject({ kind: 'read', id: 2 });
  });
});

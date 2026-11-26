/**
 * r12 H1 → H8 fix — NO YAML IS READ IN A MESSAGE. Durian's parser reaches its YAML parser for a front matter block (this app reads
 * none) and a chart fence's data (every chart fence is held as code); no other part does. So the host setting is a parser that
 * refuses, and the bounded YAML reader (`@ferretry/std/yaml`, ~29 KB gzip) is not in the message path at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { parse, setYamlParser, VERSION } from 'durian-markdown';
import { configureDurian } from '../../../../app/hypermedia/durian.ts';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';

const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

/** One message with every part Ferretry draws, and the two it holds as code. */
const EVERY_PART = [
  '# A message',
  fence('terminal', '$ echo hi', 'hi'),
  fence('filetree', 'app/', '  main.ts  (new)'),
  fence('editor', 'file: a.ts', '---', 'const a = 1;'),
  fence('tierlist', 'S: [a, b]', 'A: [c]'),
  fence('alignment', 'x: [low, high]', 'y: [cheap, dear]', 'items:', '  - name: one', '    at: [0.2, 0.7]'),
  fence('mermaid', 'flowchart LR', '  A --> B'),
  fence('animation', 'array a: 5 2 8 1', '@step They swap.', 'swap a.0 a.1'),
  [':::tabs', '#### Node', 'npm i', '#### Python', 'pip install', ':::'].join('\n'),
  [':::accordion', '#### One', 'first', ':::'].join('\n'),
  fence(
    'chart',
    'kind: line',
    'x: { label: step, values: [1, 2, 3] }',
    'series:',
    '  - name: calls',
    '    data: [1, 2, 3]',
  ),
  fence('codewalk', 'file: a.ts'),
].join('\n\n');

let calls = 0;
beforeAll(() => {
  configureDurian();
});
afterAll(() => setYamlParser(null));

describe('configureDurian', () => {
  it('is the pinned release (no later API under us)', () => {
    expect(VERSION).toBe('0.7.0');
  });

  it('no part of a message reaches a YAML parser', () => {
    setYamlParser(text => {
      calls += 1;
      throw new Error(`YAML was read: ${text}`);
    });
    readMessage(EVERY_PART, 'every-');
    expect(calls).toBe(0);
    configureDurian();
  });

  it('refuses when something does reach it: a forced front matter is a problem, never data', () => {
    const doc = parse('---\ntitle: A title\n---\n\n# Body\n');
    expect(doc.frontMatter).not.toEqual({ title: 'A title' });
    expect(doc.problems.length).toBeGreaterThan(0);
  });

  it('refuses a chart Durian were asked to read: it is not drawn from the data', () => {
    const doc = parse(fence('chart', 'kind: line', 'series:', '  - name: calls', '    data: [1, 2, 3]'));
    expect(doc.blocks[0]).not.toMatchObject({ type: 'chart', chart: { kind: 'line' } });
  });
});

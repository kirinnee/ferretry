import { describe, expect, it } from 'bun:test';
import { BoardTaskCreateRequestSchema, stripListMarker, toBullets, unnestBullets } from '../../src/lib/index.ts';

describe('points are plain lines', () => {
  it('strips one leading list marker from a point', () => {
    for (const marker of ['- ', '* ', '• ', '1. ', '2) ']) expect(stripListMarker(`${marker}x **y**`)).toBe('x **y**');
  });

  it('toBullets does not double a marker the point already carries', () => {
    expect(toBullets(['- You asked to', '* second', 'third'])).toBe('- You asked to\n- second\n- third');
  });

  it('unnests a stored "- - x" and keeps ordinary lists and prose', () => {
    expect(unnestBullets('- - a\n- b')).toBe('- a\n- b');
    expect(unnestBullets('1. a\n2. b')).toBe('1. a\n2. b');
    expect(unnestBullets('Lead\n- - a')).toBe('Lead\n- - a');
  });

  it('a board card stores no doubled marker after create', () => {
    const parsed = BoardTaskCreateRequestSchema.parse({
      kind: 'bug',
      title: 'T',
      ask: { text: 'a', source: 'owner:board' },
      premise: '- - You asked to',
      context: '- - c1\n- c2',
    });
    expect(parsed.premise).toBe('- You asked to');
    expect(parsed.context).toBe('- c1\n- c2');
  });
});

import { describe, expect, it } from 'bun:test';
import { stripListMarker, toBullets, unnestBullets } from '../../../../daemon/lib/protocol/agenda.ts';

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
});

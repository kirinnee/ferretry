import { describe, expect, it } from 'bun:test';

import { FY_RENDER_LIMITS } from '../../../../app/render/fy-render-bounds.ts';
import { parseFyRenderEmbed } from '../../../../app/render/fy-render-embed.ts';

const refused = (type: 'card' | 'board', payload: string): string => {
  const result = parseFyRenderEmbed(type, payload);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
};

describe('parseFyRenderEmbed: card', () => {
  it('reads exactly one card reference', () => {
    expect(parseFyRenderEmbed('card', '&F12')).toEqual({ ok: true, spec: { kind: 'card', id: 'F12' } });
    expect(parseFyRenderEmbed('card', '\n  &F12  \n')).toEqual({ ok: true, spec: { kind: 'card', id: 'F12' } });
  });

  it('refuses nothing, two cards, a non-card and a parent line', () => {
    expect(refused('card', '')).toContain('needs a payload');
    expect(refused('card', '&F1 &F2')).toContain('exactly one card');
    expect(refused('card', 'F12')).toContain('not a card reference');
    expect(refused('card', '@file')).toContain('not a card reference');
    expect(refused('card', 'parent: &F1')).toContain('Only a board');
  });
});

describe('parseFyRenderEmbed: board', () => {
  it('lists cards by space, by line, and with list marks', () => {
    const spec = { kind: 'cards', ids: ['F1', 'F2', 'F3'] } as const;
    expect(parseFyRenderEmbed('board', '&F1 &F2 &F3')).toEqual({ ok: true, spec });
    expect(parseFyRenderEmbed('board', '&F1\n&F2\n&F3')).toEqual({ ok: true, spec });
    expect(parseFyRenderEmbed('board', '- &F1\n- &F2\n\n- &F3\n')).toEqual({ ok: true, spec });
  });

  it('reads a parent whose children it shows', () => {
    expect(parseFyRenderEmbed('board', 'parent: &F559')).toEqual({
      ok: true,
      spec: { kind: 'children', parent: 'F559' },
    });
  });

  it('refuses a parent that is not a card, or mixed with a list', () => {
    expect(refused('board', 'parent: F559')).toContain('not a card reference');
    expect(refused('board', 'parent: &F1\n&F2')).toContain('never both');
  });

  it('refuses an empty payload, a non-card word and a repeat', () => {
    expect(refused('board', ' \n')).toContain('needs a payload');
    expect(refused('board', '&F1 nope')).toContain('"nope"');
    expect(refused('board', '&F1 &F1')).toContain('listed twice');
  });

  it('holds the card cap and the byte cap', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `&F${index + 1}`).join(' ');
    expect(parseFyRenderEmbed('board', many(FY_RENDER_LIMITS.embedCards)).ok).toBe(true);
    expect(refused('board', many(FY_RENDER_LIMITS.embedCards + 1))).toContain('at most');
    expect(refused('board', `&F1 ${'x'.repeat(FY_RENDER_LIMITS.embedBytes)}`)).toContain('2 KiB');
  });
});

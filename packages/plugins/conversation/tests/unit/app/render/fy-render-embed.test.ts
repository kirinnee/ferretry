import { describe, expect, it } from 'bun:test';

import { FY_RENDER_LIMITS } from '@ferretry/app';
import { parseFyRenderEmbed } from '../../../../app/render/fy-render-embed.ts';

const refused = (type: 'task' | 'board', payload: string): string => {
  const result = parseFyRenderEmbed(type, payload);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
};

describe('parseFyRenderEmbed: task', () => {
  it('reads exactly one task reference', () => {
    expect(parseFyRenderEmbed('task', '&F12')).toEqual({ ok: true, spec: { kind: 'card', id: 'F12' } });
    expect(parseFyRenderEmbed('task', '\n  &F12  \n')).toEqual({ ok: true, spec: { kind: 'card', id: 'F12' } });
  });

  it('refuses nothing, two tasks, a non-task and a parent line', () => {
    expect(refused('task', '')).toContain('needs a payload');
    expect(refused('task', '&F1 &F2')).toContain('exactly one task');
    expect(refused('task', 'F12')).toContain('not a task reference');
    expect(refused('task', '@file')).toContain('not a task reference');
    expect(refused('task', 'parent: &F1')).toContain('Only a board');
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

  it('refuses a parent that is not a task, or mixed with a list', () => {
    expect(refused('board', 'parent: F559')).toContain('not a task reference');
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

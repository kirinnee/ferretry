import * as realApp from '@ferretry/app';
import { render } from '@ferretry/app/testing';
import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';

/**
 * The mini board and the lane view are the Board's: Conversation mounts the whole block through the Board's
 * `reference:&board` renderer, handing it what the block names. `RendererView` is replaced here by a stand-in that
 * records what it was asked for and draws what a Board renderer would, so this file proves the hand-off; the Board's own
 * drawing is proven in the Board's tests, and the no-Board fallback in `fy-render-card-embed.test.tsx`.
 */

interface Asked {
  readonly daemon: string;
  readonly rendererKey: string;
  readonly value: unknown;
}
const asked: Asked[] = [];
let owned = true;

mock.module('@ferretry/app', () => ({
  ...realApp,
  RendererView: (props: Asked & { readonly fallback?: ReactNode }) => {
    asked.push({ daemon: props.daemon, rendererKey: props.rendererKey, value: props.value });
    return owned ? <p data-board-drew={props.rendererKey} /> : <>{props.fallback}</>;
  },
}));

const { FyRenderCardEmbed } = await import('../../../../app/render/fy-render-task-embed.tsx');
const { isFyRenderEmbedBlock, parseFyRender } = await import('../../../../app/render/fy-render.ts');

const blockOf = (type: 'task' | 'board', payload: string) => {
  const result = parseFyRender([`type: ${type}`, 'alt: Live work', '---', payload].join('\n'));
  const block = result.ok ? result.block : undefined;
  if (block === undefined || !isFyRenderEmbedBlock(block)) throw new Error('fixture is not an embed block');
  return block;
};

const host = { daemon: 'daemon-a' };

describe('FyRenderCardEmbed: the Board draws the mini board', () => {
  it('hands a task block to the Board renderer as the task it names, inside the labelled group', () => {
    asked.length = 0;
    owned = true;
    const tree = render(<FyRenderCardEmbed block={blockOf('task', '&F12')} host={host} />);
    expect(asked).toEqual([
      { daemon: 'daemon-a', rendererKey: 'reference:&board', value: { kind: 'card', id: 'F12' } },
    ]);
    expect(tree.root.findByProps({ 'data-fy-card-embed': 'task' }).props['aria-label']).toBe('Live work');
    expect(tree.root.findAllByProps({ 'data-board-drew': 'reference:&board' })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-card': 'F12' })).toHaveLength(0);
  });

  it('hands a board that lists cards to the Board renderer as one list, not one row per card', () => {
    asked.length = 0;
    owned = true;
    render(<FyRenderCardEmbed block={blockOf('board', '&F1 &F2')} host={host} />);
    expect(asked.map(entry => entry.value)).toEqual([{ kind: 'cards', ids: ['F1', 'F2'] }]);
  });

  it('hands a `parent:` board to the Board renderer so the lane view is its own', () => {
    asked.length = 0;
    owned = true;
    const tree = render(<FyRenderCardEmbed block={blockOf('board', 'parent: &F7')} host={host} />);
    expect(asked.map(entry => entry.value)).toEqual([{ kind: 'children', parent: 'F7' }]);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-note': 'F7' })).toHaveLength(0);
  });

  it('draws the reference rows only where no Board answers for the renderer', () => {
    asked.length = 0;
    owned = false;
    const tree = render(<FyRenderCardEmbed block={blockOf('board', 'parent: &F7')} host={host} />);
    expect(tree.root.findAllByProps({ 'data-board-drew': 'reference:&board' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-note': 'F7' })).toHaveLength(1);
  });
});

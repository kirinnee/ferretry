import { render } from '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import { FyRenderCardEmbed } from '../../../../app/render/fy-render-card-embed.tsx';
import { type FyRenderParsedBlock, isFyRenderEmbedBlock, parseFyRender } from '../../../../app/render/fy-render.ts';

/**
 * A `card` / `board` block draws each card through the Board's own `reference:&` renderer (`RendererView`), so with no
 * shell mounted — a harness, this test — the way in is the written reference as plain text, never a link. The mini
 * board of today's block (the Board page's card and lane header) is the Board's to draw: GAP(board).
 */

const host = { daemon: 'daemon-a' };

const blockOf = (type: 'card' | 'board', payload: string) => {
  const result = parseFyRender([`type: ${type}`, 'alt: Live work', '---', payload].join('\n'));
  const block: FyRenderParsedBlock | undefined = result.ok ? result.block : undefined;
  if (block === undefined || !isFyRenderEmbedBlock(block)) throw new Error('fixture is not an embed block');
  return block;
};

describe('FyRenderCardEmbed: a card', () => {
  it('names the group for what it shows and holds one row for the card', () => {
    const tree = render(<FyRenderCardEmbed block={blockOf('card', '&F12')} host={host} />);
    const group = tree.root.findByProps({ 'data-fy-card-embed': 'card' });
    expect(group.props.role).toBe('group');
    expect(group.props['aria-label']).toBe('Live work');
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-card': 'F12' })).toHaveLength(1);
  });

  it('keeps the written reference as text when no Board renderer is mounted, never as a link', () => {
    const tree = render(<FyRenderCardEmbed block={blockOf('card', '&F12')} host={host} />);
    expect(tree.root.findAllByType('a')).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain('F12');
  });
});

describe('FyRenderCardEmbed: a board', () => {
  it('holds one row per listed card', () => {
    const tree = render(<FyRenderCardEmbed block={blockOf('board', '&F1 &F2 &F3')} host={host} />);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed': 'board' })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-card': 'F2' })).toHaveLength(1);
    expect(
      tree.root.findAll(node => node.props['data-fy-card-embed-card'] !== undefined && typeof node.type === 'string'),
    ).toHaveLength(3);
  });

  it('says whose cards a parent block names, with the parent as the way in', () => {
    const tree = render(<FyRenderCardEmbed block={blockOf('board', 'parent: &F7')} host={host} />);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-note': 'F7' })).toHaveLength(1);
    expect(tree.root.findAllByProps({ 'data-fy-card-embed-card': 'F7' })).toHaveLength(1);
  });
});

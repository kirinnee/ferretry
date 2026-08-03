/**
 * The logomark is the one component whose CORRECTNESS IS ITS SHAPE, so this test
 * asserts the shape rather than that something rendered.
 *
 * Fleet Grid means eight perimeter slots around one hub with exactly one slot
 * absent. Every wrong version of that — a full 3x3, a 2x3, two gaps — is still a
 * valid SVG, still renders, and still looks like a grid at a glance. Only the
 * counts and the coordinates tell them apart, and the missing slot is the mark's
 * whole meaning: Ferretry does not draw a healthy square for a report it never
 * received.
 *
 * The second thing asserted is the colour SOURCE, not the colour. `currentColor`
 * on the cells is what makes one component right in seven theme families, light
 * and dark; a literal hex would look identical in the one theme it was written
 * against and be wrong in thirteen others, with nothing failing.
 */

import { describe, expect, it } from 'bun:test';
import { BrandMark } from '../../src/shell/brand-mark.tsx';
import { render } from '../support/react.ts';

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly (RenderedNode | string)[] | null;
}

/** Every element of one type in the rendered tree, flattened. */
const findAll = (node: RenderedNode | string | null, type: string): readonly RenderedNode[] => {
  if (node === null || typeof node === 'string') return [];
  const here = node.type === type ? [node] : [];
  const below = (node.children ?? []).flatMap(child => findAll(child, type));
  return [...here, ...below];
};

const tree = (element: Parameters<typeof render>[0]): RenderedNode => {
  const rendered = render(element).toJSON();
  if (rendered === null || Array.isArray(rendered)) throw new Error('the mark rendered no single root');
  return rendered as unknown as RenderedNode;
};

describe('the brand mark', () => {
  it('draws seven cells, one absent slot and one hub', () => {
    const root = tree(<BrandMark />);
    const cells = findAll(root, 'rect');
    expect(cells).toHaveLength(7);

    // The eight perimeter slots of a 3x3 on the 4-unit grid, minus (44, 24).
    // Asserted as coordinates rather than as a count, because seven rects stacked
    // anywhere would satisfy a count.
    const positions = cells.map(cell => `${String(cell.props.x)},${String(cell.props.y)}`).sort();
    expect(positions).toEqual(['24,4', '24,44', '4,24', '4,4', '4,44', '44,4', '44,44']);
    expect(positions).not.toContain('44,24');
    // The centre is never a cell: it is the hub, and a rect there would make the
    // mark a full grid with a dot on it.
    expect(positions).not.toContain('24,24');

    const hubs = findAll(root, 'circle');
    expect(hubs).toHaveLength(1);
    expect(hubs[0]?.props).toMatchObject({ cx: 32, cy: 32, r: 8 });
  });

  it('takes its cell colour from the surrounding text and its hub from the accent', () => {
    const root = tree(<BrandMark />);
    // `currentColor` is what lets one mark serve every theme family in both
    // modes, and what lets a tinted lockup tint the mark with it.
    expect(findAll(root, 'g')[0]?.props.fill).toBe('currentColor');
    // The hub is the daemon and reads as a different kind of thing from the
    // agents around it, so it takes the theme's accent token — resolved by CSS,
    // not copied into TypeScript where it would drift from `styles/themes.css`.
    expect(findAll(root, 'circle')[0]?.props.fill).toBe('var(--accent)');
  });

  it('scales from one prop and keeps the viewBox, so the geometry never distorts', () => {
    const drawn = tree(<BrandMark />);
    // The default is the icon size of the header lockups it replaces.
    expect(drawn.props).toMatchObject({ width: 20, height: 20, viewBox: '0 0 64 64' });

    const large = tree(<BrandMark size={64} />);
    // Square at every size: one `size` prop cannot produce a stretched mark the
    // way separate width/height props could.
    expect(large.props).toMatchObject({ width: 64, height: 64, viewBox: '0 0 64 64' });
  });

  it('is decorative, because every lockup it sits in already says the name', () => {
    const root = tree(<BrandMark />);
    expect(root.props['aria-hidden']).toBe('true');
    // `aria-hidden` does not remove an SVG from the tab order in every browser.
    expect(root.props.focusable).toBe('false');
    // No `aria-label`: a bare label on a decorative graphic beside the word
    // "Ferretry" would announce the name twice.
    expect(root.props['aria-label']).toBeUndefined();
  });

  it('never lets a caller drop the class that keeps it from being squeezed', () => {
    // A mark in a flex row next to text will be compressed by the text unless it
    // refuses to shrink, and that has to survive a caller passing layout classes.
    expect(String(tree(<BrandMark />).props.className)).toBe('shrink-0');
    const merged = String(tree(<BrandMark className="opacity-70" />).props.className);
    expect(merged.split(' ')).toEqual(['shrink-0', 'opacity-70']);
  });
});

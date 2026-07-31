import { describe, expect, it } from 'bun:test';
import { MarkerLine, MarkerSeparator } from '../../src/shell/marker.tsx';
import { render } from '../support/react.ts';

describe('MarkerSeparator', () => {
  it('rules the label on both sides so it reads as a centred divider', () => {
    const spans = render(<MarkerSeparator>Turn 3</MarkerSeparator>).root.findAllByType('span');

    expect(spans[0]?.props.className).toBe('h-px flex-1 bg-border-soft');
    expect(spans[2]?.props.className).toBe('h-px flex-1 bg-border-soft');
    expect(spans[1]?.props.children).toBe('Turn 3');
  });

  it('leaves the casing to .kt-label and only picks the ink', () => {
    const muted = render(<MarkerSeparator>x</MarkerSeparator>).root.findAllByType('span')[1];
    expect(muted?.props.className).toBe('kt-label text-muted');

    const faint = render(<MarkerSeparator tone="faint">x</MarkerSeparator>).root.findAllByType('span')[1];
    expect(faint?.props.className).toBe('kt-label text-faint');
  });
});

describe('MarkerLine', () => {
  it('stays a div when there is nothing to click, so it is not a fake control', () => {
    const tree = render(<MarkerLine>Ran the tests</MarkerLine>).root;

    expect(tree.findAllByType('button')).toHaveLength(0);
    const line = tree.findByType('div');
    expect(line.props.type).toBeUndefined();
    expect(line.props.className).not.toContain('hover:bg-surface-2');
  });

  it('becomes a real button, with a hover affordance, once it can be clicked', () => {
    const clicks: number[] = [];
    const button = render(<MarkerLine onClick={() => clicks.push(1)}>Open</MarkerLine>).root.findByType('button');

    expect(button.props.type).toBe('button');
    expect(button.props.className).toContain('transition-colors hover:bg-surface-2');

    button.props.onClick();
    expect(clicks).toHaveLength(1);
  });

  it('dims the icon until the row is hovered, and keeps the text able to truncate', () => {
    const spans = render(<MarkerLine icon={<i />}>Reading files</MarkerLine>).root.findAllByType('span');

    expect(spans[0]?.props.className).toBe('shrink-0 text-faint group-hover:text-muted');
    expect(spans[1]?.props.className).toBe('min-w-0 flex-1');
  });

  it('renders no icon slot at all when there is no icon', () => {
    const spans = render(<MarkerLine>Reading files</MarkerLine>).root.findAllByType('span');

    expect(spans).toHaveLength(1);
    expect(spans[0]?.props.className).toBe('min-w-0 flex-1');
  });

  it('forwards the tooltip and appends caller classes', () => {
    const line = render(
      <MarkerLine title="the full command" className="mt-1">
        bun test
      </MarkerLine>,
    ).root.findByType('div');

    expect(line.props.title).toBe('the full command');
    expect(line.props.className).toContain('mt-1');
  });
});

import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { WaitingFoldNotice, waitingFoldLine } from '../../src/components/waiting-fold-notice.tsx';
import { render, runAsync } from '../support/react.ts';

const textOf = (node: ReactTestInstance | ReactTestRenderer): string => {
  const root = 'root' in node ? node.root : node;
  return root.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');
};

describe('WaitingFoldNotice', () => {
  test('says how many messages wait, singular and plural', () => {
    expect(waitingFoldLine(1)).toBe('1 message waiting — on the Queue page');
    expect(waitingFoldLine(3)).toBe('3 messages waiting — on the Queue page');
    expect(textOf(render(<WaitingFoldNotice count={3} />))).toBe('3 messages waiting — on the Queue page');
  });

  test('is marked for the page and draws nothing for zero', () => {
    const notice = render(<WaitingFoldNotice count={2} />);
    expect(
      notice.root.findAll(node => node.props['data-waiting-fold'] !== undefined && node.type === 'div'),
    ).toHaveLength(1);
    expect(render(<WaitingFoldNotice count={0} />).toJSON()).toBeNull();
  });

  test('is plain text without a door, a button with one that opens the queue', async () => {
    const plain = render(<WaitingFoldNotice count={2} />);
    expect(plain.root.findAllByType('button')).toHaveLength(0);

    let opened = 0;
    const door = render(<WaitingFoldNotice count={2} onOpenQueue={() => (opened += 1)} />);
    const buttons = door.root.findAllByType('button');
    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0] as ReactTestInstance)).toBe('2 messages waiting — on the Queue page');
    await runAsync(async () => buttons[0]?.props.onClick());
    expect(opened).toBe(1);
  });
});

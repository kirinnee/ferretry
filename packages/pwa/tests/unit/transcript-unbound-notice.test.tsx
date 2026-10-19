import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  TRANSCRIPT_UNBOUND_COPY,
  TRANSCRIPT_UNBOUND_RESTART_COPY,
  TranscriptUnboundNotice,
} from '../../src/components/transcript-unbound-notice.tsx';
import { render, runAsync } from '../support/react.ts';

const textOf = (node: ReactTestInstance | ReactTestRenderer): string => {
  const root = 'root' in node ? node.root : node;
  return root.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');
};

const button = (notice: ReactTestRenderer, label: string): ReactTestInstance =>
  notice.root.find(node => node.type === 'button' && textOf(node) === label);

describe('TranscriptUnboundNotice', () => {
  test('says what is known and offers a fresh look', async () => {
    let looks = 0;
    const notice = render(<TranscriptUnboundNotice onCheckAgain={() => (looks += 1)} />);

    await runAsync(async () => button(notice, 'Check again').props.onClick());

    expect(textOf(notice)).toContain(TRANSCRIPT_UNBOUND_COPY);
    expect(looks).toBe(1);
    // A viewer who may not restart is offered nothing it cannot do.
    expect(textOf(notice)).not.toContain('Restart CLI…');
  });

  test('restarts only after saying the conversation cannot be resumed, and reports a failed restart', async () => {
    const restarts: string[] = [];
    let fail = false;
    const notice = render(
      <TranscriptUnboundNotice
        onCheckAgain={() => undefined}
        onRestart={async () => {
          restarts.push('restart');
          if (fail) throw new Error('the daemon refused');
        }}
      />,
    );

    expect(textOf(notice)).toContain(TRANSCRIPT_UNBOUND_RESTART_COPY);
    await runAsync(async () => button(notice, 'Restart').props.onClick());
    expect(notice.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    fail = true;
    await runAsync(async () => button(notice, 'Restart').props.onClick());

    expect(restarts).toEqual(['restart', 'restart']);
    expect(textOf(notice.root.findByProps({ role: 'alert' }))).toContain('did not go through');
  });

  test('turns a second tap during a restart into nothing', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const notice = render(
      <TranscriptUnboundNotice
        onCheckAgain={() => undefined}
        onRestart={() => {
          calls += 1;
          return new Promise<void>(resolve => {
            release = resolve;
          });
        }}
      />,
    );

    await runAsync(async () => button(notice, 'Restart').props.onClick());
    const busy = button(notice, 'restarting…');
    expect(busy.props.disabled).toBe(true);
    await runAsync(async () => busy.props.onClick());
    await runAsync(async () => release());

    expect(calls).toBe(1);
    expect(button(notice, 'Restart').props.disabled).toBe(false);
  });
});

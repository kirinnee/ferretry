/**
 * The right-click quote menu needs the transcript's own scroll viewport to prove a selection sits inside
 * the transcript. With no viewport to prove it against, there is nothing quotable: the browser's own
 * menu stays, and no menu of ours opens.
 */
import { describe, expect, test } from 'bun:test';
import { Transcript } from '../../src/components/transcript.tsx';
import '../support/dom.ts';
import { render, run } from '../support/react.ts';

describe('Transcript quote menu without a viewport', () => {
  test('leaves the browser’s context menu alone and opens none of its own', () => {
    const transcript = render(<Transcript daemonId="daemon-a" entries={[]} sessionId="no-viewport" />);
    const log = transcript.root.findByProps({ role: 'log' });
    let prevented = false;

    run(() => {
      log.props.onPointerDownCapture({ pointerType: 'mouse' });
      log.props.onContextMenu({
        clientX: 24,
        clientY: 36,
        currentTarget: {} as HTMLDivElement,
        nativeEvent: { pointerType: 'mouse' },
        preventDefault: () => {
          prevented = true;
        },
      });
    });

    expect(prevented).toBe(false);
    expect(transcript.root.findAllByProps({ role: 'menuitem' })).toHaveLength(0);
  });
});

/**
 * Proves the session reply source: Live reads the session as it is now, hears every change of the three
 * fields it watches (and nothing else), and stops hearing when it unsubscribes.
 */
import { describe, expect, it } from 'bun:test';
import { useSessionReplySource } from '../../src/hooks/use-session-reply-source.ts';
import type { ReplySnapshot, ReplySource } from '../../src/lib/voice-chat/reply-feed.ts';
import { mount } from '../support/dom.ts';

function Host(props: { readonly snapshot: ReplySnapshot; readonly onSource: (source: ReplySource) => void }) {
  props.onSource(useSessionReplySource(props.snapshot));
  return null;
}

const snapshot = (patch: Partial<ReplySnapshot> = {}): ReplySnapshot => ({
  turnState: 'working',
  turnStateAt: 't1',
  status: 'running',
  ...patch,
});

describe('useSessionReplySource', () => {
  it('reads the session now, tells a subscriber about each change, and one source serves every render', async () => {
    let source: ReplySource | null = null;
    const sources = new Set<ReplySource>();
    const onSource = (next: ReplySource): void => {
      source = next;
      sources.add(next);
    };
    const view = await mount(<Host snapshot={snapshot()} onSource={onSource} />);
    const heard: (string | undefined)[] = [];
    const stop = (source as ReplySource | null)?.subscribe(
      () => void heard.push((source as ReplySource | null)?.current()?.turnState),
    );
    expect((source as ReplySource | null)?.current()?.turnState).toBe('working');
    await view.render(<Host snapshot={snapshot({ turnState: 'your-turn', turnStateAt: 't2' })} onSource={onSource} />);
    await view.render(<Host snapshot={snapshot({ turnState: 'your-turn', turnStateAt: 't2' })} onSource={onSource} />);
    expect(heard).toEqual(['your-turn']);
    expect(sources.size).toBe(1);
    stop?.();
    await view.render(
      <Host snapshot={snapshot({ turnState: 'needs-input', turnStateAt: 't3' })} onSource={onSource} />,
    );
    expect(heard).toEqual(['your-turn']);
    await view.unmount();
  });
});

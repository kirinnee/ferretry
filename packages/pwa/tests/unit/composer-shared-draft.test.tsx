import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SharedDraftServerFrame } from '@ferretry/protocol';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import type { DaemonStreamOpener } from '../../src/lib/event-transport.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

// The Plain textarea: the caret is read and set through its own selection, which a node mock stands in for.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({ daemonId: 'shared', baseUrl: 'https://shared.example.test', deviceId: 'device' });
const AT = '2026-11-01T00:00:00.000Z';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const settle = async (): Promise<void> =>
  await runAsync(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });

/** A daemon's stream the test speaks for: it hands down whatever frames the test pushes. */
const streamOf = () => {
  let deliver: ((frame: SharedDraftServerFrame) => void) | undefined;
  const sent: string[] = [];
  const open: DaemonStreamOpener = async (_daemon, request) => {
    deliver = frame => request.onData({ kind: 'text', text: JSON.stringify(frame) });
    return {
      sendStream: (frame: { text?: string }) => sent.push(frame.text ?? ''),
      closeStream: () => undefined,
      onStreamClosed: () => undefined,
    } as unknown as RelayClientSession;
  };
  return { open, sent, push: (frame: SharedDraftServerFrame) => run(() => deliver?.(frame)) };
};

const snapshot = (text: string): SharedDraftServerFrame => ({
  kind: 'snapshot',
  snapshot: { v: 1, sessionId: 's1', generation: 'g', epoch: 0, rev: 1, text, items: [], updatedAt: AT },
});

const mount = (stream: ReturnType<typeof streamOf>, stored = '') => {
  const selections: [number, number][] = [];
  const element = { selectionStart: 0, selectionEnd: 0, style: {}, value: '', focus: () => undefined };
  const drafts = new DaemonDraftStore(new MemoryStorage());
  if (stored !== '') drafts.save(daemonSessionScope(daemon, 's1'), stored, 1);
  const view: ReactTestRenderer = render(
    <Composer
      api={{ send: async () => ({}) } as never}
      daemon={daemon}
      draftStore={drafts}
      openDraftStream={stream.open}
      sessionId="s1"
    />,
    {
      createNodeMock: node =>
        node.type === 'textarea'
          ? Object.assign(element, {
              setSelectionRange: (start: number, end: number) => {
                selections.push([start, end]);
                element.selectionStart = start;
                element.selectionEnd = end;
              },
            })
          : null,
    },
  );
  Object.defineProperty(element, 'value', { get: () => String(view.root.findByType('textarea').props.value) });
  return { view, element, selections };
};

const text = (view: ReactTestRenderer): string => String(view.root.findByType('textarea').props.value);
const byData = (view: ReactTestRenderer, name: string) =>
  view.root.findAll(node => typeof node.type === 'string' && node.props[name] !== undefined);

describe('the composer, sharing its draft', () => {
  test("says where else the owner is typing, and keeps this caret where it was through the other device's words", async () => {
    // Arrange — "hello world" here, the caret after "hello".
    const stream = streamOf();
    const { view, element, selections } = mount(stream);
    await settle();
    stream.push(snapshot('hello world'));
    stream.push({ kind: 'ready' });
    await settle();
    element.selectionStart = 5;
    element.selectionEnd = 5;

    // Act — the phone types "oh " at the start, and says it is typing.
    stream.push({ kind: 'presence', peer: 'p', device: 'Kirin’s iPhone', typing: true });
    stream.push({
      kind: 'edit',
      applied: { generation: 'g', epoch: 0, rev: 2, text: ['oh ', 11], add: [], remove: [] },
      epoch: 0,
      rev: 2,
    });
    await settle();

    // Assert — the words arrived, the caret moved with "hello", and the hint names the phone.
    expect(text(view)).toBe('oh hello world');
    expect(selections.at(-1)).toEqual([8, 8]);
    const hint = byData(view, 'data-composer-presence');
    expect(hint).toHaveLength(1);
    expect(((hint[0]?.props.children ?? []) as unknown[]).filter(child => typeof child === 'string')).toEqual([
      'also typing on Kirin’s iPhone',
    ]);
    run(() => view.unmount());
  });

  test('offers back words this device held, and restores them after what is there — or lets them go', async () => {
    // Arrange — this device kept "old words" locally; the shared draft already holds the phone's.
    const stream = streamOf();
    const { view } = mount(stream, 'old words');
    await settle();
    stream.push(snapshot('from the phone'));
    await settle();
    expect(text(view)).toBe('from the phone');
    const buttons = () => view.root.findAll(node => node.type === 'button' && typeof node.props.children === 'string');
    const button = (label: string) => buttons().find(node => node.props.children === label);

    // Act / Assert — restore adds them after the phone's words.
    run(() => button('Restore them')?.props.onClick());
    await settle();
    expect(text(view)).toBe('from the phone\nold words');
    expect(byData(view, 'data-composer-conflict')).toHaveLength(0);
    run(() => view.unmount());

    // And dismissing leaves the shared draft alone.
    const second = streamOf();
    const other = mount(second, 'more old words');
    await settle();
    second.push(snapshot('theirs'));
    await settle();
    run(() =>
      other.view.root.findAll(node => node.type === 'button' && node.props.children === 'Dismiss')[0]?.props.onClick(),
    );
    await settle();
    expect(text(other.view)).toBe('theirs');
    expect(byData(other.view, 'data-composer-conflict')).toHaveLength(0);
    run(() => other.view.unmount());
  });

  test('leaves the caret alone when the textarea is not there to ask', async () => {
    const stream = streamOf();
    const view = render(
      <Composer
        api={{ send: async () => ({}) } as never}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        openDraftStream={stream.open}
        sessionId="s1"
      />,
    );
    await settle();
    stream.push(snapshot('a'));
    stream.push({
      kind: 'edit',
      applied: { generation: 'g', epoch: 0, rev: 2, text: [1, 'b'], add: [], remove: [] },
      epoch: 0,
      rev: 2,
    });
    await settle();
    expect(text(view)).toBe('ab');
    run(() => view.unmount());
  });
});

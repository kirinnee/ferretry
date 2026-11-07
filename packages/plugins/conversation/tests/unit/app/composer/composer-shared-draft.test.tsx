import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { DraftServerFrame as SharedDraftServerFrame } from '../../../../contract/index.ts';
import {
  socketOf,
  type SuiteStreamOpener as DaemonStreamOpener,
  type SuiteStreamSession,
  withClient,
} from '../../../support/app/composer-host.tsx';
import { fakeClient } from '../../../support/app/fake-client.ts';
import type { Instant } from '@ferretry/std';
import { useState } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { Composer } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { writeMdComposePref } from '@ferretry/app';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render, run, runAsync } from '@ferretry/app/testing';

// The Plain textarea: the caret is read and set through its own selection, which a node mock stands in for.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection('shared');
const AT = '2026-11-01T00:00:00.000Z' as Instant;

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
  const open: DaemonStreamOpener = request => {
    deliver = frame => request.onData({ kind: 'text', text: JSON.stringify(frame) });
    return {
      sendStream: (frame: { text?: string }) => sent.push(frame.text ?? ''),
      closeStream: () => undefined,
      onStreamClosed: () => undefined,
    } as unknown as SuiteStreamSession;
  };
  return { open, sent, push: (frame: SharedDraftServerFrame) => run(() => deliver?.(frame)) };
};

const snapshot = (text: string): SharedDraftServerFrame => ({
  kind: 'snapshot',
  snapshot: { v: 1, ferret: 's1' as FerretId, generation: 'g', epoch: 0, rev: 1, text, items: [], updatedAt: AT },
});

const mount = (stream: ReturnType<typeof streamOf>, stored = '') => {
  const selections: [number, number][] = [];
  const element = { selectionStart: 0, selectionEnd: 0, style: {}, value: '', focus: () => undefined };
  const drafts = new DaemonDraftStore(new MemoryStorage());
  if (stored !== '') drafts.save(daemonFerretScope(daemon, 's1'), stored, 1);
  const view: ReactTestRenderer = render(
    withClient(
      <Composer api={{ send: async () => ({}) } as never} daemon={daemon} draftStore={drafts} ferretId="s1" />,
      fakeClient({}, { more: socketOf(stream.open) }),
    ),
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
      withClient(
        <Composer
          api={{ send: async () => ({}) } as never}
          daemon={daemon}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          ferretId="s1"
        />,
        fakeClient({}, { more: socketOf(stream.open) }),
      ),
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

describe('a send finishing after the person moved on (review H1, acceptance step 2)', () => {
  test('never touches the session now showing: its words, its stream, its saved draft', async () => {
    // Arrange — one composer that follows the session the person is on; session A's send will be slow.
    const streams: Record<string, ReturnType<typeof streamOf>> = { s1: streamOf(), s2: streamOf() };
    const open: DaemonStreamOpener = request =>
      (request.ferretId === 's1' ? streams.s1 : streams.s2)?.open(request) as SuiteStreamSession;
    const client = fakeClient({}, { more: socketOf(open) });
    let release: (() => void) | undefined;
    const send = async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
      return {};
    };
    const storage = new MemoryStorage();
    const drafts = new DaemonDraftStore(storage);
    let switchTo: ((sessionId: string) => void) | undefined;
    const Page = () => {
      const [sessionId, setSession] = useState('s1');
      switchTo = setSession;
      return <Composer api={{ send } as never} daemon={daemon} draftStore={drafts} ferretId={sessionId} />;
    };
    const view = render(withClient(<Page />, client));
    await settle();
    streams.s1?.push(snapshot('words for A'));
    streams.s1?.push({ kind: 'ready' });
    await settle();

    // Act — send A, move to B before the answer, then the answer comes.
    await runAsync(async () => {
      void view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    run(() => switchTo?.('s2'));
    await settle();
    streams.s2?.push({
      kind: 'snapshot',
      snapshot: {
        v: 1,
        ferret: 's2' as FerretId,
        generation: 'g',
        epoch: 0,
        rev: 4,
        text: 'words for B',
        items: [],
        updatedAt: AT,
      },
    });
    streams.s2?.push({ kind: 'ready' });
    await settle();
    release?.();
    await settle();

    // Assert — B is exactly as it was; nothing went down B's stream; A's saved draft is let go.
    expect(text(view)).toBe('words for B');
    expect(streams.s2?.sent.filter(frame => frame.includes('"edit"'))).toEqual([]);
    expect(drafts.load(daemonFerretScope(daemon, 's1'))).toBe('');
    run(() => view.unmount());
  });

  test('a refused send leaves the draft exactly as it was, on every device', async () => {
    const stream = streamOf();
    const view = render(
      withClient(
        <Composer
          api={
            {
              send: async () => {
                throw new Error('refused');
              },
            } as never
          }
          daemon={daemon}
          draftStore={new DaemonDraftStore(new MemoryStorage())}
          ferretId="s1"
        />,
        fakeClient({}, { more: socketOf(stream.open) }),
      ),
    );
    await settle();
    stream.push(snapshot('keep these'));
    stream.push({ kind: 'ready' });
    await settle();
    await runAsync(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    await settle();
    expect(text(view)).toBe('keep these');
    expect(stream.sent.filter(frame => frame.includes('"edit"'))).toEqual([]);
    run(() => view.unmount());
  });
});

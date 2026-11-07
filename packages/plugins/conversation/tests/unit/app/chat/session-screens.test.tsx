import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FerretView } from '@ferretry/core-ferrets/contract';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../../../app/composer/composer.tsx';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { TranscriptRow } from '../../../../app/chat/transcript-row.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { isTerminalSessionStatus } from '../../../../app/chat/transcript-entries.ts';
import { quotableTranscriptSelectionText, relativeTime, StatusMark, statusMark } from '@ferretry/app';
import { render, run, runAsync } from '@ferretry/app/testing';
import { writeMdComposePref } from '@ferretry/app';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemonA = daemonConnection('daemon-a');
const daemonB = daemonConnection('daemon-b');

const session = (id: string, status: string, overrides: Record<string, unknown> = {}): FerretView =>
  ({
    config: {
      id,
      name: `Session ${id}`,
      label: `Task ${id}`,
      teammate: `Teammate ${id}`,
      model: 'gpt-5.6-sol',
      modelHint: 'gpt-5.6',
      agent: 'codex',
      mode: 'auto',
      cwd: `/work/${id}`,
      updatedAt: '1970-01-01T00:00:01.000Z',
      ...overrides,
    },
    state: {
      id,
      status,
      turn: 4,
      lastActivityAt: '1970-01-01T00:00:01.000Z',
      contextPercent: 54,
      activity: 'Writing tests',
    },
    directory: `/work/${id}`,
  }) as unknown as FerretView;

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const findText = (node: ReactTestInstance, text: string): ReactTestInstance[] =>
  node.findAll(item => item.children.includes(text));

describe('session screen components', () => {
  test('quotes only a non-empty selection that belongs to the transcript', () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const selection = (text: string, anchorNode: Node | null, focusNode: Node | null, collapsed = false) => ({
      isCollapsed: collapsed,
      rangeCount: 1,
      anchorNode,
      focusNode,
      toString: () => text,
    });
    const contains = (node: Node | null) => node === inside;

    expect(quotableTranscriptSelectionText(null, contains)).toBe('');
    expect(quotableTranscriptSelectionText(selection('selected', outside, outside), contains)).toBe('');
    expect(quotableTranscriptSelectionText(selection('  selected  ', inside, outside), contains)).toBe('selected');
    expect(quotableTranscriptSelectionText(selection('selected', inside, inside, true), contains)).toBe('');
  });

  test('keeps a touch transcript selection native but opens Quote for a mouse selection', () => {
    const inside = {} as Node;
    const viewport = {
      scrollHeight: 900,
      scrollTop: 700,
      clientHeight: 200,
      contains: (node: Node) => node === inside,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: inside,
      focusNode: inside,
      toString: () => 'Selected transcript prose',
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        getSelection: () => selection,
        innerHeight: 844,
        innerWidth: 390,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        activeElement: null,
        addEventListener: () => {},
        contains: () => false,
        getSelection: () => selection,
        removeEventListener: () => {},
      },
    });

    try {
      const transcript = render(<Transcript daemonId="daemon-a" entries={[]} sessionId="same-id" />, {
        createNodeMock: element => {
          const props = element.props as { role?: string };
          return element.type === 'div' && props.role === 'log' ? viewport : null;
        },
      });
      const log = transcript.root.findByProps({ role: 'log' });
      let nativePrevented = false;
      run(() => {
        log.props.onTouchStartCapture();
        log.props.onContextMenu({
          clientX: 24,
          clientY: 36,
          currentTarget: {} as HTMLDivElement,
          nativeEvent: {},
          preventDefault: () => {
            nativePrevented = true;
          },
        });
      });
      expect(nativePrevented).toBeFalse();

      let menuPrevented = false;
      run(() => {
        log.props.onPointerDownCapture({ pointerType: 'mouse' });
        log.props.onContextMenu({
          clientX: 24,
          clientY: 36,
          currentTarget: {} as HTMLDivElement,
          nativeEvent: { pointerType: 'mouse' },
          preventDefault: () => {
            menuPrevented = true;
          },
        });
      });
      expect(menuPrevented).toBeTrue();
      expect(findText(transcript.root, 'Quote in composer')).toHaveLength(1);
      run(() => transcript.root.findByProps({ role: 'menuitem' }).props.onClick());
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  test('formats session state and elapsed time for every visible range', () => {
    expect(isTerminalSessionStatus('completed')).toBe(true);
    expect(isTerminalSessionStatus('running')).toBe(false);
    expect(relativeTime(undefined, 30_000)).toBe('—');
    expect(relativeTime('not-a-date', 30_000)).toBe('—');
    expect(relativeTime(1, 30_000)).toBe('now');
    expect(relativeTime(1_000, 121_000)).toBe('2m ago');
    expect(relativeTime(1_000, 2 * 60 * 60_000 + 1_000)).toBe('2h ago');
    expect(relativeTime(1_000, 2 * 24 * 60 * 60_000 + 1_000)).toBe('2d ago');
  });

  test('renders the original shape vocabulary with text equivalents for active, parked, and finished sessions', () => {
    const active = session('active', 'running');
    const parked = {
      ...session('parked', 'running'),
      state: { ...session('parked', 'running').state, waiting: { condition: 'CI', peerName: 'Hayden' } },
    } as FerretView;
    const finished = session('finished', 'stalled');

    expect(statusMark(active)).toMatchObject({ shape: 'circle', tone: 'warn', live: true });
    expect(statusMark(parked)).toMatchObject({
      shape: 'diamond',
      tone: 'warn',
      label: 'waiting — parked for Hayden: CI',
    });
    expect(statusMark(finished)).toMatchObject({ shape: 'square', tone: 'err', live: false });

    const marks = render(
      <>
        <StatusMark view={active} />
        <StatusMark view={parked} size={10} />
        <StatusMark view={finished} />
      </>,
    );
    expect(marks.root.findAllByProps({ role: 'img' }).map(mark => mark.props.title)).toEqual([
      'active — running',
      'waiting — parked for Hayden: CI',
      'finished — stalled',
    ]);
  });

  test('renders transcript prose and daemon chrome with readable defaults and safe timestamps', () => {
    const rows = render(
      <>
        <TranscriptRow entry={{ id: 'user', kind: 'user', text: 'A human message' }} />
        <TranscriptRow
          entry={{ at: Number.NaN, id: 'assistant', kind: 'assistant', text: 'A **rendered** response' }}
        />
        <TranscriptRow entry={{ id: 'tool', kind: 'tool', text: 'working tree clean' }} />
        <TranscriptRow entry={{ id: 'notice', kind: 'notice', text: 'Daemon reconnected' }} />
      </>,
    );
    expect(rows.root.findAllByProps({ 'data-transcript-kind': 'user' })[0]?.props.className).toContain(
      'fy-message-user',
    );
    expect(rows.root.findAllByProps({ 'data-transcript-kind': 'assistant' })[0]?.props.className).toContain(
      'fy-message-assistant',
    );
    expect(rows.root.findAllByProps({ className: 'fy-message fy-message-tool fy-message-chrome' })).toHaveLength(1);
    expect(rows.root.findAllByProps({ className: 'fy-message fy-message-notice fy-message-chrome' })).toHaveLength(1);
    expect(rows.root.findByProps({ 'data-transcript-kind': 'user' }).props['data-transcript-density']).toBe('message');
    expect(rows.root.findByProps({ 'data-transcript-kind': 'assistant' }).props['data-transcript-density']).toBe(
      'message',
    );
    expect(rows.root.findByProps({ 'data-transcript-kind': 'tool' }).props['data-transcript-density']).toBe('chrome');
    expect(rows.root.findByProps({ 'data-transcript-kind': 'notice' }).props['data-transcript-density']).toBe('chrome');
    // The reader's own row has no "You" label any more — its alignment says who — only a screen-reader one.
    expect(findText(rows.root, 'You')).toHaveLength(0);
    expect(findText(rows.root, 'You said:')).toHaveLength(1);
    expect(findText(rows.root, 'Assistant')).toHaveLength(1);
    expect(findText(rows.root, 'Tool')).toHaveLength(1);
    expect(findText(rows.root, 'Daemon')).toHaveLength(1);
    expect(rows.root.findAllByType('strong').map(node => node.children.join(''))).toEqual(['rendered']);
    expect(rows.root.findAllByType('time')).toHaveLength(0);
  });

  test('submits, scopes drafts per daemon, and surfaces a send failure from the rendered composer', async () => {
    const storage = new MemoryStorage();
    const drafts = new DaemonDraftStore(storage);
    drafts.save(daemonFerretScope(daemonA, 'same-id'), 'Saved only for A', 1);
    const sent: string[] = [];
    const composer = render(
      <Composer
        api={{ send: async (_sessionId, payload) => sent.push(payload.message) as never }}
        busy
        daemon={daemonA}
        draftStore={drafts}
        onSent={() => sent.push('callback')}
        sessionId="same-id"
      />,
    );
    const textarea = composer.root.findByType('textarea');
    expect(textarea.props.value).toBe('Saved only for A');
    expect(drafts.load(daemonFerretScope(daemonB, 'same-id'))).toBe('');
    // While the agent works, Interrupt & send stands beside Send.
    expect(
      composer.root.findAll(node => node.type === 'button' && node.props['aria-label'] === 'Interrupt & send'),
    ).toHaveLength(1);
    await runAsync(async () => {
      composer.root.findByType('form').props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    expect(sent).toEqual(['Saved only for A', 'callback']);
    expect(composer.root.findByType('textarea').props.value).toBe('');

    const failing = render(
      <Composer
        api={{ send: async () => Promise.reject(new Error('offline')) as never }}
        daemon={daemonA}
        draftStore={drafts}
        sessionId="failed-id"
      />,
    );
    run(() => failing.root.findByType('textarea').props.onChange({ currentTarget: { value: 'retry this' } }));
    await runAsync(async () => {
      failing.root.findByType('form').props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    expect(failing.root.findByProps({ role: 'alert' }).children).toContain('offline');
  });

  test('honours the configured Enter action and disables its rendered submit action when disabled', () => {
    const savedMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
    try {
      const composer = render(
        <Composer
          api={{ send: async () => ({}) as never }}
          daemon={daemonA}
          disabled
          enterKeyPreference="newline"
          phoneEnterKeyPreference="newline"
          sessionId="disabled-id"
        />,
      );
      const textarea = composer.root.findByType('textarea');
      let prevented = false;
      run(() =>
        textarea.props.onKeyDown({
          key: 'Enter',
          shiftKey: false,
          nativeEvent: { isComposing: false },
          preventDefault: () => {
            prevented = true;
          },
        }),
      );
      expect(prevented).toBe(false);
      expect(textarea.props.disabled).toBe(true);
      expect(composer.root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
      run(() => composer.root.findByType('form').props.onSubmit({ preventDefault() {} }));

      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
      const desktop = render(
        <Composer
          api={{ send: async () => ({}) as never }}
          daemon={daemonA}
          disabled
          enterKeyPreference="send"
          phoneEnterKeyPreference="send"
          sessionId="desktop-id"
        />,
      );
      let desktopPrevented = false;
      run(() =>
        desktop.root.findByType('textarea').props.onKeyDown({
          key: 'Enter',
          shiftKey: false,
          nativeEvent: { isComposing: false },
          preventDefault: () => {
            desktopPrevented = true;
          },
        }),
      );
      expect(desktopPrevented).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: savedMatchMedia });
    }
  });

  test('sends on exactly the configured Enter chord', async () => {
    const press = async (
      preference: 'send' | 'newline',
      shiftKey: boolean,
    ): Promise<{ prevented: boolean; sent: string[] }> => {
      const drafts = new DaemonDraftStore(new MemoryStorage());
      const sessionId = `${preference}-${shiftKey ? 'shift' : 'bare'}`;
      drafts.save(daemonFerretScope(daemonA, sessionId), 'A complete message', 1);
      const sent: string[] = [];
      const composer = render(
        <Composer
          api={{ send: async (_sessionId, payload) => sent.push(payload.message) as never }}
          daemon={daemonA}
          draftStore={drafts}
          enterKeyPreference={preference}
          phoneEnterKeyPreference={preference}
          sessionId={sessionId}
        />,
      );
      let prevented = false;
      await runAsync(async () => {
        composer.root.findByType('textarea').props.onKeyDown({
          key: 'Enter',
          shiftKey,
          nativeEvent: { isComposing: false },
          preventDefault: () => {
            prevented = true;
          },
        });
        await Promise.resolve();
      });
      return { prevented, sent };
    };

    expect(await press('send', false)).toEqual({ prevented: true, sent: ['A complete message'] });
    expect(await press('send', true)).toEqual({ prevented: false, sent: [] });
    expect(await press('newline', false)).toEqual({ prevented: false, sent: [] });
    expect(await press('newline', true)).toEqual({ prevented: true, sent: ['A complete message'] });
  });
});

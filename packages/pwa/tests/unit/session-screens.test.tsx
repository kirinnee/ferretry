import type { SessionView } from '@ferretry/protocol';
import { describe, expect, test } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { SessionDetails } from '../../src/components/session-details.tsx';
import { SessionList } from '../../src/components/session-list.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { isTerminalSessionStatus, relativeTime } from '../../src/lib/session-screens.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://daemon-b.example.test',
  deviceToken: 'token-b',
});

const session = (id: string, status: string, overrides: Record<string, unknown> = {}): SessionView =>
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
  }) as unknown as SessionView;

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

  test('renders empty and populated daemon-scoped session lists, including every status treatment', () => {
    const opened: Array<readonly [string, string]> = [];
    const empty = render(<SessionList daemonId="daemon-a" onOpenSession={() => {}} sessions={[]} />);
    expect(empty.root.findByProps({ className: 'fy-empty' }).children).toContain('No sessions on this daemon yet.');

    const sessions = [
      session('failed', 'failed'),
      session('complete', 'completed'),
      session('waiting', 'waiting'),
      session('running', 'running', { label: undefined, teammate: undefined, model: undefined }),
    ];
    const list = render(
      <SessionList
        daemonId="daemon-a"
        now={2_000}
        onOpenSession={(daemonId, sessionId) => opened.push([daemonId, sessionId])}
        sessions={sessions}
      />,
    );

    expect(list.root.findByProps({ role: 'status' }).children).toContain('4');
    expect(list.root.findAllByProps({ className: 'fy-session-row-item' })).toHaveLength(4);
    expect(list.root.findAllByProps({ className: 'fy-status' }).map(row => row.props.style.color)).toEqual([
      'var(--err, #b42318)',
      'var(--muted, #667085)',
      'var(--warn, #a15c00)',
      'var(--ok, #027a48)',
    ]);
    expect(findText(list.root, '/work/running')).toHaveLength(1);
    expect(findText(list.root, 'codex')).toHaveLength(1);
    run(() => list.root.findAllByType('button')[0]?.props.onClick());
    expect(opened).toEqual([['daemon-a', 'failed']]);
  });

  test('renders session detail metadata, optional values, and the close affordance', () => {
    const closed: string[] = [];
    const full = render(
      <SessionDetails
        daemonId="daemon-b"
        now={2_000}
        onClose={() => closed.push('closed')}
        session={session('details', 'running')}
      />,
    );
    expect(findText(full.root, 'daemon-b')).toHaveLength(1);
    expect(findText(full.root, '54%')).toHaveLength(1);
    run(() => full.root.findByProps({ 'aria-label': 'Close session details' }).props.onClick());
    expect(closed).toEqual(['closed']);

    const minimal = render(
      <SessionDetails
        daemonId="daemon-b"
        now={2_000}
        session={
          {
            ...session('minimal', 'completed'),
            config: {
              ...session('minimal', 'completed').config,
              model: undefined,
              modelHint: '',
              parent: 'parent-session',
            },
            state: { ...session('minimal', 'completed').state, activity: undefined, contextPercent: undefined },
          } as SessionView
        }
      />,
    );
    const text = minimal.toJSON();
    expect(JSON.stringify(text)).toContain('No activity recorded');
    expect(JSON.stringify(text)).toContain('parent-session');
    expect(JSON.stringify(text)).toContain('—');
    expect(minimal.root.findAllByProps({ 'aria-label': 'Close session details' })).toHaveLength(0);
  });

  test('renders transcript entries and preserves detached-reader new-message behaviour', () => {
    const viewport = { scrollHeight: 900, scrollTop: 700, clientHeight: 200 };
    const first = [{ id: 'one', kind: 'assistant' as const, text: 'First answer', at: 1, label: 'Assistant' }];
    const transcript = render(<Transcript busy daemonId="daemon-a" entries={first} sessionId="same-id" />, {
      createNodeMock: element => {
        const props = element.props as { role?: string };
        return element.type === 'div' && props.role === 'log' ? viewport : null;
      },
    });
    expect(transcript.root.findByProps({ role: 'log' }).props['aria-live']).toBe('polite');
    expect(findText(transcript.root, 'Working…')).toHaveLength(1);
    expect(viewport.scrollTop).toBe(900);

    const log = transcript.root.findByProps({ role: 'log' });
    viewport.scrollTop = 0;
    run(() => log.props.onScroll());
    run(() =>
      transcript.update(
        <Transcript
          daemonId="daemon-a"
          entries={[...first, { id: 'two', kind: 'user', text: 'A follow-up' }]}
          sessionId="same-id"
        />,
      ),
    );
    const jump = transcript.root.findByProps({ className: 'fy-jump-latest' });
    expect(jump.children.join('')).toContain('1 new message · Jump to latest');
    run(() => jump.props.onClick());
    expect(viewport.scrollTop).toBe(900);
  });

  test('submits, scopes drafts per daemon, and surfaces a send failure from the rendered composer', async () => {
    const storage = new MemoryStorage();
    const drafts = new DaemonDraftStore(storage);
    drafts.save(daemonSessionScope(daemonA, 'same-id'), 'Saved only for A', 1);
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
    expect(drafts.load(daemonSessionScope(daemonB, 'same-id'))).toBe('');
    expect(findText(composer.root, 'Queue')).toHaveLength(1);
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

  test('keeps Enter inert on touch hardware and disables its rendered submit action when disabled', () => {
    const savedMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
    try {
      const composer = render(
        <Composer api={{ send: async () => ({}) as never }} daemon={daemonA} disabled sessionId="disabled-id" />,
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
      expect(composer.root.findByType('button').props.disabled).toBe(true);
      run(() => composer.root.findByType('form').props.onSubmit({ preventDefault() {} }));

      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
      const desktop = render(
        <Composer api={{ send: async () => ({}) as never }} daemon={daemonA} disabled sessionId="desktop-id" />,
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
});

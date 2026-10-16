import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import { Composer } from '../../src/components/composer.tsx';
import { ComposerQuota, composerQuotaPercent, composerQuotaSpoken } from '../../src/components/composer-quota.tsx';
import { ModeBadge } from '../../src/components/mode-badge.tsx';
import { QuotaReadout } from '../../src/components/quota-readout.tsx';
import { isSessionCommandUnsupported, SessionCommandControls } from '../../src/components/session-command-controls.tsx';
import { SessionDetails } from '../../src/components/session-details.tsx';
import { SessionHeader } from '../../src/components/session-header.tsx';
import { SessionList } from '../../src/components/session-list.tsx';
import { quotableTranscriptSelectionText, Transcript } from '../../src/components/transcript.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { isTerminalSessionStatus, relativeTime } from '../../src/lib/session-screens.ts';
import { StatusMark, statusMark } from '../../src/shell/status-mark.tsx';
import { render, run, runAsync } from '../support/react.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';

// The general composer behaviour is one key arbitration for every editor style; these suites drive it
// through the Plain textarea. The live editor (Markdown and Rich text) has its own suites.
beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceId: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://daemon-b.example.test',
  deviceId: 'token-b',
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

  test('renders empty and populated daemon-scoped session lists, including every status treatment', () => {
    const opened: Array<readonly [string, string]> = [];
    const empty = render(<SessionList daemonId="daemon-a" onOpenSession={() => {}} sessions={[]} />);
    expect(empty.root.findByProps({ className: 'fy-empty' }).children).toContain('No sessions on this daemon yet.');

    const sessions = [
      session('failed', 'failed'),
      session('complete', 'completed'),
      session('waiting', 'waiting'),
      session('running', 'running', {
        label: undefined,
        teammate: undefined,
        model: undefined,
      }),
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
    expect(list.root.findAllByProps({ role: 'img' }).map(mark => mark.props['aria-label'])).toEqual([
      'finished — failed',
      'finished — completed',
      'waiting — waiting',
      'active — running',
    ]);
    expect(findText(list.root, '/work/running')).toHaveLength(1);
    expect(findText(list.root, 'codex')).toHaveLength(1);
    expect(findText(list.root, 'quota —')).toHaveLength(4);
    run(() => list.root.findAllByType('button')[0]?.props.onClick());
    expect(opened).toEqual([['daemon-a', 'failed']]);
  });

  test('renders quota readings without treating unknown, auth trouble, and an exhausted account as the same state', () => {
    const absent = render(<QuotaReadout showUnknown />);
    expect(findText(absent.root, 'quota —')).toHaveLength(1);

    const optional = render(<QuotaReadout />);
    expect(optional.toJSON()).toBeNull();

    const auth = render(<QuotaReadout quota={{ authOk: false }} />);
    expect(findText(auth.root, 'quota auth!')).toHaveLength(1);
    expect(auth.root.findByType('span').props.title).toContain('not logged in');

    const empty = render(<QuotaReadout quota={{}} showUnknown />);
    expect(findText(empty.root, 'quota —')).toHaveLength(1);

    const used = render(<QuotaReadout quota={{ fiveHourPercent: 76, weeklyPercent: 91 }} />);
    expect(JSON.stringify(used.toJSON())).toContain('5h ');
    expect(JSON.stringify(used.toJSON())).toContain('76%');
    expect(JSON.stringify(used.toJSON())).toContain('wk ');
    expect(JSON.stringify(used.toJSON())).toContain('91%');
    expect(used.root.findByType('span').props.title).toContain('weekly window 91% used');

    const healthy = render(<QuotaReadout quota={{ fiveHourPercent: 7 }} />);
    expect(JSON.stringify(healthy.toJSON())).toContain('5h ');
    expect(JSON.stringify(healthy.toJSON())).toContain('7%');

    const limit = render(<QuotaReadout quota={{ atLimit: true }} />);
    expect(findText(limit.root, 'at limit')).toHaveLength(1);
    expect(limit.root.findByType('span').props.title).toContain('work is blocked');
  });

  test('renders the original shape vocabulary with text equivalents for active, parked, and finished sessions', () => {
    const active = session('active', 'running');
    const parked = {
      ...session('parked', 'running'),
      state: { ...session('parked', 'running').state, waiting: { condition: 'CI', peerName: 'Hayden' } },
    } as SessionView;
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

  test('names a stopped-but-not-finished session the same way in the list, the header and the sidebar', () => {
    // The list and the header once rendered their own copy of the badge, which called an
    // interrupted or rate-limited session "active" with a breathing circle while the sidebar
    // called it "waiting — rate_limited". One owner now draws all three, in words.
    const rateLimited = session('rate-limited', 'rate_limited');
    const interrupted = session('interrupted', 'interrupted');
    const list = render(
      <SessionList daemonId="daemon-a" onOpenSession={() => {}} sessions={[rateLimited, interrupted]} />,
    );
    const labels = list.root.findAllByProps({ role: 'img' }).map(mark => mark.props['aria-label']);

    expect(labels).toEqual(['waiting — rate limited', 'waiting — interrupted']);
    expect(labels).toEqual([statusMark(rateLimited).label, statusMark(interrupted).label]);
    expect(statusMark(rateLimited)).toMatchObject({ shape: 'diamond', live: false });
  });

  test('renders the original quiet mode badges in compact and full forms', () => {
    const badges = render(
      <>
        <ModeBadge mode="auto" size="sm" />
        <ModeBadge mode="interactive" />
      </>,
    );
    const rendered = badges.root.findAllByProps({ className: 'kt-badge fy-mode-badge fy-mode-badge-auto' });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.props['data-tone']).toBe('pend');
    expect(rendered[0]?.props['aria-label']).toContain('auto — autonomous');
    expect(rendered[0]?.children).toHaveLength(1);

    const interactive = badges.root.findByProps({ className: 'kt-badge fy-mode-badge ' });
    expect(interactive.props['data-tone']).toBe('accent');
    expect(interactive.props.title).toContain('interactive — human-driven');
    expect(interactive.children).toContain('interactive');
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

  test('renders a steering-only header and scopes every navigation control to its daemon', () => {
    const calls: Array<readonly [string, ...string[]]> = [];
    const header = render(
      <SessionHeader
        daemonId="daemon-b"
        onBack={daemonId => calls.push([daemonId, 'back'])}
        onOpenDetails={(daemonId, sessionId) => calls.push([daemonId, 'details', sessionId])}
        onOpenFleet={daemonId => calls.push([daemonId, 'fleet'])}
        session={session('header', 'awaiting_user', { label: 'Ship the session header' })}
      />,
    );
    expect(header.root.findByProps({ 'data-daemon-id': 'daemon-b' }).props.className).toBe('fy-session-header');
    expect(findText(header.root, 'Ship the session header')).toHaveLength(1);
    expect(findText(header.root, 'awaiting user')).toHaveLength(1);
    run(() => header.root.findByProps({ 'aria-label': 'Open sessions' }).props.onClick());
    run(() => header.root.findByProps({ 'aria-label': 'Back to sessions' }).props.onClick());
    run(() => header.root.findByProps({ 'aria-label': 'Open session details' }).props.onClick());
    expect(calls).toEqual([
      ['daemon-b', 'fleet'],
      ['daemon-b', 'back'],
      ['daemon-b', 'details', 'header'],
    ]);

    const quiet = render(
      <SessionHeader daemonId="daemon-a" session={session('fallback', 'completed', { label: undefined })} />,
    );
    expect(findText(quiet.root, 'Session fallback')).toHaveLength(1);
    expect(quiet.root.findAllByType('button')).toHaveLength(0);
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
    expect(findText(rows.root, 'You')).toHaveLength(1);
    expect(findText(rows.root, 'Assistant')).toHaveLength(1);
    expect(findText(rows.root, 'Tool')).toHaveLength(1);
    expect(findText(rows.root, 'Daemon')).toHaveLength(1);
    expect(rows.root.findAllByType('strong').map(node => node.children.join(''))).toEqual(['rendered']);
    expect(rows.root.findAllByType('time')).toHaveLength(0);
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

  test('renders the composer quota as a daemon-supplied context token, never a dash', () => {
    expect(composerQuotaPercent(-3)).toBe('0%');
    expect(composerQuotaPercent(12.6)).toBe('13%');
    expect(composerQuotaPercent(140)).toBe('100%');
    expect(composerQuotaSpoken(null)).toBe('Account usage unknown: the daemon has no reading for this account yet.');
    expect(composerQuotaSpoken({ weeklyPercent: 40 })).toBe(
      'Account usage: 5-hour window unknown; weekly window 40% used.',
    );
    expect(composerQuotaSpoken({ fiveHourPercent: 12 })).toBe(
      'Account usage: 5-hour window 12% used; weekly window unknown.',
    );

    // Nothing known: said in words, with no window label and no dash.
    for (const quota of [undefined, null, {}, { fiveHourPercent: Number.NaN }]) {
      const unknown = render(<ComposerQuota quota={quota} />);
      const token = unknown.root.findByProps({ className: 'fy-composer-quota' });
      expect(token.props['data-quota']).toBe('unknown');
      expect(findText(token, 'usage unknown')).toHaveLength(1);
      expect(JSON.stringify(unknown.toJSON())).not.toContain('—');
      expect(JSON.stringify(unknown.toJSON())).not.toContain('5h');
    }
    const limited = render(<ComposerQuota quota={{ atLimit: true }} />);
    expect(findText(limited.root, 'at limit')).toHaveLength(1);
    expect(limited.root.findAllByProps({ className: 'fy-quota-error' })).toHaveLength(1);
    expect(composerQuotaSpoken({ atLimit: true })).toContain('Account is at limit');

    // A credit-billed login with no window says its money, in words and aloud.
    const credit = render(<ComposerQuota quota={{ balance: { amount: 12.5, currency: 'USD' } }} />);
    expect(credit.root.findByProps({ className: 'fy-composer-quota' }).props['data-quota']).toBe('known');
    expect(findText(credit.root, '$12.50 left')).toHaveLength(1);
    expect(composerQuotaSpoken({ spendUsd: 3 })).toBe('Account usage: $3.00 this month.');

    // One window known: only that one is drawn.
    const weekOnly = render(<ComposerQuota quota={{ weeklyPercent: 40 }} />);
    expect(findText(weekOnly.root, 'wk 40%')).toHaveLength(1);
    expect(JSON.stringify(weekOnly.toJSON())).not.toContain('5h');
    expect(weekOnly.root.findAllByProps({ className: 'fy-quota-divider' })).toHaveLength(0);

    const auth = render(<ComposerQuota quota={{ authOk: false }} />);
    expect(findText(auth.root, 'quota auth!')).toHaveLength(1);

    const warning = render(<ComposerQuota quota={{ fiveHourPercent: 75, weeklyPercent: 10 }} />);
    expect(warning.root.findAllByProps({ className: ' fy-quota-warning' })).toHaveLength(1);

    const composer = render(
      <Composer
        api={{ send: async () => ({}) as never }}
        daemon={daemonA}
        quota={{ fiveHourPercent: 75, weeklyPercent: 92, atLimit: true }}
        sessionId="quota-id"
      />,
    );
    const quota = composer.root.findByProps({ className: 'fy-composer-quota' });
    expect(quota.props.title).toContain('Account is at limit');
    expect(quota.props['data-quota']).toBe('known');
    expect(findText(quota, '5h 75%')).toHaveLength(1);
    expect(findText(quota, 'wk 92%')).toHaveLength(1);
    expect(quota.findAllByProps({ className: 'fy-quota-divider' })).toHaveLength(1);
    expect(composer.root.findAllByProps({ className: ' fy-quota-error' })).toHaveLength(2);
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
      drafts.save(daemonSessionScope(daemonA, sessionId), 'A complete message', 1);
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

  test('renders compact context controls for an idle daemon-scoped session and reports completion', async () => {
    const calls: Array<readonly [string, string]> = [];
    const controls = render(
      <SessionCommandControls
        api={{ compact: async (daemon, sessionId) => calls.push([daemon.daemonId, sessionId]) as never }}
        canControl
        daemon={daemonA}
        open
        promptReady
        sessionId="same-id"
        status="awaiting_user"
      />,
    );
    expect(controls.root.findByProps({ 'data-daemon-id': 'daemon-a' }).props['aria-label']).toBe('Session context');
    expect(JSON.stringify(controls.toJSON())).not.toContain('Clear context');
    const action = controls.root.findByType('button');
    expect(action.props.disabled).toBe(false);
    await runAsync(async () => {
      action.props.onClick();
      await Promise.resolve();
    });
    expect(calls).toEqual([['daemon-a', 'same-id']]);
    expect(controls.root.findByProps({ role: 'status' }).children.join('')).toContain('conversation remains available');
  });

  test('renders context-control safety states and daemon compatibility failures', async () => {
    expect(isSessionCommandUnsupported({ status: 404, code: 'unknown_route' })).toBe(true);
    expect(isSessionCommandUnsupported({ status: 400, message: 'Runtime action unavailable' })).toBe(true);
    expect(isSessionCommandUnsupported({ status: 400, message: 'another failure' })).toBe(false);
    expect(isSessionCommandUnsupported(null)).toBe(false);

    const terminal = render(
      <SessionCommandControls
        api={{ compact: async () => ({}) as never }}
        canControl
        daemon={daemonA}
        open
        promptReady
        sessionId="terminal-id"
        status="completed"
      />,
    );
    expect(JSON.stringify(terminal.toJSON())).toContain('needs a running session');

    const readonly = render(
      <SessionCommandControls
        api={{ compact: async () => ({}) as never }}
        canControl={false}
        daemon={daemonB}
        open
        promptReady
        sessionId="readonly-id"
        status="awaiting_user"
      />,
    );
    expect(JSON.stringify(readonly.toJSON())).toContain('read-only');

    const busy = render(
      <SessionCommandControls
        api={{ compact: async () => ({}) as never }}
        canControl
        daemon={daemonA}
        open={false}
        promptReady={false}
        sessionId="busy-id"
        status="running"
      />,
    );
    expect(JSON.stringify(busy.toJSON())).toContain('never queues');
    expect(busy.root.findByType('button').props.disabled).toBe(true);

    const unsupported = render(
      <SessionCommandControls
        api={{
          compact: async () =>
            Promise.reject(Object.assign(new Error('missing'), { code: 'unknown_route', status: 404 })),
        }}
        canControl
        daemon={daemonA}
        open
        promptReady
        sessionId="unsupported-id"
        status="awaiting_user"
      />,
    );
    await runAsync(async () => {
      unsupported.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(unsupported.root.findByProps({ role: 'alert' }).children.join('')).toContain('restart required');

    const failure = render(
      <SessionCommandControls
        api={{ compact: async () => Promise.reject(new Error('offline')) }}
        canControl
        daemon={daemonA}
        open
        promptReady
        sessionId="failure-id"
        status="awaiting_user"
      />,
    );
    await runAsync(async () => {
      failure.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(failure.root.findByProps({ role: 'alert' }).children).toContain('offline');

    const plainFailure = render(
      <SessionCommandControls
        api={{ compact: async () => Promise.reject({ message: 'daemon unavailable' }) }}
        canControl
        daemon={daemonB}
        open
        promptReady
        sessionId="plain-failure-id"
        status="awaiting_user"
      />,
    );
    await runAsync(async () => {
      plainFailure.root.findByType('button').props.onClick();
      await Promise.resolve();
    });
    expect(plainFailure.root.findByProps({ role: 'alert' }).children).toContain('daemon unavailable');
  });
});

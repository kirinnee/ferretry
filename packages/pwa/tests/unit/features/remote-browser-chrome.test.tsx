import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import type { BrowserAction, BrowserStatus } from '@ferretry/protocol';

import {
  RemoteBrowserControls,
  RemoteBrowserGovernor,
  RemoteBrowserNavigation,
  RemoteBrowserPageTabs,
  RemoteBrowserStatusBar,
  remoteBrowserAddressUrl,
  remoteBrowserPage,
} from '../../../src/features/browser/remote-browser-chrome.tsx';
import { render, run } from '../../support/react.ts';

const base = {
  sessionId: 'session-a',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
} as const;

const stopped = { ...base, state: 'stopped', pages: [] } satisfies BrowserStatus;

const running = (overrides: Partial<Extract<BrowserStatus, { url: string }>> = {}): BrowserStatus =>
  ({
    ...base,
    state: 'running',
    url: 'https://example.test/one',
    title: 'One',
    pages: [
      { id: 'p1', url: 'https://example.test/one', title: 'One' },
      { id: 'p2', url: 'https://other.test/two', title: '' },
    ],
    activePageId: 'p1',
    pageState: 'ready',
    canGoBack: true,
    canGoForward: false,
    ...overrides,
  }) as BrowserStatus;

const byLabel = (tree: ReactTestInstance, label: string): ReactTestInstance =>
  tree.find(node => typeof node.type === 'string' && node.props['aria-label'] === label);

const texts = (tree: ReactTestInstance): string[] =>
  tree
    .findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'))
    .map(child => child.trim())
    .filter(child => child !== '');

describe('remote browser status bar', () => {
  it('reads lifecycle, attribution and transport out of one snapshot', () => {
    const tree = render(
      <RemoteBrowserStatusBar status={running({ pageState: 'loading' })} connection="connected" />,
    ).root;
    expect(texts(tree)).toContain('running');
    expect(texts(tree)).toContain('Loading page…');
    expect(texts(tree)).toContain('Live');
  });

  it('prefers the busy notice, names the actor, and degrades before a first status', () => {
    expect(texts(render(<RemoteBrowserStatusBar status={running()} connection="connected" busy />).root)).toContain(
      'Working…',
    );
    const human = render(
      <RemoteBrowserStatusBar
        status={running({ lastActor: { kind: 'human', at: '2026-07-31T00:00:00.000Z', action: 'click' } })}
        connection="connecting"
      />,
    ).root;
    expect(texts(human)).toContain('You · click');
    expect(texts(human)).toContain('Connecting…');
    const agent = render(
      <RemoteBrowserStatusBar
        status={running({ lastActor: { kind: 'agent', at: '2026-07-31T00:00:00.000Z', action: 'navigate' } })}
        connection="detached"
      />,
    ).root;
    expect(texts(agent)).toContain('Agent · navigate');
    const failed = render(
      <RemoteBrowserStatusBar status={running({ pageState: 'error', pageError: 'boom' })} connection="disconnected" />,
    ).root;
    expect(texts(failed)).toContain('Page failed');
    const unknown = render(<RemoteBrowserStatusBar status={null} connection="detached" />).root;
    expect(texts(unknown)).toContain('checking');
    expect(texts(unknown)).toContain('No input yet');
    expect(texts(unknown)).toContain('Display idle');
    expect(
      texts(
        render(
          <RemoteBrowserStatusBar status={{ ...base, state: 'error', pages: [], error: 'x' }} connection="detached" />,
        ).root,
      ),
    ).toContain('error');
  });
});

describe('remote browser page tabs', () => {
  it('renders only the daemon’s real pages and dispatches page actions', () => {
    const actions: BrowserAction[] = [];
    const tree = render(<RemoteBrowserPageTabs status={running()} onAction={a => actions.push(a)} />).root;
    const tabs = tree.findAll(node => node.props.role === 'tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.props['aria-selected']).toBe(true);
    expect(tabs[1]?.props['aria-selected']).toBe(false);
    // The untitled page falls back to its host, never to an invented name.
    expect(texts(tree)).toContain('other.test');
    run(() => tabs[1]?.props.onClick());
    run(() => byLabel(tree, 'Close One').props.onClick());
    run(() => byLabel(tree, 'New Chrome tab').props.onClick());
    expect(actions).toEqual([
      { action: 'activate-page', pageId: 'p2' },
      { action: 'close-page', pageId: 'p1' },
      { action: 'new-page' },
    ]);
  });

  it('marks the agent tab and keeps saying so after that tab is closed', () => {
    const marked = render(
      <RemoteBrowserPageTabs
        status={running({
          agentPage: { pageId: 'p2', kind: 'agent', action: 'click', at: '2026-07-31T00:00:00.000Z' },
        })}
        onAction={() => {}}
      />,
    ).root;
    expect(texts(marked)).toContain('Agent last used this tab.');
    expect(texts(marked)).not.toContain('Agent last used a closed tab.');
    const orphaned = render(
      <RemoteBrowserPageTabs
        status={running({
          agentPage: { pageId: 'gone', kind: 'agent', action: 'click', at: '2026-07-31T00:00:00.000Z' },
        })}
        onAction={() => {}}
      />,
    ).root;
    expect(texts(orphaned)).toContain('Agent last used a closed tab.');
  });

  it('renders no strip at all when the daemon reports no live page', () => {
    expect(render(<RemoteBrowserPageTabs status={stopped} onAction={() => {}} />).toJSON()).toBeNull();
    expect(render(<RemoteBrowserPageTabs status={null} onAction={() => {}} />).toJSON()).toBeNull();
    // A running browser with an empty page tuple is a real daemon state.
    expect(
      render(<RemoteBrowserPageTabs status={{ ...base, state: 'running', pages: [] }} onAction={() => {}} />).toJSON(),
    ).toBeNull();
  });

  it('disables every tab control while a mutation is in flight', () => {
    const tree = render(<RemoteBrowserPageTabs status={running()} busy onAction={() => {}} />).root;
    expect(tree.findAll(node => node.type === 'button').every(node => node.props.disabled)).toBe(true);
  });
});

describe('remote browser address bar', () => {
  it('accepts a bare hostname and refuses a non-web scheme', () => {
    expect(remoteBrowserAddressUrl('example.test')).toBe('https://example.test/');
    expect(remoteBrowserAddressUrl('http://example.test/a')).toBe('http://example.test/a');
    expect(remoteBrowserAddressUrl('  https://example.test/a  ')).toBe('https://example.test/a');
    expect(remoteBrowserAddressUrl('')).toBeNull();
    expect(remoteBrowserAddressUrl('   ')).toBeNull();
    expect(remoteBrowserAddressUrl('example.test:8080/a')).toBe('https://example.test:8080/a');
    // An explicit non-web scheme is judged on that scheme; it never gets the
    // https:// fallback, which would smuggle it through as a bare host.
    expect(remoteBrowserAddressUrl('javascript:alert(1)')).toBeNull();
    expect(remoteBrowserAddressUrl('file:///etc/passwd')).toBeNull();
    expect(remoteBrowserAddressUrl('ftp://x.test')).toBeNull();
  });

  it('mirrors the committed url and submits a normalised address', () => {
    const actions: BrowserAction[] = [];
    const renderer = render(<RemoteBrowserNavigation status={running()} onAction={a => actions.push(a)} />);
    const input = renderer.root.findByType('input');
    expect(input.props.value).toBe('https://example.test/one');
    run(() => input.props.onChange({ target: { value: 'other.test' } }));
    run(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }));
    expect(actions).toEqual([{ action: 'navigate', url: 'https://other.test/' }]);
  });

  it('never overwrites an address the human is still editing', () => {
    const renderer = render(<RemoteBrowserNavigation status={running()} onAction={() => {}} />);
    const input = () => renderer.root.findByType('input');
    run(() => input().props.onFocus());
    run(() => input().props.onChange({ target: { value: 'half-typed.test' } }));
    // The page navigated under the reader's fingers; the typed text wins.
    run(() =>
      renderer.update(<RemoteBrowserNavigation status={running({ url: 'https://moved.test/' })} onAction={() => {}} />),
    );
    expect(input().props.value).toBe('half-typed.test');
    // Blur alone must NOT clear it — that reset used to race a tapped Go.
    run(() => input().props.onBlur());
    expect(input().props.value).toBe('half-typed.test');
    // Once they are done, the next real navigation is mirrored again.
    run(() =>
      renderer.update(<RemoteBrowserNavigation status={running({ url: 'https://later.test/' })} onAction={() => {}} />),
    );
    expect(input().props.value).toBe('https://later.test/');
  });

  it('reports a rejected address instead of silently dropping the submission', () => {
    const actions: BrowserAction[] = [];
    const rejected: string[] = [];
    const renderer = render(
      <RemoteBrowserNavigation
        status={running()}
        onAction={a => actions.push(a)}
        onInvalidAddress={message => rejected.push(message)}
      />,
    );
    run(() => renderer.root.findByType('input').props.onChange({ target: { value: 'javascript:alert(1)' } }));
    run(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }));
    expect(actions).toEqual([]);
    expect(rejected).toEqual(['“javascript:alert(1)” is not an http or https address.']);
  });

  it('drops an invalid submission even with no reporter attached', () => {
    const actions: BrowserAction[] = [];
    const renderer = render(<RemoteBrowserNavigation status={running()} onAction={a => actions.push(a)} />);
    run(() => renderer.root.findByType('input').props.onChange({ target: { value: 'ftp://x.test' } }));
    run(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }));
    expect(actions).toEqual([]);
  });

  it('drives history from the daemon flags, not from a client-side guess', () => {
    const actions: BrowserAction[] = [];
    const tree = render(
      <RemoteBrowserNavigation status={running({ canGoForward: true })} onAction={a => actions.push(a)} />,
    ).root;
    expect(byLabel(tree, 'Back').props.disabled).toBe(false);
    expect(byLabel(tree, 'Forward').props.disabled).toBe(false);
    run(() => byLabel(tree, 'Back').props.onClick());
    run(() => byLabel(tree, 'Forward').props.onClick());
    run(() => byLabel(tree, 'Reload').props.onClick());
    expect(actions).toEqual([{ action: 'back' }, { action: 'forward' }, { action: 'reload' }]);
    const blocked = render(<RemoteBrowserNavigation status={running({ canGoBack: false })} onAction={() => {}} />).root;
    expect(byLabel(blocked, 'Back').props.disabled).toBe(true);
    expect(byLabel(blocked, 'Forward').props.disabled).toBe(true);
  });

  it('keeps every navigation control inert while stopped or busy', () => {
    const stoppedTree = render(<RemoteBrowserNavigation status={stopped} onAction={() => {}} />).root;
    expect(stoppedTree.findByType('input').props.disabled).toBe(true);
    expect(stoppedTree.findByType('input').props.value).toBe('');
    expect(byLabel(stoppedTree, 'Back').props.disabled).toBe(true);
    const busyTree = render(<RemoteBrowserNavigation status={running()} busy onAction={() => {}} />).root;
    expect(byLabel(busyTree, 'Reload').props.disabled).toBe(true);
  });
});

describe('remote browser controls', () => {
  const controls = (status: BrowserStatus, extra: Record<string, unknown> = {}) => {
    const actions: BrowserAction[] = [];
    const calls: string[] = [];
    const tree = render(
      <RemoteBrowserControls
        status={status}
        connection="connected"
        fit
        viewportMode="responsive"
        onAction={a => actions.push(a)}
        onToggleFit={() => calls.push('fit')}
        onToggleViewportMode={() => calls.push('viewport')}
        onPasteFromClipboard={() => calls.push('paste')}
        {...extra}
      />,
    ).root;
    return { tree, actions, calls };
  };

  it('offers start while stopped and stop while running', () => {
    const idle = controls(stopped);
    expect(texts(idle.tree)).toContain('Start browser');
    run(() => idle.tree.findAllByType('button')[0]?.props.onClick());
    expect(idle.actions).toEqual([{ action: 'start' }]);
    const live = controls(running());
    expect(texts(live.tree)).toContain('Stop');
    run(() => live.tree.findAllByType('button')[0]?.props.onClick());
    expect(live.actions).toEqual([{ action: 'stop' }]);
  });

  it('does not offer a second start while the daemon is already starting', () => {
    const starting = controls({ ...base, state: 'starting', pages: [] });
    expect(starting.tree.findAllByType('button')[0]?.props.disabled).toBe(true);
  });

  it('raises viewport, fit and clipboard intent without owning the transport', () => {
    const live = controls(running());
    const buttons = live.tree.findAllByType('button');
    run(() => buttons[1]?.props.onClick());
    run(() => buttons[2]?.props.onClick());
    run(() => buttons[3]?.props.onClick());
    expect(live.calls).toEqual(['paste', 'fit', 'viewport']);
    expect(live.actions).toEqual([]);
    expect(texts(live.tree)).toContain('Responsive');
    expect(texts(live.tree)).toContain('Fit');
  });

  it('shows the alternate viewport and scale labels when they are engaged', () => {
    const alternate = controls(running(), { fit: false, viewportMode: 'desktop' });
    expect(texts(alternate.tree)).toContain('Desktop fit');
    expect(texts(alternate.tree)).toContain('1:1');
  });

  it('blocks paste unless the display is actually attached', () => {
    const detached = controls(running(), { connection: 'connecting' });
    expect(detached.tree.findAllByType('button')[1]?.props.disabled).toBe(true);
    const stoppedTree = controls(stopped);
    expect(stoppedTree.tree.findAllByType('button')[2]?.props.disabled).toBe(true);
    const busyTree = controls(running(), { busy: true });
    expect(busyTree.tree.findAllByType('button')[0]?.props.disabled).toBe(true);
  });
});

describe('remote browser governor', () => {
  it('reports the negotiated viewport, viewers and idle stop', () => {
    expect(texts(render(<RemoteBrowserGovernor status={running()} />).root)).toContain(
      '1280×800 · 1 viewer · 15m idle stop',
    );
    expect(texts(render(<RemoteBrowserGovernor status={{ ...stopped, viewers: 2 }} />).root)).toContain(
      '1280×800 · 2 viewers · 15m idle stop',
    );
    expect(texts(render(<RemoteBrowserGovernor status={null} />).root)).toContain('Checking browser lifecycle…');
  });

  it('narrows only a running status that has committed a page', () => {
    expect(remoteBrowserPage(null)).toBeNull();
    expect(remoteBrowserPage(stopped)).toBeNull();
    expect(remoteBrowserPage(running())?.activePageId).toBe('p1');
  });
});

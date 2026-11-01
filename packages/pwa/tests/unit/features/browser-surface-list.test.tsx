import { describe, expect, test } from 'bun:test';
import type { BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  BrowserSurfaceList,
  type BrowserSurfaceListProps,
  browserOwnerLabel,
  browserPageLabel,
  groupBrowserPages,
} from '../../../src/features/browser/browser-surface-list.tsx';
import { render, run } from '../../support/react.ts';

const page = (id: string, extra: Partial<BrowserPageSummary> = {}): BrowserPageSummary => ({
  id,
  url: `https://example.test/${id.toLowerCase()}`,
  title: `Title ${id}`,
  ...extra,
});

const APP = page('PAGE1', { name: 'app', ownerSessionId: 'hadi', ownerName: 'Hadi' });
const DOCS = page('PAGE2', { name: 'docs', incognito: true, ownerSessionId: 'hadi', ownerName: 'Hadi' });
const PR = page('PAGE3', { ownerSessionId: 'hadi', ownerName: 'Hadi' });
const MARIN = page('PAGE4', { name: 'grafana', ownerSessionId: 'marin', ownerName: 'Marin' });

const status = (pages: readonly BrowserPageSummary[], state: BrowserStatus['state'] = 'running'): BrowserStatus =>
  ({
    sessionId: 'hadi',
    state,
    pages: [...pages],
    viewport: { width: 1280, height: 800 },
    viewers: 0,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: pages.length, maximum: 60 },
  }) as BrowserStatus;

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');

const mount = (overrides: Partial<BrowserSurfaceListProps> = {}) => {
  const opened: string[] = [];
  const closed: string[] = [];
  let created = 0;
  const props: BrowserSurfaceListProps = {
    status: status([APP, DOCS, PR]),
    sessionName: 'Hadi',
    driverFor: candidate => (candidate.id === 'PAGE1' ? { name: 'Hadi' } : null),
    takenOver: candidate => candidate.id === 'PAGE3',
    onOpenPage: candidate => opened.push(candidate.id),
    onClosePage: candidate => closed.push(candidate.id),
    onNewPage: () => {
      created += 1;
    },
    ...overrides,
  };
  const renderer = render(<BrowserSurfaceList {...props} />);
  return { renderer, opened, closed, created: () => created };
};

describe('groupBrowserPages', () => {
  test('should group pages by the session that owns them, in first-seen order, popups with their opener', () => {
    const groups = groupBrowserPages([APP, MARIN, DOCS, page('PAGE5', { openerId: 'PAGE4', ownerSessionId: 'marin' })]);
    expect(groups.map(group => [group.label, group.pages.map(entry => entry.id)])).toEqual([
      ['Hadi’s browser', ['PAGE1', 'PAGE2']],
      ['Marin’s browser', ['PAGE4', 'PAGE5']],
    ]);
  });

  test('should file an unowned page under the session, by its agent name when it has one', () => {
    expect(groupBrowserPages([page('X')], 'Hadi')[0]?.label).toBe('Hadi’s browser');
    expect(groupBrowserPages([page('X')])[0]?.label).toBe('This session’s browser');
    expect(browserOwnerLabel('')).toBe('This session’s browser');
  });

  test('should call a page by its name, else by its title or host', () => {
    expect(browserPageLabel(APP)).toBe('app');
    expect(browserPageLabel(PR)).toBe('Title PAGE3');
  });
});

describe('BrowserSurfaceList', () => {
  test('should list every page under its owner, with the incognito, AGENT and taken-over badges', () => {
    // Act
    const { renderer } = mount({ selectedPageId: 'PAGE1', status: status([APP, DOCS, PR, MARIN]) });

    // Assert
    const groups = renderer.root.findAllByProps({ className: 'fy-ws-pages-group' });
    expect(groups.map(group => group.props['aria-label'])).toEqual(['Hadi’s browser', 'Marin’s browser']);
    const chips = renderer.root.findAll(node => node.type === 'button' && node.props.className === 'fy-ws-page');
    expect(chips.map(chip => chip.props['data-browser-page'])).toEqual(['PAGE1', 'PAGE2', 'PAGE3', 'PAGE4']);
    expect(chips[0]?.props['aria-current']).toBe('page');
    expect(chips[1]?.props['aria-current']).toBeUndefined();
    expect(text(chips[0] as ReactTestInstance)).toBe('appAGENT');
    expect(text(chips[1] as ReactTestInstance)).toBe('docsIncognito');
    expect(text(chips[2] as ReactTestInstance)).toBe('Title PAGE3You');
    expect(chips[1]?.props.title).toBe('docs: Title PAGE2 — https://example.test/page2');
    expect(chips[2]?.props.title).toBe('Title PAGE3 — https://example.test/page3');
    // New page sits in the FIRST owner's row only.
    expect(renderer.root.findAllByProps({ className: 'fy-ws-pages-new' })).toHaveLength(1);
  });

  test('should open a page, close a page and open a new one', () => {
    const { renderer, opened, closed, created } = mount();
    run(() => renderer.root.findByProps({ 'data-browser-page': 'PAGE2' }).props.onClick());
    run(() => renderer.root.findByProps({ 'aria-label': 'Close docs' }).props.onClick());
    run(() => renderer.root.findByProps({ className: 'fy-ws-pages-new' }).props.onClick());
    expect(opened).toEqual(['PAGE2']);
    expect(closed).toEqual(['PAGE2']);
    expect(created()).toBe(1);
  });

  test('should offer no close and no new page when the host gives no way to do either', () => {
    const { renderer } = mount({ onClosePage: undefined, onNewPage: undefined });
    expect(renderer.root.findAllByProps({ className: 'fy-ws-page-close' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ className: 'fy-ws-pages-new' })).toHaveLength(0);
  });

  test('should say plainly when the list is unread, empty, or the browser is not running', () => {
    const note = (overrides: Partial<BrowserSurfaceListProps>) =>
      text(mount(overrides).renderer.root.findByProps({ className: 'fy-ws-pages-note' }));
    expect(note({ status: null })).toBe('No page list from this machine yet.');
    expect(note({ status: status([]) })).toBe('Hadi’s browser has no pages open.');
    expect(note({ status: status([], 'stopped'), sessionName: undefined })).toBe(
      'This session’s browser has no pages open — it is not running.',
    );
    // The way to open one stays beside the note.
    expect(mount({ status: status([]) }).renderer.root.findAllByProps({ className: 'fy-ws-pages-new' })).toHaveLength(
      1,
    );
  });
});

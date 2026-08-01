import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { GroupBlock, parentTrail, rowLabels, SidebarRow } from '../../src/shell/agent-sidebar-rows.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { buildLineage, nestByLineage } from '../../src/lib/lineage.ts';
import type { OpenSessionMenu } from '../../src/shell/row-context-gesture.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonId('alpha');

const byIdOf = (sessions: readonly SessionView[]): ReadonlyMap<string, SessionView> =>
  new Map(sessions.map(view => [view.config.id, view]));

const rowsOf = (sessions: readonly SessionView[]) => nestByLineage(sessions, buildLineage(sessions));

const chain = (depth: number): SessionView[] =>
  Array.from({ length: depth }, (_, index) =>
    sessionView(`s-${index}`, {
      config: {
        name: `Task ${index}`,
        teammate: `mate-${index}`,
        ...(index > 0 ? { parent: `s-${index - 1}` } : {}),
      },
    }),
  );

const linkOf = (container: HTMLElement, id: string): HTMLAnchorElement =>
  must(
    [...container.querySelectorAll('a')].find(anchor => anchor.getAttribute('href')?.endsWith(`/${id}`)),
    `the row link for ${id}`,
  );

describe('rowLabels', () => {
  test('splits the comma list and drops the blanks', () => {
    expect(rowLabels('  batch , , urgent ')).toEqual(['batch', 'urgent']);
    expect(rowLabels(undefined)).toEqual([]);
  });
});

describe('parentTrail', () => {
  test('reads oldest ancestor first and names an unresolved parent by its short id', () => {
    const sessions = chain(3);
    const trail = must(parentTrail(sessions[2]!, byIdOf(sessions)), 'a trail');
    expect(trail.text).toBe('Mate-0 · Task 0 → Mate-1 · Task 1');
    expect(trail.full).toContain('s-0');
    expect(trail.full).toContain('s-1');
  });

  test('names a parent this daemon never sent', () => {
    const orphan = sessionView('kid', { config: { parent: 'ghost-session-id' } });
    const trail = must(parentTrail(orphan, byIdOf([orphan])), 'a trail');
    expect(trail.full).toBe('ghost-session-id');
  });

  test('is undefined for a root and terminates on a cycle', () => {
    const root = sessionView('root');
    expect(parentTrail(root, byIdOf([root]))).toBeUndefined();

    const left = sessionView('left', { config: { parent: 'right' } });
    const right = sessionView('right', { config: { parent: 'left' } });
    const cyclic = must(parentTrail(left, byIdOf([left, right])), 'a truncated trail');
    expect(cyclic.text.split(' → ').length).toBeLessThanOrEqual(2);
  });
});

describe('SidebarRow', () => {
  const render = async (sessions: readonly SessionView[], overrides: Record<string, unknown> = {}) => {
    const rows = rowsOf(sessions);
    return mount(
      <ul>
        <SidebarRow active={false} byId={byIdOf(sessions)} canMutate daemonId={alpha} row={rows[0]!} {...overrides} />
      </ul>,
    );
  };

  test('links to the session ON ITS DAEMON, never to a bare session id', async () => {
    const sessions = [sessionView('s-1', { config: { name: 'Fix scrolling', teammate: 'loge' } })];
    const screen = await render(sessions);
    expect(linkOf(screen.container, 's-1').getAttribute('href')).toBe('/d/alpha/session/s-1');
    await screen.unmount();
  });

  test('says four facts: the task, the teammate, the labels and a status mark', async () => {
    const sessions = [
      sessionView('s-1', { config: { name: 'Fix scrolling', teammate: 'loge', label: 'batch,urgent' } }),
    ];
    const screen = await render(sessions);
    const link = linkOf(screen.container, 's-1');
    expect(link.textContent).toContain('Fix scrolling');
    expect(link.textContent).toContain('Loge');
    expect(link.textContent).toContain('batch');
    expect(link.textContent).toContain('urgent');
    // No dashboard columns: no model, context %, quota or age.
    expect(link.textContent).not.toContain('%');
    await screen.unmount();
  });

  test('marks the row a reader is on with aria-current, not with colour alone', async () => {
    const sessions = [sessionView('s-1')];
    const screen = await render(sessions, { active: true });
    expect(linkOf(screen.container, 's-1').getAttribute('aria-current')).toBe('page');
    await screen.unmount();
  });

  test('falls back to the session id when there is no callsign', async () => {
    const sessions = [sessionView('s-1', { config: { name: 'Only a task' } })];
    const screen = await render(sessions);
    expect(linkOf(screen.container, 's-1').textContent).toContain('s-1');
    await screen.unmount();
  });

  test('nests children under a visible parent and rails the child list', async () => {
    const sessions = chain(2);
    const screen = await render(sessions, { activeId: 's-1' });
    const childList = must(screen.container.querySelector('li ul'), 'the child list');
    expect(childList.className).toContain('border-l');
    expect(linkOf(screen.container, 's-1').getAttribute('aria-current')).toBe('page');
    await screen.unmount();
  });

  test('speaks the lineage a hidden parent leaves behind', async () => {
    const orphan = sessionView('kid', { config: { parent: 'ghost' } });
    const screen = await render([orphan]);
    expect(must(screen.container.querySelector('.sr-only'), 'the lineage sentence').textContent).toContain(
      'spawned by ghost',
    );
    await screen.unmount();
  });

  test('names a resolved parent in the spoken lineage', async () => {
    const sessions = chain(2);
    const screen = await render(sessions);
    expect(must(screen.container.querySelector('li ul .sr-only'), 'the child lineage').textContent).toContain(
      'spawned by Mate-0',
    );
    await screen.unmount();
  });

  test('stops indenting past the cap and carries the trail as a marker instead', async () => {
    const sessions = chain(5);
    const screen = await render(sessions);
    const deepLink = linkOf(screen.container, 's-4');
    expect(deepLink.getAttribute('title')).toContain('spawned by');
    expect(deepLink.textContent).toContain('»');
    const sentences = [...screen.container.querySelectorAll('.sr-only')].map(node => node.textContent ?? '');
    expect(sentences.some(text => text.includes('full lineage:'))).toBe(true);
    await screen.unmount();
  });

  test('badges unresolved attention from the host’s daemon-scoped ledger only', async () => {
    const sessions = [sessionView('s-1')];
    const screen = await render(sessions, { attentionCountFor: (id: string) => (id === 's-1' ? 3 : 0) });
    const badge = must(screen.container.querySelector('[role="status"]'), 'the attention badge');
    expect(badge.getAttribute('aria-label')).toBe('3 unresolved attention items');
    expect(badge.textContent).toContain('3');
    await screen.unmount();
  });

  test('says "item" for one and caps the glyph at 99+', async () => {
    const sessions = [sessionView('s-1')];
    const one = await render(sessions, { attentionCountFor: () => 1 });
    expect(must(one.container.querySelector('[role="status"]'), 'the badge').getAttribute('aria-label')).toBe(
      '1 unresolved attention item',
    );
    await one.unmount();

    const many = await render(sessions, { attentionCountFor: () => 250 });
    expect(must(many.container.querySelector('[role="status"]'), 'the badge').textContent).toContain('99+');
    await many.unmount();
  });

  test('draws no badge when the session has nothing unresolved', async () => {
    const screen = await render([sessionView('s-1')]);
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
    await screen.unmount();
  });

  test('opens the row menu on a right-click when the connection may act', async () => {
    const opened: string[] = [];
    const onOpenSessionMenu: OpenSessionMenu = view => opened.push(view.config.id);
    const screen = await render([sessionView('s-1')], { onOpenSessionMenu });
    await interact(() =>
      linkOf(screen.container, 's-1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(opened).toEqual(['s-1']);
    await screen.unmount();
  });

  test('leaves the browser’s own menu alone on a read-only connection', async () => {
    const opened: string[] = [];
    const onOpenSessionMenu: OpenSessionMenu = view => opened.push(view.config.id);
    const screen = await render([sessionView('s-1')], { canMutate: false, onOpenSessionMenu });
    await interact(() =>
      linkOf(screen.container, 's-1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(opened).toEqual([]);
    await screen.unmount();
  });

  test('closes the drawer when a row is picked inside it', async () => {
    const closed: string[] = [];
    const screen = await render([sessionView('s-1')], { onNavigate: () => closed.push('closed') });
    await interact(() =>
      linkOf(screen.container, 's-1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });
});

describe('GroupBlock', () => {
  const group = (rows: readonly SessionView[]) => ({ name: 'ferretry', path: '/work/ferretry', rows });

  const render = async (sessions: readonly SessionView[], overrides: Record<string, unknown> = {}) =>
    mount(
      <GroupBlock
        byId={byIdOf(sessions)}
        canMutate
        daemonId={alpha}
        group={group(sessions)}
        lineage={buildLineage(sessions)}
        onFocus={() => undefined}
        {...overrides}
      />,
    );

  test('heads the folder with its name, its count and a way in', async () => {
    const sessions = [sessionView('s-1'), sessionView('s-2')];
    const screen = await render(sessions);
    const heading = must(screen.container.querySelector('h3'), 'the folder heading');
    expect(heading.textContent).toContain('ferretry');
    expect(heading.textContent).toContain('2');
    expect(must(heading.querySelector('button'), 'the focus button').getAttribute('aria-label')).toBe(
      'Focus folder ferretry',
    );
    expect(screen.container.querySelectorAll('li').length).toBe(2);
    await screen.unmount();
  });

  test('focuses the folder and shuts the drawer in one press', async () => {
    const focused: string[] = [];
    const closed: string[] = [];
    const screen = await render([sessionView('s-1')], {
      onFocus: (path: string) => focused.push(path),
      onNavigate: () => closed.push('closed'),
    });
    await interact(() =>
      must(screen.container.querySelector('h3 button'), 'the focus button').dispatchEvent(
        new Event('click', { bubbles: true }),
      ),
    );
    expect(focused).toEqual(['/work/ferretry']);
    expect(closed).toEqual(['closed']);
    await screen.unmount();
  });

  test('marks the scoped folder for a screen reader as well as by accent', async () => {
    const screen = await render([sessionView('s-1')], { scoped: true });
    const heading = must(screen.container.querySelector('h3'), 'the folder heading');
    expect(heading.getAttribute('aria-current')).toBe('true');
    expect(must(heading.querySelector('button'), 'the focus button').className).toContain('text-accent');
    await screen.unmount();
  });

  test('takes the 44px touch floor in a coarse-pointer context', async () => {
    const screen = await render([sessionView('s-1')], { coarse: true });
    expect(must(screen.container.querySelector('h3 button'), 'the focus button').className).toContain('min-h-[44px]');
    await screen.unmount();
  });

  test('marks the active row inside the group', async () => {
    const sessions = [sessionView('s-1'), sessionView('s-2')];
    const screen = await render(sessions, { activeId: 's-2' });
    expect(linkOf(screen.container, 's-2').getAttribute('aria-current')).toBe('page');
    expect(linkOf(screen.container, 's-1').getAttribute('aria-current')).toBeNull();
    await screen.unmount();
  });
});

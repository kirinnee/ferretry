import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { RowMenuAction } from '../../src/shell/agent-sidebar-model.ts';
import type { ContextMenuItem } from '../../src/shell/context-menu.tsx';
import {
  SessionRowMenu,
  sessionMenuLabel,
  sessionRowMenuItems,
  type SessionRowMenuState,
} from '../../src/shell/session-row-menu.tsx';
import type { StopScope } from '../../src/shell/stop-actions.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const lead = sessionView('lead-1', { config: { name: 'Fleet Lead', teammate: 'nero', label: 'port-shell' } });
const child = sessionView('child-1', { config: { name: 'Child One', parent: 'lead-1', label: 'port-shell' } });
const loner = sessionView('loner-1', { config: { name: 'Loner', teammate: undefined } });
const fleet = [lead, child, loner];

interface Runs {
  readonly ran: { view: SessionView; action: RowMenuAction }[];
  readonly stops: { selectedId: string; scope: StopScope }[];
}

const collect = (): Runs & {
  readonly onRun: (view: SessionView, action: RowMenuAction) => void;
  readonly onBulkStop: (selectedId: string, scope: StopScope) => void;
} => {
  const ran: { view: SessionView; action: RowMenuAction }[] = [];
  const stops: { selectedId: string; scope: StopScope }[] = [];
  return {
    ran,
    stops,
    onRun: (view, action) => ran.push({ view, action }),
    onBulkStop: (selectedId, scope) => stops.push({ selectedId, scope }),
  };
};

const keys = (view: SessionView, sessions = fleet, canMutate = true): readonly string[] =>
  sessionRowMenuItems(view, sessions, canMutate, collect()).map(item => item.key);

/** The one entry a case is about, named so a missing entry fails as itself. */
const entry = (items: readonly ContextMenuItem[], key: string): ContextMenuItem =>
  must(
    items.find(item => item.key === key),
    `menu entry ${key}`,
  );

describe('sessionMenuLabel', () => {
  it('names the menu after the callsign the fleet uses', () => {
    expect(sessionMenuLabel(lead)).toBe('Actions for Nero');
  });

  it('falls back to the session name so the menu is never anonymous to a screen reader', () => {
    expect(sessionMenuLabel(loner)).toBe('Actions for Loner');
  });
});

describe('sessionRowMenuItems', () => {
  it('replaces the opaque one-session Stop with the four explicit scopes', () => {
    const listed = keys(lead);
    expect(listed).not.toContain('stop');
    expect(listed).toContain('bulk-orphan');
    expect(listed).toContain('bulk-cascade');
    expect(listed).toContain('bulk-children');
    expect(listed).toContain('bulk-label');
  });

  it('omits the label scope for a session that carries none, rather than offering a sweep of nothing', () => {
    expect(keys(loner)).not.toContain('bulk-label');
  });

  it('offers nothing at all on a read-only connection, so no action can be drawn that could only fail', () => {
    expect(keys(lead, fleet, false)).toEqual([]);
  });

  it('keeps the per-session actions the row is entitled to, in order, ahead of the stops', () => {
    const listed = keys(lead);
    expect(listed.slice(0, 3)).toEqual(['interrupt', 'rename', 'migrate']);
  });

  it('offers Resume rather than Interrupt once a session has finished', () => {
    const finished = sessionView('done-1', { state: { status: 'completed' } });
    const listed = keys(finished, [finished]);
    expect(listed).toContain('resume');
    expect(listed).not.toContain('interrupt');
  });

  it('carries each scope’s blast radius as the menu detail, before activation', () => {
    const items = sessionRowMenuItems(lead, fleet, true, collect());
    const cascade = entry(items, 'bulk-cascade');
    const orphan = entry(items, 'bulk-orphan');
    expect(cascade.detail).toBe('2 sessions');
    expect(orphan.detail).toBe('1 session');
  });

  it('disables a scope that would hit nothing instead of hiding it, so the menu does not shift under a finger', () => {
    const items = sessionRowMenuItems(loner, [loner, lead, child], true, collect());
    expect(entry(items, 'bulk-children').disabled).toBe(true);
    expect(entry(items, 'bulk-orphan').disabled).toBe(false);
  });

  it('marks every stop scope destructive, and the two destructive session actions with it', () => {
    const items = sessionRowMenuItems(lead, fleet, true, collect());
    expect(items.filter(item => item.key.startsWith('bulk-')).every(item => item.danger)).toBe(true);
    expect(entry(items, 'migrate').danger).toBe(true);
    expect(entry(items, 'rename').danger).toBeUndefined();
  });

  it('reports a chosen action rather than performing it', () => {
    const runs = collect();
    const items = sessionRowMenuItems(lead, fleet, true, runs);
    entry(items, 'rename').onSelect();
    entry(items, 'migrate').onSelect();
    entry(items, 'interrupt').onSelect();
    expect(runs.ran.map(run => run.action)).toEqual(['rename', 'migrate', 'interrupt']);
    expect(runs.ran.every(run => run.view === lead)).toBe(true);
    expect(runs.stops).toEqual([]);
  });

  it('reports a chosen stop scope against the row that was pressed, never a sweep', () => {
    const runs = collect();
    const items = sessionRowMenuItems(lead, fleet, true, runs);
    entry(items, 'bulk-cascade').onSelect();
    expect(runs.stops).toEqual([{ selectedId: 'lead-1', scope: 'cascade' }]);
    expect(runs.ran).toEqual([]);
  });

  it('reasons only over the fleet it is handed, so one daemon’s sessions cannot enter another’s menu', () => {
    const other = sessionView('other-1', { config: { parent: 'lead-1', label: 'port-shell' } });
    const items = sessionRowMenuItems(lead, [lead, child], true, collect());
    const cascade = entry(items, 'bulk-cascade');
    expect(cascade.detail).toBe('2 sessions');
    const wider = sessionRowMenuItems(lead, [lead, child, other], true, collect());
    expect(entry(wider, 'bulk-cascade').detail).toBe('3 sessions');
  });
});

const state = (view: SessionView): SessionRowMenuState => ({ view, x: 24, y: 48 });

const renderMenu = async (props: { view?: SessionView | null; canMutate?: boolean } = {}) => {
  const runs = collect();
  const mounted = await mount(
    <SessionRowMenu
      state={props.view === null ? null : state(props.view ?? lead)}
      sessions={fleet}
      canMutate={props.canMutate ?? true}
      onClose={() => {}}
      onRun={runs.onRun}
      onBulkStop={runs.onBulkStop}
    />,
  );
  return { ...mounted, runs };
};

const menu = (container: HTMLElement): HTMLElement | null => container.querySelector('[role="menu"]');

describe('SessionRowMenu', () => {
  it('stays shut when no row has asked for it', async () => {
    const view = await renderMenu({ view: null });
    expect(menu(view.container)).toBeNull();
    await view.unmount();
  });

  it('opens for the pressed row and names itself after that session', async () => {
    const view = await renderMenu();
    expect(menu(view.container)?.getAttribute('aria-label')).toBe('Actions for Nero');
    const labels = [...view.container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent ?? '');
    expect(labels.some(label => label.includes('Interrupt turn'))).toBe(true);
    expect(labels.some(label => label.includes('cascade whole tree'))).toBe(true);
    await view.unmount();
  });

  it('never opens an empty menu, because a menu offering nothing reads as a broken row', async () => {
    const view = await renderMenu({ canMutate: false });
    expect(menu(view.container)).toBeNull();
    await view.unmount();
  });

  it('runs the entry that was activated', async () => {
    const view = await renderMenu();
    const item = must(
      [...view.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element =>
        element.textContent?.includes('Rename'),
      ),
      'the Rename entry',
    );
    await interact(() => item.click());
    expect(view.runs.ran.map(run => run.action)).toEqual(['rename']);
    await view.unmount();
  });
});

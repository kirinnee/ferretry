/**
 * Info › Surfaces: terminals and browser pages the ferret owns, who drives each, and Take over / Hand
 * back — the one control Info carries directly.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { BrowserPageSummary, BrowserStatus, TerminalListView, TerminalView } from '@ferretry/protocol';
import { InfoSurfaces, type InfoSurfacesProps } from '../../../../src/features/session-info/info-surfaces.tsx';
import type { AgentControlDriver } from '../../../../src/features/workspace/agent-control-marker.tsx';
import type { SurfaceDriving } from '../../../../src/features/workspace/use-surface-driving.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const terminal = (id: string, overrides: Partial<TerminalView> = {}): TerminalView =>
  ({ id, title: `Shell ${id}`, name: undefined, ...overrides }) as unknown as TerminalView;

const terminals = (list: readonly TerminalView[]): TerminalListView =>
  ({ sessionId: 'session-a', terminals: list, limits: {} }) as unknown as TerminalListView;

const page = (id: string, overrides: Partial<BrowserPageSummary> = {}): BrowserPageSummary =>
  ({ id, url: `https://example.test/${id}`, title: id, ...overrides }) as unknown as BrowserPageSummary;

const browser = (pages: readonly BrowserPageSummary[]): BrowserStatus =>
  ({ sessionId: 'session-a', state: 'running', pages }) as unknown as BrowserStatus;

/** A `SurfaceDriving` test double: scripted answers, with every call recorded. */
const drivingOf = (
  overrides: Partial<{
    readonly driverFor: (tabId: string) => AgentControlDriver | null;
    readonly takenOver: (tabId: string) => boolean;
    readonly failure: string | null;
  }> = {},
): { readonly driving: SurfaceDriving; readonly takenOverCalls: string[]; readonly handBackCalls: string[] } => {
  const takenOverCalls: string[] = [];
  const handBackCalls: string[] = [];
  const driving: SurfaceDriving = {
    drivenTabIds: new Set(),
    driverFor: overrides.driverFor ?? (() => null),
    takenOver: overrides.takenOver ?? (() => false),
    takeOver: tabId => takenOverCalls.push(tabId),
    handBack: tabId => handBackCalls.push(tabId),
    failure: overrides.failure ?? null,
  };
  return { driving, takenOverCalls, handBackCalls };
};

const show = async (overrides: Partial<InfoSurfacesProps> = {}) => {
  const openedTerminals: string[] = [];
  const openedPages: string[] = [];
  mounted = await mount(
    <InfoSurfaces
      agentName="Hadi"
      browser={null}
      driving={drivingOf().driving}
      onOpenPage={summary => openedPages.push(summary.id)}
      onOpenTerminal={(id, _label) => openedTerminals.push(id)}
      terminals={null}
      {...overrides}
    />,
  );
  return { root: mounted.container, openedTerminals, openedPages };
};

describe('InfoSurfaces — empty and loading', () => {
  it('says it is reading while both reads are unread', async () => {
    const { root } = await show({ terminals: null, browser: null });
    expect(root.textContent).toContain('Reading surfaces…');
  });

  it('says there is nothing once both have read empty', async () => {
    const { root } = await show({ terminals: terminals([]), browser: browser([]) });
    expect(root.textContent).toContain('No terminals or browser pages yet.');
  });
});

describe('InfoSurfaces — rows', () => {
  it('names a terminal by its given name, else its title, and a browser page by its label', async () => {
    const { root } = await show({
      terminals: terminals([terminal('t1', { name: 'dev' }), terminal('t2')]),
      browser: browser([page('p1', { name: 'docs' })]),
    });
    const rows = [...root.querySelectorAll('[data-info-surface]')].map(element =>
      element.getAttribute('data-info-surface'),
    );
    expect(rows).toEqual(['terminal:t1', 'terminal:t2', 'browser:p1']);
    expect(root.textContent).toContain('dev');
    expect(root.textContent).toContain('Shell t2');
    expect(root.textContent).toContain('docs');
  });

  it('opens a terminal row and a browser row through the host’s callbacks', async () => {
    const { root, openedTerminals, openedPages } = await show({
      terminals: terminals([terminal('t1', { name: 'dev' })]),
      browser: browser([page('p1')]),
    });
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-info-surface="terminal:t1"] button'), 'terminal row').click(),
    );
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-info-surface="browser:p1"] button'), 'browser row').click(),
    );
    expect(openedTerminals).toEqual(['t1']);
    expect(openedPages).toEqual(['p1']);
  });

  it('shows an incognito chip only on an incognito page', async () => {
    const { root } = await show({ browser: browser([page('p1', { incognito: true }), page('p2')]) });
    expect(must(root.querySelector('[data-info-surface="browser:p1"]'), 'p1').textContent).toContain('incognito');
    expect(must(root.querySelector('[data-info-surface="browser:p2"]'), 'p2').textContent).not.toContain('incognito');
  });
});

describe('InfoSurfaces — driving', () => {
  it('says idle when nobody drives a surface, and offers no control', async () => {
    const { root } = await show({ terminals: terminals([terminal('t1')]) });
    expect(root.textContent).toContain('idle');
    expect(root.querySelector('[data-info-take-over]')).toBeNull();
    expect(root.querySelector('[data-info-hand-back]')).toBeNull();
  });

  it('offers Take over where an agent drives, and calls back with the tab id', async () => {
    const { driving, takenOverCalls } = drivingOf({ driverFor: () => ({ name: 'Hadi' }) });
    const { root } = await show({ terminals: terminals([terminal('t1')]), driving });
    expect(root.textContent).toContain('Hadi drives');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-info-take-over="terminal:t1"]'), 'take over').click(),
    );
    expect(takenOverCalls).toEqual(['terminal:t1']);
  });

  it('offers Hand back once this device holds a surface, and calls back with the tab id', async () => {
    const { driving, handBackCalls } = drivingOf({
      driverFor: () => ({ name: 'Hadi' }),
      takenOver: () => true,
    });
    const { root } = await show({ terminals: terminals([terminal('t1')]), driving });
    expect(root.textContent).toContain('You’re driving');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-info-hand-back="terminal:t1"]'), 'hand back').click(),
    );
    expect(handBackCalls).toEqual(['terminal:t1']);
  });

  it('shows the daemon’s last refusal', async () => {
    const { driving } = drivingOf({ failure: 'Could not take over t1: unreachable' });
    const { root } = await show({ terminals: terminals([terminal('t1')]), driving });
    expect(must(root.querySelector('[role="alert"]'), 'the failure').textContent).toBe(
      'Could not take over t1: unreachable',
    );
  });
});

import { describe, expect, it } from 'bun:test';
import { MACHINE_TABS, type MachineTabId } from '../../../../../src/features/fleet/shell/machine-route.ts';
import {
  type PanelGroupId,
  panelGroup,
  panelsOnTab,
  panelTab,
} from '../../../../../src/features/fleet/shell/machine-panels.ts';

describe('panelTab', () => {
  it.each<[string, MachineTabId]>([
    ['warden', 'agents'],
    ['learning', 'agents'],
    ['accounts', 'sign-ins'],
    ['secrets', 'sign-ins'],
    ['secure-copy', 'sign-ins'],
    ['security-log', 'machine'],
    ['about', 'machine'],
  ])('opens %s from the %s tab', (panel, tab) => {
    expect(panelTab(panel)).toBe(tab);
  });

  it('names no tab for a word that is not a panel', () => {
    expect(panelTab('retired-panel')).toBeUndefined();
  });
});

describe('panelGroup', () => {
  it('returns a group with its tab and panels in the order they are listed', () => {
    const group = panelGroup('site-sign-ins');
    expect(group.tab).toBe('sign-ins');
    expect(group.panels).toEqual(['accounts', 'secrets', 'secure-copy']);
  });

  it('refuses a group id the table does not hold', () => {
    expect(() => panelGroup('nope' as PanelGroupId)).toThrow('Unknown panel group: nope');
  });
});

describe('panelsOnTab', () => {
  it.each<[MachineTabId, number]>([
    ['machine', 15],
    ['agents', 3],
    ['sign-ins', 3],
    ['runtimes', 0],
    ['profiles', 0],
    ['browser', 0],
  ])('lists the panels of the %s tab (%d)', (tab, count) => {
    expect(panelsOnTab(tab)).toHaveLength(count);
  });

  it('lists the panels of a tab in the order its groups draw them', () => {
    expect(panelsOnTab('agents')).toEqual(['warden', 'learning', 'pack']);
    expect(panelsOnTab('sign-ins')).toEqual(['accounts', 'secrets', 'secure-copy']);
  });

  it('puts each panel on exactly one tab, and panelTab agrees', () => {
    const all = MACHINE_TABS.flatMap(tab => panelsOnTab(tab.id).map(panel => ({ panel, tab: tab.id })));
    expect(new Set(all.map(entry => entry.panel)).size).toBe(all.length);
    for (const { panel, tab } of all) expect(panelTab(panel)).toBe(tab);
  });
});

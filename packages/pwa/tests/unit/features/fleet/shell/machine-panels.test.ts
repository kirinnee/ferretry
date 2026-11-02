import { describe, expect, it } from 'bun:test';
import type { MachineTabId } from '../../../../../src/features/fleet/shell/machine-route.ts';
import { type PanelGroupId, panelGroup, panelTab } from '../../../../../src/features/fleet/shell/machine-panels.ts';

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

import { describe, expect, test } from 'bun:test';
import { DEFAULT_LAYOUT } from '@ferretry/plugin-layouts/contract';
import {
  CHAT_TAB,
  newTabChoices,
  nextTab,
  panelKey,
  phoneTabs,
  tabOrChat,
} from '../../../src/shell/ferret-workspace-model.ts';

const OWNER: Readonly<Record<string, string>> = {
  'ferret-agenda': 'agenda',
  queue: 'conversation',
  'cards-of-ferret': 'board',
  terminals: 'terminals',
  console: 'terminals',
  processes: 'terminals',
  browser: 'browsers',
  files: 'ferrets',
  'ferret-warden': 'warden',
  'mcp-servers': 'mcp',
  helpers: 'packs',
  skills: 'skills',
  usage: 'usage',
  insights: 'usage',
};
const placed = (ids: readonly string[]) =>
  ids.map((id, order) => ({ plugin: OWNER[id] ?? 'other', id, slot: 'ferret.side', order }));
const DEFAULT = placed(DEFAULT_LAYOUT.panels['ferret.side'] ?? []);

describe('the phone ferret page’s chips', () => {
  test('Chat first, then v4’s own in v4’s order: Console, Processes, Terminals, Browser, Files', () => {
    const labels = phoneTabs(DEFAULT).map(tab => tab.label);
    expect(labels.slice(0, 6)).toEqual(['Chat', 'Console', 'Processes', 'Terminals', 'Browser', 'Files']);
  });

  test('every panel the default layout places is a chip, once, in the layout’s order after v4’s own', () => {
    const tabs = phoneTabs(DEFAULT);
    expect(tabs).toHaveLength(DEFAULT.length + 1);
    expect(new Set(tabs.map(tab => tab.key)).size).toBe(tabs.length);
    expect(tabs.slice(6).map(tab => tab.label)).toEqual([
      'Agenda',
      'Queue',
      'Cards',
      'Warden',
      'MCP',
      'Helpers',
      'Skills',
      'Usage',
      'Insights',
    ]);
  });

  test('a panel nobody named gets its id, in words, after the rest', () => {
    const tabs = phoneTabs(placed(['my-new-panel', 'files']));
    expect(tabs.map(tab => tab.label)).toEqual(['Chat', 'Files', 'My new panel']);
  });

  test('a layout with no side panels has only Chat', () => {
    expect(phoneTabs([]).map(tab => tab.key)).toEqual([CHAT_TAB]);
  });

  test('a chip is keyed by plugin and id, as PanelSlot marks the panel', () => {
    expect(panelKey({ plugin: 'terminals', id: 'terminals' })).toBe('terminals.terminals');
  });

  test('a chip for a panel the layout no longer places falls back to Chat', () => {
    const tabs = phoneTabs(placed(['files']));
    expect(tabOrChat(tabs, 'ferrets.files')).toBe('ferrets.files');
    expect(tabOrChat(tabs, 'terminals.terminals')).toBe(CHAT_TAB);
  });
});

describe('the "+" menu', () => {
  test('is v4’s: New terminal, New browser, Open file — each naming the panel that owns the act', () => {
    expect(newTabChoices(DEFAULT)).toEqual([
      { id: 'new-terminal', label: 'New terminal', panel: 'terminals.terminals', action: 'new-terminal' },
      { id: 'new-browser', label: 'New browser', panel: 'browsers.browser', action: 'new-page' },
      { id: 'open-file', label: 'Open file', panel: 'ferrets.files' },
    ]);
  });

  test('omits what the layout did not place (a choice a surface does not offer is not listed)', () => {
    expect(newTabChoices(placed(['files', 'console'])).map(choice => choice.id)).toEqual(['open-file']);
    expect(newTabChoices([])).toEqual([]);
  });
});

describe('the chip row’s keys', () => {
  const tabs = phoneTabs(DEFAULT);
  test('arrows move one chip, Home and End jump, and there is no wrap', () => {
    expect(nextTab(tabs, CHAT_TAB, 'ArrowRight')).toBe('terminals.console');
    expect(nextTab(tabs, CHAT_TAB, 'ArrowLeft')).toBeNull();
    expect(nextTab(tabs, 'terminals.console', 'Home')).toBe(CHAT_TAB);
    expect(nextTab(tabs, CHAT_TAB, 'End')).toBe('usage.insights');
    expect(nextTab(tabs, 'usage.insights', 'ArrowRight')).toBeNull();
    expect(nextTab(tabs, CHAT_TAB, 'a')).toBeNull();
    expect(nextTab(tabs, 'nope', 'ArrowRight')).toBeNull();
  });
});

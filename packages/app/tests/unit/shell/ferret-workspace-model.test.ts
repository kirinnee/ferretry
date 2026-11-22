import { describe, expect, test } from 'bun:test';
import { DEFAULT_LAYOUT } from '@ferretry/plugin-layouts/contract';
import {
  addressNamesFile,
  CHAT_TAB,
  newTabChoices,
  nextTab,
  panelKey,
  panelPlaced,
  phoneTabs,
  revealPanel,
  tabOrChat,
} from '../../../src/shell/ferret-workspace-model.ts';
import { ensureDom } from '../../../src/testing/index.ts';

ensureDom();

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
  instructions: 'ferrets',
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
      'Tasks',
      'Warden',
      'MCP',
      'Helpers',
      'Skills',
      'Instructions',
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

describe('asking for another panel of the page (a panel that links to a sibling)', () => {
  test('says whether the layout placed the panel, by its id', () => {
    expect(panelPlaced(DEFAULT, 'insights')).toBe(true);
    expect(panelPlaced(placed(['files']), 'insights')).toBe(false);
    expect(panelPlaced([], 'insights')).toBe(false);
  });

  test('beside the chat it scrolls the side column to the panel, and ignores one nobody placed', () => {
    const column = document.createElement('div');
    column.dataset.slot = 'ferret.side';
    const panel = document.createElement('div');
    panel.dataset.panel = 'usage.insights';
    const scrolled: unknown[] = [];
    panel.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => void scrolled.push(options);
    column.append(panel);
    document.body.append(column);
    try {
      revealPanel(DEFAULT, 'insights');
      expect(scrolled).toEqual([{ block: 'nearest' }]);
      revealPanel(placed(['files']), 'insights');
      revealPanel(DEFAULT, 'files');
      expect(scrolled).toHaveLength(1);
    } finally {
      column.remove();
    }
  });

  test('a browser without scrollIntoView still answers', () => {
    const column = document.createElement('div');
    column.dataset.slot = 'ferret.side';
    const panel = document.createElement('div');
    panel.dataset.panel = 'usage.insights';
    (panel as { scrollIntoView?: unknown }).scrollIntoView = undefined;
    column.append(panel);
    document.body.append(column);
    try {
      expect(() => revealPanel(DEFAULT, 'insights')).not.toThrow();
    } finally {
      column.remove();
    }
  });
});

describe('addressNamesFile', () => {
  test('is true only for an address carrying a non-empty ?file=', () => {
    expect(addressNamesFile('?file=src%2Fentry-ts')).toBe(true);
    expect(addressNamesFile('?find=a&file=a.ts')).toBe(true);
    for (const search of ['', '?file=', '?find=entry', '?files=a.ts']) expect(addressNamesFile(search)).toBe(false);
  });
});

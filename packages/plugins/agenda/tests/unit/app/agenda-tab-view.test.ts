import { describe, expect, test } from 'bun:test';
import type { AgendaItem } from '../../../app/wire/index.ts';
import { readTab, writeTab } from '../../../app/lib/agenda-fold.ts';
import {
  changedTabs,
  nextTab,
  openTab,
  sectionTab,
  tabsChangedSince,
  viewTabs,
} from '../../../app/lib/agenda-tab-view.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

/** THE TABS AS THE VIEW DRAWS THEM (&F923): which are drawn, which is open, which changed, the phone's words. */

const item = (overrides: Record<string, unknown>): AgendaItem =>
  agendaItem('A5', overrides as unknown as Partial<AgendaItem>);

const own = [
  { id: 'decisions', name: 'Decisions', body: 'SQLite.' },
  { id: 'risks', name: 'Risks', body: 'Slip.' },
];

describe('the tabs the view draws', () => {
  test('are the protocol’s, without the full picture when the ask draws it', () => {
    const it = item({ whereWeAre: 'Now.', body: 'Report.', tabs: own });
    expect(viewTabs(it, false).map(tab => tab.id)).toEqual(['main', 'body', 'decisions', 'risks']);
    expect(viewTabs(it, true).map(tab => tab.id)).toEqual(['main', 'decisions', 'risks']);
  });

  test('open on the remembered tab while it exists, else the first, else none', () => {
    const tabs = viewTabs(item({ whereWeAre: 'Now.', tabs: own }), false);
    expect(openTab(tabs, 'risks')).toBe('risks');
    expect(openTab(tabs, 'gone')).toBe('main');
    expect(openTab(tabs, null)).toBe('main');
    expect(openTab([], null)).toBe('');
  });

  test('name the next tab, and none after the last or for a tab not there', () => {
    const tabs = viewTabs(item({ whereWeAre: 'Now.', tabs: own }), false);
    expect(nextTab(tabs, 'main')?.id).toBe('decisions');
    expect(nextTab(tabs, 'risks')).toBeUndefined();
    expect(nextTab(tabs, 'gone')).toBeUndefined();
  });
});

describe('the tabs the last edit changed', () => {
  test('are none on an item never edited', () => {
    expect([...changedTabs(item({ tabs: own }))]).toEqual([]);
  });

  test('mark the main tab for any of its parts, the full picture for the body, and each own tab by id', () => {
    const edited = item({
      tabs: [
        { id: 'decisions', name: 'Decisions', body: 'SQLite.' },
        { id: 'risks', name: 'Open risks', body: 'Slip.' },
        { id: 'notes', name: 'Notes', body: 'New.' },
      ],
      revisions: [
        {
          at: '2026-08-01T11:00:00.000Z',
          by: 'agent',
          changed: ['decided', 'body', 'tabs'],
          previous: { tabs: own },
        },
      ],
    });
    expect([...changedTabs(edited)].sort()).toEqual(['body', 'main', 'notes', 'risks']);
    const bare = item({
      tabs: own,
      revisions: [{ at: '2026-08-01T11:00:00.000Z', by: 'agent', changed: ['tabs'], previous: {} }],
    });
    expect([...changedTabs(bare)].sort()).toEqual(['decisions', 'risks']);
  });
});

describe('the remembered tab', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { kept: Map<string, string> } => {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: key => kept.get(key) ?? null,
      setItem: (key, value) => {
        kept.set(key, value);
      },
      removeItem: key => {
        kept.delete(key);
      },
    };
  };
  const refusing = {
    getItem: (): never => {
      throw new Error('blocked');
    },
    setItem: (): never => {
      throw new Error('blocked');
    },
    removeItem: (): never => {
      throw new Error('blocked');
    },
  };

  test('is kept per item, forgotten on the main tab, and read as none when storage refuses', () => {
    const store = memory();
    writeTab('m/s/A5', 'risks', false, store);
    expect(readTab('m/s/A5', store)).toBe('risks');
    expect(readTab('m/s/A6', store)).toBeNull();
    writeTab('m/s/A5', 'main', true, store);
    expect(store.kept.size).toBe(0);
    expect(readTab('m/s/A5', refusing)).toBeNull();
    writeTab('m/s/A5', 'risks', false, refusing);
    expect(readTab('m/s/A5', null)).toBeNull();
  });
});

describe('the tabs changed since this device last looked', () => {
  test('compare the version seen with now: the main tab for any of its parts, the body, and own tabs by id', () => {
    const seen = item({ whereWeAre: 'Now.', decided: 'A.', body: 'Report.', tabs: own });
    expect([...tabsChangedSince(seen, seen)]).toEqual([]);
    const now = item({
      whereWeAre: 'Now.',
      decided: 'A and B.',
      body: 'Report, longer.',
      tabs: [
        { id: 'decisions', name: 'Decisions', body: 'SQLite.' },
        { id: 'risks', name: 'Open risks', body: 'Slip.' },
        { id: 'notes', name: 'Notes', body: 'New.' },
      ],
    });
    expect([...tabsChangedSince(seen, now)].sort()).toEqual(['body', 'main', 'notes', 'risks']);
  });
});

describe('the tab a section of Changes opens', () => {
  const tabs = viewTabs(item({ whereWeAre: 'Now.', body: 'Report.', tabs: own }), false);
  test('is the main tab for its parts, the full picture for the body, and an own tab by its key', () => {
    expect(sectionTab('decided', tabs)?.id).toBe('main');
    expect(sectionTab('whereWeAre', tabs)?.id).toBe('main');
    expect(sectionTab('body', tabs)?.id).toBe('body');
    expect(sectionTab('tab:risks', tabs)?.name).toBe('Risks');
  });

  test('is none for any other section, a tab not drawn, or the order of the tabs', () => {
    expect(sectionTab('premise', tabs)).toBeUndefined();
    expect(sectionTab('tabOrder', tabs)).toBeUndefined();
    expect(sectionTab('tab:gone', tabs)).toBeUndefined();
    expect(sectionTab('body', viewTabs(item({ whereWeAre: 'Now.', body: 'Report.' }), true))).toBeUndefined();
  });
});

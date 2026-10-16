import { describe, expect, it } from 'bun:test';
import { Copy } from 'lucide-react';
import {
  findSessionAction,
  focusableEntries,
  SESSION_ACTION_GROUP_LABEL,
  SESSION_ACTION_GROUPS,
  type SessionActionContribution,
  type SessionActionEntry,
  sessionActionSections,
} from '../../../../src/features/session-actions/registry.ts';

interface Ctx {
  readonly flag: boolean;
}

const run = (id: string, overrides: Partial<SessionActionEntry> = {}): SessionActionEntry =>
  ({ kind: 'run', id, label: id, icon: Copy, run: () => undefined, ...overrides }) as SessionActionEntry;

const contribution = (
  group: SessionActionContribution<Ctx>['group'],
  order: number,
  entry: SessionActionEntry | null | ((context: Ctx) => SessionActionEntry | null),
): SessionActionContribution<Ctx> => ({
  group,
  order,
  build: typeof entry === 'function' ? entry : () => entry,
});

const build = (contributions: readonly SessionActionContribution<Ctx>[], flag = true) =>
  sessionActionSections(contributions, { flag });

describe('SESSION_ACTION_GROUPS / SESSION_ACTION_GROUP_LABEL', () => {
  it('names every group drawn, in the order the menu draws them', () => {
    expect(SESSION_ACTION_GROUPS).toEqual(['session', 'move', 'tools', 'learning', 'warden', 'danger']);
    expect(SESSION_ACTION_GROUPS.every(group => typeof SESSION_ACTION_GROUP_LABEL[group] === 'string')).toBe(true);
  });
});

describe('sessionActionSections', () => {
  it('drops a contribution whose build answers null — hidden, not dimmed', () => {
    const sections = build([contribution('session', 10, null), contribution('session', 20, run('a'))]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries.map(entry => entry.id)).toEqual(['a']);
  });

  it('keeps an entry marked unavailable, rather than dropping it like a null', () => {
    const sections = build([contribution('move', 10, run('later', { unavailable: 'later' }))]);
    expect(sections[0]?.entries[0]?.unavailable).toBe('later');
  });

  it('orders entries within a group by order, then by contribution index on a tie', () => {
    const sections = build([
      contribution('session', 20, run('b')),
      contribution('session', 10, run('a')),
      contribution('session', 10, run('tied-second')),
    ]);
    expect(sections[0]?.entries.map(entry => entry.id)).toEqual(['a', 'tied-second', 'b']);
  });

  it('draws the groups in SESSION_ACTION_GROUPS order, regardless of contribution order', () => {
    const sections = build([contribution('danger', 10, run('stop')), contribution('session', 10, run('rename'))]);
    expect(sections.map(section => section.group)).toEqual(['session', 'danger']);
  });

  it('leaves an empty group out entirely, never drawing a heading over nothing', () => {
    const sections = build([contribution('session', 10, run('a'))]);
    expect(sections.map(section => section.group)).toEqual(['session']);
    expect(sections.every(section => section.entries.length > 0)).toBe(true);
  });

  it('carries each section its label from SESSION_ACTION_GROUP_LABEL', () => {
    const sections = build([contribution('tools', 10, run('a'))]);
    expect(sections[0]?.label).toBe('Tools');
  });

  it('keeps the first of two contributions sharing one id, dropping the duplicate', () => {
    const sections = build([
      contribution('session', 10, run('dup', { label: 'first' })),
      contribution('session', 20, run('dup', { label: 'second' })),
    ]);
    const matches = sections.flatMap(section => section.entries).filter(entry => entry.id === 'dup');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe('first');
  });

  it('builds each entry from the context it is handed', () => {
    const sections = build([contribution('session', 10, context => (context.flag ? run('on') : null))], false);
    expect(sections).toEqual([]);
  });
});

describe('findSessionAction', () => {
  it('finds the entry by id wherever it sits across sections', () => {
    const sections = build([contribution('session', 10, run('rename')), contribution('danger', 10, run('stop'))]);
    expect(findSessionAction(sections, 'stop')?.id).toBe('stop');
    expect(findSessionAction(sections, 'rename')?.id).toBe('rename');
  });

  it('answers undefined for an id that is not drawn', () => {
    const sections = build([contribution('session', 10, run('rename'))]);
    expect(findSessionAction(sections, 'missing')).toBeUndefined();
  });
});

describe('focusableEntries', () => {
  it('lists every entry across sections in drawn order, dropping unavailable ones', () => {
    const sections = build([
      contribution('session', 10, run('rename')),
      contribution('move', 10, run('machine', { unavailable: 'later' })),
      contribution('danger', 10, run('stop')),
    ]);
    expect(focusableEntries(sections).map(entry => entry.id)).toEqual(['rename', 'stop']);
  });

  it('answers an empty list when every entry is unavailable', () => {
    const sections = build([contribution('move', 10, run('machine', { unavailable: 'later' }))]);
    expect(focusableEntries(sections)).toEqual([]);
  });
});

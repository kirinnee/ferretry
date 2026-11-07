import { describe, expect, it } from 'bun:test';
import { Copy } from 'lucide-react';
import {
  findFerretAction,
  FERRET_ACTION_GROUP_LABEL,
  FERRET_ACTION_GROUPS,
  type FerretActionContribution,
  type FerretActionEntry,
  ferretActionSections,
} from '../../../../app/features/header/registry.ts';

interface Ctx {
  readonly flag: boolean;
}

const run = (id: string, overrides: Partial<FerretActionEntry> = {}): FerretActionEntry =>
  ({ kind: 'run', id, label: id, icon: Copy, run: () => undefined, ...overrides }) as FerretActionEntry;

const contribution = (
  group: FerretActionContribution<Ctx>['group'],
  order: number,
  entry: FerretActionEntry | null | ((context: Ctx) => FerretActionEntry | null),
): FerretActionContribution<Ctx> => ({
  group,
  order,
  build: typeof entry === 'function' ? entry : () => entry,
});

const build = (contributions: readonly FerretActionContribution<Ctx>[], flag = true) =>
  ferretActionSections(contributions, { flag });

describe('FERRET_ACTION_GROUPS / FERRET_ACTION_GROUP_LABEL', () => {
  it('names every group drawn, in the order the menu draws them', () => {
    expect(FERRET_ACTION_GROUPS).toEqual(['ferret', 'move', 'danger']);
    expect(FERRET_ACTION_GROUPS.every(group => typeof FERRET_ACTION_GROUP_LABEL[group] === 'string')).toBe(true);
  });
});

describe('ferretActionSections', () => {
  it('drops a contribution whose build answers null — hidden, not dimmed', () => {
    const sections = build([contribution('ferret', 10, null), contribution('ferret', 20, run('a'))]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries.map(entry => entry.id)).toEqual(['a']);
  });

  it('keeps an entry marked unavailable, rather than dropping it like a null', () => {
    const sections = build([contribution('move', 10, run('later', { unavailable: 'later' }))]);
    expect(sections[0]?.entries[0]?.unavailable).toBe('later');
  });

  it('orders entries within a group by order, then by contribution index on a tie', () => {
    const sections = build([
      contribution('ferret', 20, run('b')),
      contribution('ferret', 10, run('a')),
      contribution('ferret', 10, run('tied-second')),
    ]);
    expect(sections[0]?.entries.map(entry => entry.id)).toEqual(['a', 'tied-second', 'b']);
  });

  it('draws the groups in FERRET_ACTION_GROUPS order, regardless of contribution order', () => {
    const sections = build([contribution('danger', 10, run('stop')), contribution('ferret', 10, run('rename'))]);
    expect(sections.map(section => section.group)).toEqual(['ferret', 'danger']);
  });

  it('leaves an empty group out entirely, never drawing a heading over nothing', () => {
    const sections = build([contribution('ferret', 10, run('a'))]);
    expect(sections.map(section => section.group)).toEqual(['ferret']);
    expect(sections.every(section => section.entries.length > 0)).toBe(true);
  });

  it('carries each section its label from FERRET_ACTION_GROUP_LABEL', () => {
    const sections = build([contribution('danger', 10, run('a'))]);
    expect(sections[0]?.label).toBe('Danger');
  });

  it('keeps the first of two contributions sharing one id, dropping the duplicate', () => {
    const sections = build([
      contribution('ferret', 10, run('dup', { label: 'first' })),
      contribution('ferret', 20, run('dup', { label: 'second' })),
    ]);
    const matches = sections.flatMap(section => section.entries).filter(entry => entry.id === 'dup');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe('first');
  });

  it('builds each entry from the context it is handed', () => {
    const sections = build([contribution('ferret', 10, context => (context.flag ? run('on') : null))], false);
    expect(sections).toEqual([]);
  });
});

describe('findFerretAction', () => {
  it('finds the entry by id wherever it sits across sections', () => {
    const sections = build([contribution('ferret', 10, run('rename')), contribution('danger', 10, run('stop'))]);
    expect(findFerretAction(sections, 'stop')?.id).toBe('stop');
    expect(findFerretAction(sections, 'rename')?.id).toBe('rename');
  });

  it('answers undefined for an id that is not drawn', () => {
    const sections = build([contribution('ferret', 10, run('rename'))]);
    expect(findFerretAction(sections, 'missing')).toBeUndefined();
  });
});

import { describe, expect, it } from 'bun:test';
import {
  type FerretView,
  ferretViews,
  type ListedFerret,
  parseFerretList,
  rootViews,
} from '../../../app/lib/ferret-view.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const view = (id: string, parent?: string): FerretView => ({
  config: { id, ...(parent === undefined ? {} : { parent }) },
  state: { status: 'idle' },
});

describe('rootViews', () => {
  it('maps each ferret to the top of its lineage, and a ferret with no parent in the list to itself', () => {
    const roots = rootViews([view('c', 'b'), view('b', 'a'), view('a'), view('orphan', 'missing')]);
    expect(roots.get('c')?.config.id).toBe('a');
    expect(roots.get('b')?.config.id).toBe('a');
    expect(roots.get('a')?.config.id).toBe('a');
    expect(roots.get('orphan')?.config.id).toBe('orphan');
  });

  it('stops at a loop in the lineage instead of walking it for ever', () => {
    const roots = rootViews([view('x', 'y'), view('y', 'x')]);
    expect(roots.get('x')?.config.id).toBe('y');
    expect(roots.get('y')?.config.id).toBe('x');
  });
});

describe('parseFerretList', () => {
  it('reads a bare array or a { ferrets } answer, and nothing from any other shape', () => {
    expect(parseFerretList({ nothing: true })).toEqual([]);
    expect(parseFerretList(null)).toEqual([]);
    expect(parseFerretList({ ferrets: [{ id: 'f1' }] })).toEqual([{ id: 'f1' }]);
    expect(parseFerretList([{ id: 'f1' }])).toEqual([{ id: 'f1' }]);
  });

  it('drops a row with no id or that is not an object, and keeps only the fields it understands', () => {
    const rows = parseFerretList([
      'nope',
      null,
      { title: 'no id' },
      { id: '' },
      {
        id: 'f1',
        title: 'Fix it',
        name: 'zoe',
        label: 'L',
        parent: 'p',
        projectId: 'proj',
        card: 'C1',
        folder: '/work',
        state: 'working',
        stateAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        mode: 'auto',
        extra: 'ignored',
        label2: 7,
      },
      { id: 'f2', mode: 'weird', title: 4 },
    ]);
    expect(rows).toEqual([
      {
        id: 'f1',
        name: 'Fix it',
        teammate: 'zoe',
        label: 'L',
        parent: 'p',
        projectId: 'proj',
        card: 'C1',
        folder: '/work',
        state: 'working',
        stateAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        mode: 'auto',
      },
      { id: 'f2' },
    ]);
  });
});

describe('ferretViews', () => {
  const full: ListedFerret = {
    id: 'f1',
    name: 'Fix it',
    teammate: 'zoe',
    label: 'L',
    parent: 'p',
    projectId: 'proj',
    card: 'C1',
    mode: 'interactive',
    folder: '/work',
    state: 'working',
    stateAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  it('carries every listed field onto the view, and the state the list names', () => {
    const [only] = ferretViews([full], new Map());
    expect(only?.config).toEqual({
      id: 'f1',
      name: 'Fix it',
      teammate: 'zoe',
      label: 'L',
      parent: 'p',
      projectId: 'proj',
      focusTask: { id: 'C1' },
      mode: 'interactive',
      cwd: '/work',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(only?.state).toEqual({ id: 'f1', status: 'working', lastActivityAt: '2026-08-01T00:00:00.000Z' });
  });

  it('reads an unknown or missing state as idle', () => {
    const [unknown, missing] = ferretViews([{ id: 'a', state: 'bogus' }, { id: 'b' }], new Map());
    expect(unknown?.state.status).toBe('idle');
    expect(missing?.state.status).toBe('idle');
  });

  it('summarises the open items: count, the first to answer, the latest wait, and discussions', () => {
    const items = [
      agendaItem('A1', {
        subject: 'Oldest',
        waitingSince: '2026-08-01T10:00:00.000Z',
        waitingOn: 'ferret',
        waitingFor: 'discussion',
      }),
      agendaItem('A2', { subject: 'Second', waitingSince: '2026-08-01T12:00:00.000Z' }),
      agendaItem('A3', { subject: 'Third', waitingSince: '2026-08-01T11:00:00.000Z' }),
      agendaItem('N1', { notice: true }),
      agendaItem('P1', { parked: { reason: 'replied', at: '2026-08-01T09:00:00.000Z' } }),
    ];
    const [one] = ferretViews([{ id: 'f1', state: 'working' }], new Map([['f1', items]]));
    expect(one?.state.agenda).toEqual({
      open: 3,
      first: 'A2',
      ask: 'Second',
      latestAt: '2026-08-01T12:00:00.000Z',
      discussing: 1,
    });
  });

  it('falls back to the oldest open item when every one is a discussion', () => {
    const items = [agendaItem('A1', { subject: 'Talk', waitingOn: 'ferret', waitingFor: 'discussion' })];
    const [one] = ferretViews([{ id: 'f1', state: 'working' }], new Map([['f1', items]]));
    expect(one?.state.agenda).toMatchObject({ open: 1, first: 'A1', ask: 'Talk', discussing: 1 });
  });

  it('says an idle ferret with an item on the owner is stopped on them', () => {
    const items = [agendaItem('A1')];
    const [idle, working] = ferretViews(
      [
        { id: 'f1', state: 'idle' },
        { id: 'f2', state: 'working' },
      ],
      new Map([
        ['f1', items],
        ['f2', items],
      ]),
    );
    expect(idle?.state.agenda?.stopped).toBe(true);
    expect(working?.state.agenda?.stopped).toBeUndefined();
  });

  it('has no summary for a ferret whose only items are notices, parked or none', () => {
    const [none] = ferretViews([{ id: 'f1' }], new Map([['f1', [agendaItem('N1', { notice: true })]]]));
    expect(none?.state.agenda).toBeUndefined();
  });

  it('still lists, by id, a ferret the roll-up names that the list does not', () => {
    const views = ferretViews(
      [{ id: 'f1' }],
      new Map([
        ['f1', []],
        ['ghost', [agendaItem('A1')]],
        ['empty', []],
      ]),
    );
    expect(views.map(each => each.config.id)).toEqual(['f1', 'ghost']);
    expect(views[1]?.state.agenda?.open).toBe(1);
  });
});

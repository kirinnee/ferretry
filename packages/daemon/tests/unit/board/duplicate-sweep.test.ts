import { describe, it } from 'bun:test';
import { type AgendaGate, type AgendaItem, gateReference } from '@ferretry/protocol';
import should from 'should';
import { DuplicateSweep } from '../../../src/lib/board/duplicate-sweep.ts';

const gate: AgendaGate = {
  cardId: 'F1',
  laneId: 'tested',
  laneName: 'Try it',
  entry: 1,
  projectId: 'p1',
  options: [{ id: 'o0', label: 'Done', outcome: 'close' }],
};

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    waitingSince: '2026-10-01T10:00:00.000Z',
    raisedBy: 'agent',
    ...extra,
  }) as AgendaItem;

interface World {
  readonly open: Record<string, AgendaItem[]>;
  readonly resolved?: Record<string, Record<string, unknown>[]>;
  readonly unreadable?: readonly string[];
  readonly resolveFails?: boolean;
  readonly resolveThrows?: boolean;
  readonly listAllThrows?: boolean;
  readonly homeThrows?: boolean;
}

const build = (world: World) => {
  const closed: [string, string, string | undefined][] = [];
  const warnings: string[] = [];
  const sweep = new DuplicateSweep({
    agenda: {
      list: async (sessionId: string) => {
        if (world.unreadable?.includes(sessionId)) throw new Error('unreadable');
        return { ok: true, value: { items: world.open[sessionId] ?? [], resolved: world.resolved?.[sessionId] ?? [] } };
      },
      resolve: async (sessionId: string, id: string, _actor: unknown, note?: string) => {
        if (world.resolveThrows) throw new Error('boom');
        closed.push([sessionId, id, note]);
        return { ok: !world.resolveFails };
      },
    } as never,
    sessions: {
      all: async () => {
        if (world.listAllThrows) throw new Error('no sessions');
        return Object.keys(world.open);
      },
    },
    homes: {
      of: async (id: string) => {
        if (world.homeThrows) throw new Error('no home');
        return id === 'kid' ? 'lead' : id;
      },
    },
    diagnostics: { warn: message => void warnings.push(message) },
  });
  return { sweep, closed, warnings };
};

const TWINS = {
  lead: [item('A1', { task: { id: 'F1' } })],
  kid: [item('A2', { task: { id: 'F1' }, waitingSince: '2026-10-01T11:00:00.000Z' })],
};

describe('DuplicateSweep', () => {
  it('closes the newer twin with a note that names the kept ask', async () => {
    const { sweep, closed } = build({ open: TWINS });
    should(await sweep.run()).equal(1);
    should(closed).deepEqual([['kid', 'A2', 'duplicate of !A1']]);
    should(sweep.possible()).deepEqual([]);
  });

  it('counts only closures the agenda accepted, and survives a resolve that throws', async () => {
    should(await build({ open: TWINS, resolveFails: true }).sweep.run()).equal(0);
    should(await build({ open: TWINS, resolveThrows: true }).sweep.run()).equal(0);
  });

  it('closes nothing when an agenda cannot be read, and reports what it would have closed', async () => {
    const reading = build({ open: { ...TWINS, stranger: [] }, unreadable: ['stranger'] });
    should(await reading.sweep.run()).equal(0);
    should(reading.closed).deepEqual([]);
    should(reading.warnings.length).equal(1);
    should(reading.sweep.possible()).deepEqual([
      {
        kind: 'card',
        members: [
          { sessionId: 'lead', id: 'A1' },
          { sessionId: 'kid', id: 'A2' },
        ],
        why: 'not closed: an agenda could not be read',
      },
    ]);
  });

  it('never closes a gate the owner answered, however the answer was kept', async () => {
    const open = {
      lead: [item('A1', { task: { id: 'F1' }, gate, raisedBy: 'daemon', waitingOn: 'ferret' })],
      kid: [item('A2', { task: { id: 'F1' }, waitingSince: '2026-10-01T11:00:00.000Z' })],
    };
    const answered = [{ at: '2026-10-01T12:00:00.000Z', kind: 'gate-answered', note: gateReference(gate) }];
    const worlds: World[] = [
      {
        open,
        resolved: { kid: [{ resolvedBy: 'human', gate }, { resolvedBy: 'ferret', gate }, { resolvedBy: 'human' }] },
      },
      { open, resolved: { kid: [{ history: answered }] } },
      { open: { ...open, other: [item('A9', { history: answered })] } },
    ];
    for (const world of worlds) {
      const { sweep, closed } = build(world);
      should(await sweep.run()).equal(0);
      should(closed).deepEqual([]);
      should(sweep.possible().map(each => each.why)).deepEqual(['not closed: a gate the owner answered']);
    }
  });

  it('falls back to the session itself when its home cannot be read: two lineages, nothing closed', async () => {
    const { sweep, closed } = build({ open: TWINS, homeThrows: true });
    should(await sweep.run()).equal(0);
    should(closed).deepEqual([]);
  });

  it('never rejects: a failure is a warning and zero closed', async () => {
    const { sweep, warnings } = build({ open: TWINS, listAllThrows: true });
    should(await sweep.run()).equal(0);
    should(warnings[0]).containEql('no sessions');
    const strange = new DuplicateSweep({
      agenda: {} as never,
      sessions: {
        all: async () => {
          throw 'plain';
        },
      },
      homes: { of: async id => id },
      diagnostics: { warn: message => void warnings.push(message) },
    });
    should(await strange.run()).equal(0);
    should(warnings[1]).containEql('plain');
  });

  it('runs one at a time: a second call waits for the first', async () => {
    const { sweep, closed } = build({ open: TWINS });
    const [first, second] = await Promise.all([sweep.run(), sweep.run()]);
    should(first).equal(second);
    should(closed.length).equal(1);
  });
});

import { describe, it } from 'bun:test';
import should from 'should';
import type { MachineAgendaPort, MachineMembersStore, MachineRaise } from '../../../src/lib/agenda/index.ts';
import { AUTO_MOVE_FAILED_REF, AutoMoveFailures } from '../../../src/lib/warden/auto-move-failures.ts';
import { ORPHANS_REF, OrphanList } from '../../../src/lib/warden/orphan-list.ts';
import type { WardenCardNotice } from '../../../src/lib/warden/orphans.ts';

class Members implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    return this.value;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    this.value = { ...members };
  }
}

function machine() {
  const raised: { ref: string; request: MachineRaise; members: readonly string[] | undefined }[] = [];
  const resolved: string[] = [];
  const port: MachineAgendaPort = {
    raiseOrUpdate: async (ref, request, members) => void raised.push({ ref, request, members }),
    resolve: async ref => void resolved.push(ref),
    list: async () => ({ items: [], resolved: [], count: 0 }) as never,
  };
  return { raised, resolved, port };
}

describe('the auto-move failures item', () => {
  const live = new Map<string, string>([
    ['a', 'claude-1'],
    ['b', 'claude-1'],
  ]);
  const facts = { current: async (id: string) => (live.has(id) ? { agent: live.get(id)! } : undefined) };

  it('should list every ferret that could not be moved in one item', async () => {
    const { port, raised } = machine();
    const failures = new AutoMoveFailures(new Members(), port, facts);
    await failures.note('a', 'Not moved: no login could take it.');
    await failures.note('b', 'Not moved: cap.');
    const last = raised.at(-1)!;
    should(last.ref).equal(AUTO_MOVE_FAILED_REF);
    should(last.members).eql(['a', 'b']);
    should(last.request.title).equal('2 ferrets could not be moved');
    should(last.request.context).containEql('a (a): Not moved: no login could take it.');
  });

  it('should keep every ferret when notes and reconciles run at the same time', async () => {
    // Arrange
    const { port, raised } = machine();
    const store = new Members();
    const slow = {
      read: async () => {
        const held = await store.read();
        await new Promise(resolve => setTimeout(resolve, 5));
        return held;
      },
      write: async (members: Readonly<Record<string, readonly string[]>>) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.write(members);
      },
    };
    const failures = new AutoMoveFailures(slow, port, facts);

    // Act
    await Promise.all([failures.note('a', 'x'), failures.reconcile(), failures.note('b', 'y'), failures.reconcile()]);

    // Assert
    should(Object.keys(store.value).sort()).eql(['a', 'b']);
    should(raised.at(-1)?.members).eql(['a', 'b']);
  });

  it('should raise quietly when told to, as the boot folding does', async () => {
    // Arrange
    const { port, raised } = machine();
    const failures = new AutoMoveFailures(new Members(), port, facts);

    // Act
    await failures.note('a', 'x', true);
    await failures.note('b', 'y');

    // Assert
    should(raised[0]?.request.ping).be.undefined();
    should(raised[1]?.request.ping).be.true();
  });

  it('should name a single ferret in the title', async () => {
    const { port, raised } = machine();
    await new AutoMoveFailures(new Members(), port, facts).note('a', 'x');
    should(raised[0]?.request.title).equal('a could not be moved');
  });

  it('should never list a stopped or gone ferret', async () => {
    const { port, raised, resolved } = machine();
    await new AutoMoveFailures(new Members(), port, facts).note('stopped', 'x');
    should(raised).be.empty();
    should(resolved).be.empty();
  });

  it('should drop a ferret that stopped or moved, and close the item when none is left', async () => {
    const { port, raised, resolved } = machine();
    const agents = new Map(live);
    const failures = new AutoMoveFailures(new Members(), port, {
      current: async id => (agents.has(id) ? { agent: agents.get(id)! } : undefined),
    });
    await failures.note('a', 'x');
    await failures.note('b', 'y');
    agents.delete('a');
    await failures.reconcile();
    should(raised.at(-1)?.members).eql(['b']);
    agents.set('b', 'codex-1');
    await failures.reconcile();
    should(resolved).eql([AUTO_MOVE_FAILED_REF]);
  });

  it('should list a dozen and say how many more', async () => {
    const { port, raised } = machine();
    const many = new Map(Array.from({ length: 15 }, (_, index) => [`s${String(index).padStart(2, '0')}`, 'c']));
    const failures = new AutoMoveFailures(new Members(), port, {
      current: async id => (many.has(id) ? { agent: 'c' } : undefined),
    });
    for (const id of many.keys()) await failures.note(id, 'x');
    should(raised.at(-1)?.request.context).containEql('…and 3 more.');
  });
});

const notice = (id: string, title: string): WardenCardNotice => ({
  sourceRef: `warden-orphan:${id}`,
  task: { id } as never,
  title,
  subject: `${title} subject`,
  why: 'w',
  premise: 'p',
  context: 'c',
  howToResolve: 'h',
  waitingSince: id === 'F1' ? '2026-07-01T00:00:00Z' : '2026-07-02T00:00:00Z',
});

describe('the orphaned cards item', () => {
  it('should list the cards in one item, oldest wait first, and name a single card', async () => {
    const { port, raised } = machine();
    const list = new OrphanList(new Members(), port);
    await list.add(notice('F1', '&F1 has nobody on it'));
    should(raised[0]).containDeep({ ref: ORPHANS_REF, members: ['F1'], request: { title: '&F1 has nobody on it' } });
    await list.add(notice('F2', '&F2 has nobody on it'));
    should(raised[1]?.request.title).equal('2 cards have nobody on them');
    should(raised[1]?.request.waitingSince).equal('2026-07-01T00:00:00Z');
  });

  it('should keep every card when adds and removes run at the same time, and raise quietly when told to', async () => {
    // Arrange
    const { port, raised } = machine();
    const store = new Members();
    const slow = {
      read: async () => {
        const held = await store.read();
        await new Promise(resolve => setTimeout(resolve, 5));
        return held;
      },
      write: async (members: Readonly<Record<string, readonly string[]>>) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.write(members);
      },
    };
    const list = new OrphanList(slow, port);

    // Act
    await Promise.all([list.add(notice('F1', 'a'), true), list.add(notice('F2', 'b')), list.remove('F9')]);

    // Assert
    should(Object.keys(store.value).sort()).eql(['F1', 'F2']);
    should(raised[0]?.request.ping).be.undefined();
    should(raised[1]?.request.ping).be.true();
  });

  it('should close the item when the last card leaves, and ignore a card it never held', async () => {
    const { port, resolved, raised } = machine();
    const list = new OrphanList(new Members(), port);
    await list.remove('F9');
    should(raised).be.empty();
    await list.add(notice('F1', 'a'));
    await list.remove('F1');
    should(resolved).eql([ORPHANS_REF]);
  });

  it('should say how many more than a dozen', async () => {
    const { port, raised } = machine();
    const list = new OrphanList(new Members(), port);
    for (let index = 0; index < 14; index += 1)
      await list.add(notice(`F${String(index + 10)}`, `card ${String(index)}`));
    should(raised.at(-1)?.request.context).containEql('…and 2 more.');
  });
});

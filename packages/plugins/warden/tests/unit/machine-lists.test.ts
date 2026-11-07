import { describe, it } from 'bun:test';
import should from 'should';
import type { MachineAgendaPort, MachineMembersStore, MachineRaise } from '../../daemon/lib/machine-notices.ts';
import { AUTO_MOVE_FAILED_REF, AutoMoveFailures } from '../../daemon/lib/auto-move-failures.ts';
import { INBOX_STUCK_REF, StuckInboxList } from '../../daemon/lib/inbox-stuck-list.ts';
import { INPUT_STUCK_REF, StuckInputList } from '../../daemon/lib/input-stuck-list.ts';
import { ORPHANS_REF, OrphanList } from '../../daemon/lib/orphan-list.ts';
import type { WardenCardNotice } from '../../daemon/lib/orphans.ts';

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
  };
  return { raised, resolved, port };
}

describe('the auto-move failures item', () => {
  const live = new Map<string, string>([
    ['a', 'claude-1'],
    ['b', 'claude-1'],
  ]);
  const facts = {
    current: async (id: string) => (live.has(id) ? { agent: live.get(id)! } : undefined),
    candidate: async () => undefined,
  };

  it('should list every ferret that could not be moved in one item', async () => {
    const { port, raised } = machine();
    const failures = new AutoMoveFailures(new Members(), port, facts);
    await failures.note('a', 'Not moved: no login could take it.');
    await failures.note('b', 'Not moved: cap.');
    const last = raised.at(-1)!;
    should(last.ref).equal(AUTO_MOVE_FAILED_REF);
    should(last.members).eql(['a', 'b']);
    should(last.request.title).equal('2 ferrets could not be moved');
    should(last.request.context).containEql('a (a): No login could take it. Wait for a login to reset.');
    should(last.request.context).not.containEql('$ fy move');
    should(last.request.why).containEql("These 2 couldn't be moved.");
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

  it('should give a runnable command when a login can take the ferret', async () => {
    const { port, raised } = machine();
    const failures = new AutoMoveFailures(new Members(), port, {
      ...facts,
      candidate: async id => (id === 'a' ? 'codex-2' : undefined),
    });
    await failures.note('a', 'Not moved although its login hit its limit: a background job runs');
    const request = raised.at(-1)!.request;
    should(request.context).equal('a (a): A background job runs. A login can take it now:\n$ fy move a -a codex-2');
    should(request.why).containEql("This one couldn't be moved.");
  });

  it('should say to wait for the turn, with no command, when the ferret is mid-turn', async () => {
    const { port, raised } = machine();
    const failures = new AutoMoveFailures(new Members(), port, {
      current: async () => ({ agent: 'c', name: 'piper', midTurn: true }),
      candidate: async () => 'codex-2',
    });
    await failures.note('p', '');
    should(raised.at(-1)?.request.context).equal('piper (p): It could not be moved. Wait for it to finish its turn.');
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
      candidate: async () => undefined,
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
      candidate: async () => undefined,
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
    await list.add(notice('F1', 'A card has nobody working on it'));
    should(raised[0]).containDeep({
      ref: ORPHANS_REF,
      members: ['F1'],
      request: {
        title: 'A card has nobody working on it',
        cards: [{ task: { id: 'F1' }, line: 'A card has nobody working on it subject' }],
      },
    });
    should(raised[0]?.request.premise).containEql('this card');
    should(raised[0]?.request.why).containEql('This one was handed');
    await list.add(notice('F2', 'A card has nobody working on it'));
    should(raised[1]?.request.premise).containEql('these cards');
    should(raised[1]?.request.title).equal('2 cards have nobody working on them');
    should(raised[1]?.request.cards?.map(row => row.task.id)).eql(['F1', 'F2']);
    should(raised[1]?.request.why).not.containEql('nothing under it is alive');
    should(raised[1]?.request.howToResolve).containEql('Got it');
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

describe('the stuck-input item (B144)', () => {
  const stuck = (sessionId: string, since: string) => ({
    sessionId,
    title: sessionId,
    line: `${sessionId}: send s-1 stuck since ${since} — Enter was pressed and did not take`,
    since,
  });

  it('should list every stuck ferret in one item that pings, oldest wait first, and name a single one', async () => {
    const { port, raised } = machine();
    const list = new StuckInputList(new Members(), port);

    await list.add(stuck('annabeth', '2026-11-02T15:00:00Z'));
    should(raised[0]).containDeep({
      ref: INPUT_STUCK_REF,
      members: ['annabeth'],
      request: { title: 'annabeth is stuck on an unsent message', notice: true, ping: true },
    });
    await list.add(stuck('braelynn', '2026-11-02T05:40:00Z'));
    should(raised[1]?.request.title).equal('2 ferrets are stuck on unsent messages');
    should(raised[1]?.request.waitingSince).equal('2026-11-02T05:40:00Z');
    should(raised[1]?.request.context).match(/- annabeth: send s-1/);
  });

  it('should close the item when the last ferret leaves, and ignore one it never held', async () => {
    const { port, resolved, raised } = machine();
    const list = new StuckInputList(new Members(), port);
    await list.remove('nobody');
    should(raised).be.empty();
    await list.add(stuck('annabeth', '2026-11-02T15:00:00Z'));
    await list.remove('annabeth');
    should(resolved).eql([INPUT_STUCK_REF]);
  });
});

describe('the stuck-inbox item (B148)', () => {
  const stuck = (sessionId: string, since: string) => ({
    sessionId,
    title: sessionId,
    line: `${sessionId}: 3 messages waiting, oldest 30m past due — the safe re-check did not move it`,
    since,
  });

  it('should list every stuck inbox in one item that pings, oldest wait first, and name a single one', async () => {
    const { port, raised } = machine();
    const list = new StuckInboxList(new Members(), port);

    await list.add(stuck('ryu', '2026-11-02T08:12:00Z'));
    should(raised[0]).containDeep({
      ref: INBOX_STUCK_REF,
      members: ['ryu'],
      request: {
        title: 'ryu’s inbox is stuck',
        subject: 'ryu: 3 messages waiting, oldest 30m past due — the safe re-check did not move it',
        notice: true,
        ping: true,
      },
    });
    await list.add(stuck('elta', '2026-11-03T15:49:00Z'));
    should(raised[1]?.request.title).equal('2 ferrets have stuck inboxes');
    should(raised[1]?.request.waitingSince).equal('2026-11-02T08:12:00Z');
    should(raised[1]?.request.context).match(/- elta: 3 messages waiting[\s\S]*- ryu: 3 messages waiting/);
  });

  it('should list twelve and count the rest', async () => {
    const { port, raised } = machine();
    const list = new StuckInboxList(new Members(), port);

    for (let index = 10; index < 24; index += 1) await list.add(stuck(`f${index}`, `2026-11-02T08:${index}:00Z`));
    should(raised.at(-1)?.request.title).equal('14 ferrets have stuck inboxes');
    should(raised.at(-1)?.request.context).match(/…and 2 more\.$/);
    should(raised.at(-1)?.members).have.length(14);
  });

  it('should close the item when the last inbox drains, and ignore one it never held', async () => {
    const { port, resolved, raised } = machine();
    const list = new StuckInboxList(new Members(), port);
    await list.remove('nobody');
    should(raised).be.empty();
    await list.add(stuck('ryu', '2026-11-02T08:12:00Z'));
    await list.remove('ryu');
    should(resolved).eql([INBOX_STUCK_REF]);
  });
});

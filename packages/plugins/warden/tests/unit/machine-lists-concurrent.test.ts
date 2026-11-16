import { describe, it } from 'bun:test';
import should from 'should';
import { AutoMoveFailures } from '../../daemon/lib/auto-move-failures.ts';
import type { MachineAgendaPort, MachineMembersStore, MachineRaise } from '../../daemon/lib/machine-notices.ts';

class SlowMembers implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    const held = this.value;
    await new Promise(resolve => setTimeout(resolve, 5));
    return held;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.value = { ...members };
  }
}

/** One notice per cause, replaced on every raise, as the Asks binding keeps it. */
class NoticeBoard implements MachineAgendaPort {
  readonly items = new Map<
    string,
    { readonly request: MachineRaise; readonly members: readonly string[] | undefined }
  >();
  async raiseOrUpdate(ref: string, request: MachineRaise, members?: readonly string[]): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.items.set(ref, { request, members });
  }
  async resolve(ref: string): Promise<void> {
    this.items.delete(ref);
  }
}

describe('the auto-move failures through a notice board', () => {
  it('should list both ferrets when two are noted at the same time', async () => {
    // Arrange
    const machine = new NoticeBoard();
    const facts = {
      current: async (id: string) => ({ agent: 'claude-1', name: `ferret-${id}` }),
      candidate: async () => undefined,
    };
    const failures = new AutoMoveFailures(new SlowMembers(), machine, facts, () => '2026-11-06T09:00:00.000Z');

    // Act
    await Promise.all([failures.note('a', 'Not moved: cap.'), failures.note('b', 'Not moved: busy.')]);

    // Assert
    const items = [...machine.items.values()];
    should(items).have.length(1);
    should(items[0]?.request.subject).equal('a, b');
    should(items[0]?.request.context).containEql('ferret-a (a): Cap. Wait for a login to reset.');
    should(items[0]?.request.context).containEql('ferret-b (b): Busy. Wait for a login to reset.');
  });
});

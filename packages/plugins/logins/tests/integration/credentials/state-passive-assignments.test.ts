import { describe, it } from 'bun:test';
import type { StateRead } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import should from 'should';
import { StatePassiveAssignments } from '../../../daemon/adapters/credentials/state-passive-assignments.ts';

/** The one declared file, in memory: enough of the kernel's state port for the record to be read and written. */
function memoryState(options: { readonly failRead?: boolean; readonly failWrite?: boolean } = {}) {
  let held: unknown;
  return {
    read: async () => {
      if (options.failRead === true) throw new Error('unreadable');
      return ok(held) as StateRead<never>;
    },
    update: async (_file: unknown, fn: (current: unknown) => unknown) => {
      if (options.failWrite === true) return err('refused');
      held = fn(held);
      return ok(held);
    },
    get held() {
      return held;
    },
  };
}

describe('the passive login assignments, held in state', () => {
  it('should keep what it is given in the one declared document, and read it back', async () => {
    // Arrange
    const state = memoryState();
    const store = new StatePassiveAssignments(state as never);
    should(await store.read()).deepEqual({});

    // Act
    await store.write({ f: { login: 'a', since: 5 } });

    // Assert
    should(state.held).deepEqual({ format: 1, ferrets: { f: { login: 'a', since: 5 } } });
    should(await store.read()).deepEqual({ f: { login: 'a', since: 5 } });
  });

  it('should read an unreadable document as none held, and say so when a write was refused', async () => {
    // Arrange / Act / Assert
    should(await new StatePassiveAssignments(memoryState({ failRead: true }) as never).read()).deepEqual({});
    await new StatePassiveAssignments(memoryState({ failWrite: true }) as never)
      .write({ f: { login: 'a', since: 5 } })
      .should.be.rejected();
  });
});

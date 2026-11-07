import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigPort } from '@ferretry/kernel/contract';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';
import type { ConfigEdit, DoorResult } from '../../daemon/lib/config-door.ts';
import type { WardenConfig, WardenConfigPatch } from '../../daemon/lib/index.ts';

/** A config port that carries the kernel's write door, answering each write when the test says so. */
function portWithDoor(): {
  readonly port: ConfigPort;
  readonly answer: (index: number, result: DoorResult) => void;
} {
  const pending: ((result: DoorResult) => void)[] = [];
  const door = {
    file: () => undefined,
    collection: () => new Map(),
    watch: () => () => undefined,
    write: async (_def: unknown, _name: unknown, _edit: ConfigEdit): Promise<DoorResult> =>
      await new Promise<DoorResult>(resolve => {
        pending.push(resolve);
      }),
    remove: async (): Promise<DoorResult> => ({ kind: 'applied' }),
  };
  return { port: door, answer: (index, result) => pending[index]?.(result) };
}

const anyConfig = {} as WardenConfig;

describe('warden.yaml changes in flight', () => {
  it('should answer two overlapping changes each with its own held sentences', async () => {
    // Arrange
    const { port, answer } = portWithDoor();
    const store = new ConfigWardenConfigStore(port);

    // Act: the loosening is written first and answered last; the plain change finishes in between
    const loosening = store.write(anyConfig, { caps: { llmDaily: 50 } } as WardenConfigPatch);
    const plain = store.write(anyConfig, { enabled: false } as WardenConfigPatch);
    await Promise.resolve();
    answer(1, { kind: 'applied' });
    const plainHeld = await plain;
    answer(0, { kind: 'held', sentences: ['a bigger daily cap waits for you'] });
    const looseningHeld = await loosening;

    // Assert
    should(plainHeld).eql([]);
    should(looseningHeld).eql(['a bigger daily cap waits for you']);
  });

  it('should answer a change the door held after a later one was put into effect', async () => {
    // Arrange
    const { port, answer } = portWithDoor();
    const store = new ConfigWardenConfigStore(port);

    // Act: the held change finishes FIRST, then a plain one; the first caller still reads its own answer
    const loosening = store.write(anyConfig, { caps: { llmDaily: 50 } } as WardenConfigPatch);
    await Promise.resolve();
    answer(0, { kind: 'held', sentences: ['a bigger daily cap waits for you'] });
    const plain = store.write(anyConfig, { enabled: false } as WardenConfigPatch);
    await Promise.resolve();
    answer(1, { kind: 'applied' });

    // Assert
    should(await loosening).eql(['a bigger daily cap waits for you']);
    should(await plain).eql([]);
  });
});

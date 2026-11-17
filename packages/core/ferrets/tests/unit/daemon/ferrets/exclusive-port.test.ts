import { describe, expect, test } from 'bun:test';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { KeyedSerialExecutor } from '../../../../daemon/lib/ferrets/serial.ts';
import { additivesFixture } from './additives-fixture.ts';

/** `FerretsApi.exclusive`: the ferret's one mutation queue, lent to the Mailbox alone. */

function rig() {
  const base = additivesFixture();
  const serial = new KeyedSerialExecutor();
  const service = new FerretsService(base.registry, base.tokens, { ...base.ports, serial });
  return { ...base, serial, service };
}

describe('FerretsApi.exclusive', () => {
  test('should run the Mailbox work on the same queue a start, stop and resume run on', async () => {
    // Arrange
    const f = rig();
    const order: string[] = [];
    let release = (): void => undefined;
    const holder = f.serial.run(f.id, async () => {
      order.push('held');
      await new Promise<void>(resolve => (release = resolve));
      order.push('released');
    });

    // Act
    const mine = ferretsPort(f.service, 'mailbox').exclusive?.(f.id, async () => order.push('mailbox'));
    await new Promise(resolve => setTimeout(resolve, 10));
    const before = [...order];
    release();
    await holder;
    await mine;

    // Assert
    expect(before).toEqual(['held']);
    expect(order).toEqual(['held', 'released', 'mailbox']);
  });

  test('should refuse any other consumer', async () => {
    // Arrange
    const f = rig();

    // Act
    const refused = ferretsPort(f.service, 'conversation').exclusive?.(f.id, async () => 1);

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 403 });
  });
});

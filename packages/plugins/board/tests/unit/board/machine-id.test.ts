import { describe, expect, test } from 'bun:test';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { machineIdOf } from '../../../daemon/wiring.ts';
import { as, boot, makeCard, TEST_IDENTITY } from '../../integration/daemon/harness.ts';

/** D2 #13: a card's machine is the daemon's id from the kernel's identity port — never a made-up `'local'`. */
describe('D2 #13 the machine a card is made on', () => {
  test('is the daemon id the kernel identity port gives, stored on the card', async () => {
    const { host } = await boot();
    const made = await makeCard(host);

    const stored = JSON.parse(host.state('board').files.get(`cards/${made.id}.json`) ?? '{}') as { machineId?: string };
    expect(stored.machineId).toBe(TEST_IDENTITY.daemonId);
    const read = await host.request('GET', `/v1/board/cards/${made.id}`, { headers: as('owner') });
    expect(read.json<{ card: { machineId: string } }>().card.machineId).toBe(TEST_IDENTITY.daemonId);
  });

  test('is nothing at all where the kernel has no identity port yet: no stand-in id is ever read', () => {
    expect(machineIdOf({} as KernelPorts)).toBeUndefined();
    expect(machineIdOf({ identity: { daemonId: '' } } as unknown as KernelPorts)).toBeUndefined();
    expect(machineIdOf({ identity: TEST_IDENTITY } as unknown as KernelPorts)).toBe(TEST_IDENTITY.daemonId);
  });
});

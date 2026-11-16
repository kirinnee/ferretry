import { describe, expect, test } from 'bun:test';
import type { FerretHarness, FerretId } from '@ferretry/core-ferrets/contract';
import { DeliveryWays } from '../../../contract/index.ts';
import { PANE_WAY, paneWay, paneWayContributions } from '../../../daemon/ways/pane-way.ts';
import { waysDoctor } from '../../../daemon/ways/registry.ts';

const ferret = 'f1' as FerretId;
const lead = 'lead' as FerretId;

describe('the pane delivery way', () => {
  test('opens the ferret harness seam for the ferret and the caller it was asked for', async () => {
    const seam = {} as FerretHarness;
    const asked: unknown[] = [];
    const way = paneWay({
      harness: async (id, caller) => {
        asked.push([id, caller]);
        return seam;
      },
    });
    expect(await way.open(ferret, lead)).toBe(seam);
    expect(asked).toEqual([[ferret, lead]]);
  });

  test('lets the access refusal through, and answers no ferret when Ferrets binds no harness seam', async () => {
    const refusing = paneWay({
      harness: async () => {
        throw new Error('forbidden');
      },
    });
    await expect(refusing.open(ferret, lead)).rejects.toThrow('forbidden');
    expect(await paneWay({}).open(ferret)).toBeUndefined();
  });

  test('is contributed to mailbox.delivery-way under the id `pane`', () => {
    expect(DeliveryWays.name).toBe('mailbox.delivery-way');
    expect(DeliveryWays.mode).toBe('contribute');
    const [contribution, ...rest] = paneWayContributions({});
    expect(rest).toEqual([]);
    expect(contribution?.id).toBe(PANE_WAY);
    expect(DeliveryWays.item?.safeParse(contribution?.item).success).toBe(true);
    expect(DeliveryWays.item?.safeParse({}).success).toBe(false);
  });

  test('doctor names the registered ways, and fails when there is none', () => {
    expect(waysDoctor(() => paneWayContributions({}))).toEqual({ state: 'ok', detail: 'delivery ways: pane' });
    expect(waysDoctor(() => []).state).toBe('fail');
  });
});

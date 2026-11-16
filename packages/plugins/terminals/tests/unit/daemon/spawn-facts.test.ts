import { describe, expect, it } from 'bun:test';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { spawnFactsOf } from '../../../daemon/spawn-facts.ts';
import { resolveFleetExemption } from '../../../daemon/lib/cgroups/exemption.ts';

/**
 * ci-lane-s-review F3 (row 57): the default spawn facts carry the ferret's LABEL, which is what the cgroup exemption
 * reads (a label that trims to the Warden's exempts it from the caps), not its callsign.
 */
const ferrets = (known: Readonly<Record<string, { name: string; label?: string; parent?: string }>>) =>
  ({ get: async (id: string) => (known[id] === undefined ? undefined : { id, ...known[id] }) }) as unknown as Pick<
    FerretsApi,
    'get'
  >;

describe('the default spawn facts of a ferret', () => {
  it('F3 should carry the ferret’s label and parent, and not its callsign as the label', async () => {
    const facts = await spawnFactsOf(ferrets({ f1: { name: 'zelda', label: 'fleet-warden', parent: 'f0' } })).facts(
      'f1',
    );

    expect(facts).toEqual({ label: 'fleet-warden', parent: 'f0' });
  });

  it('F3 should leave the label out for a ferret that was started without one', async () => {
    const facts = await spawnFactsOf(ferrets({ f1: { name: 'zelda' } })).facts('f1');

    expect(facts).toEqual({});
  });

  it('should answer nothing for a ferret the registry does not know', async () => {
    expect(await spawnFactsOf(ferrets({})).facts('gone')).toBeUndefined();
  });

  it('F3 should exempt the ferret labelled as the Warden, and govern one that is only CALLED fleet-warden', async () => {
    const port = spawnFactsOf(
      ferrets({ labelled: { name: 'zelda', label: ' fleet-warden ' }, called: { name: 'fleet-warden' } }),
    );

    expect(await resolveFleetExemption('labelled', port)).toBe('exempt');
    expect(await resolveFleetExemption('called', port)).toBe('governed');
  });
});

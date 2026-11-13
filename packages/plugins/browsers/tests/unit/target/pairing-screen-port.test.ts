import { describe, expect, test } from 'bun:test';
import { workerInputFields } from '../../../daemon/target/lib/worker-port.ts';

/** The daemon believes the worker's word on a pairing code only in the shape it was given; anything else is "marked". */
const documentOf = async (answer: unknown) => await workerInputFields(async () => answer).inputDocument('p1');

describe('the daemon’s reading of the worker’s answer about a page’s pairing code', () => {
  test('it takes a plain unmarked answer with its sighting count', async () => {
    expect(await documentOf({ document: { navigationId: 'n1', pairingSeen: 2 } })).toEqual({
      navigationId: 'n1',
      pairingSeen: 2,
    });
  });

  test('it takes a marked answer', async () => {
    expect(await documentOf({ document: { navigationId: 'n1', pairingScreen: true, pairingSeen: 1 } })).toEqual({
      navigationId: 'n1',
      pairingScreen: true,
      pairingSeen: 1,
    });
  });

  test('it reads an answer that says nothing of a pairing code as MARKED (an older or broken worker is not a no)', async () => {
    expect(await documentOf({ document: { navigationId: 'n1' } })).toEqual({
      navigationId: 'n1',
      pairingScreen: true,
      pairingSeen: -1,
    });
  });

  test('it reads a sighting count it cannot believe as MARKED', async () => {
    for (const pairingSeen of ['2', 1.5, null, Number.NaN])
      expect(await documentOf({ document: { navigationId: 'n1', pairingSeen } })).toMatchObject({
        pairingScreen: true,
        pairingSeen: -1,
      });
  });
});

import { describe, expect, it } from 'bun:test';
import type { GrantRefusal } from '../../../contract/index.ts';
import { fleetRefusalExplanation } from '../../../app/lib/shell-ports.ts';

describe('the sentence a refusal of the fleet capability reads as', () => {
  const cases: readonly (readonly [GrantRefusal, RegExp])[] = [
    ['granted', /^The operator allows this\.$/u],
    ['not-granted', /switched off the agent fleet for paired devices/u],
    [
      'device-not-granted',
      /this device has not been given it\. Widen this device at the machine with `fy device grant/u,
    ],
    ['step-up-required', /needs your passkey\. Confirm on this device/u],
    ['undetermined', /could not read its own grant document, so it is refusing everything/u],
  ];

  for (const [refusal, expected] of cases) {
    it(`words ${refusal} in its own sentence`, () => {
      expect(fleetRefusalExplanation(refusal)).toMatch(expected);
    });
  }

  it('gives every refusal a different sentence', () => {
    const sentences = cases.map(([refusal]) => fleetRefusalExplanation(refusal));
    expect(new Set(sentences).size).toBe(cases.length);
  });
});

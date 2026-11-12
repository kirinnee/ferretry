import { expect, test } from 'bun:test';
import { LAUNCH_ROOTS_KEY, LaunchRoots } from '../../contract/index.ts';
import manifest from '../../manifest.ts';

test('R-0332 launch.roots is offered by Ferrets and names Projects as its one taker (it is on the security path)', () => {
  expect(manifest.hooks.offers.map(offer => offer.hook.name)).toContain('launch.roots');
  expect(LaunchRoots.mode).toBe('provide');
  expect(LaunchRoots.takers).toEqual(['projects']);
  expect(LaunchRoots.key.safeParse(LAUNCH_ROOTS_KEY).success).toBe(true);
  expect(LaunchRoots.key.safeParse('anything-else').success).toBe(false);
});

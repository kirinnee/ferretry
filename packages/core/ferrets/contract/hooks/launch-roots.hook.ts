import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** The project folders a governed device may start a ferret in without terminal access (absolute paths). */
export interface LaunchRootsSource {
  roots(): Promise<readonly string[]>;
}

/** The one key `launch.roots` is provided under. */
export const LAUNCH_ROOTS_KEY = 'projects';

/**
 * Which folders count as known projects. On the security path: what it lists decides whether a governed device's start
 * is an ordinary act or terminal access (`terminal.use`), so ONE named plugin provides it. With no provider the list is
 * empty and every governed start asks for `terminal.use` (narrower, never wider); a throw is a 503.
 */
export const LaunchRoots = defineHook('launch.roots', {
  mode: 'provide',
  key: z.literal(LAUNCH_ROOTS_KEY),
  value: z.custom<LaunchRootsSource>(),
  takers: ['projects'],
});

import type { IFleetClock } from '../../lib/fleet/ports.ts';

/** The wall clock a plan's `generatedAt` is stamped from. */
export class SystemFleetClock implements IFleetClock {
  now(): string {
    return new Date().toISOString();
  }
}

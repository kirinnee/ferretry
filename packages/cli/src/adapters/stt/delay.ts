import { setTimeout as sleep } from 'node:timers/promises';
import type { IDelay } from '../../lib/stt/controller.ts';

/** The real clock: waiting between install polls actually takes the wall-clock time it says. */
export class TimerDelay implements IDelay {
  async wait(milliseconds: number): Promise<void> {
    await sleep(milliseconds);
  }
}

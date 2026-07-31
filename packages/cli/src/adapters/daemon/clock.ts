import type { IClockPort } from '../../lib/daemon/ports.ts';

/** Real time, so the readiness and shutdown waits can be driven by a fake in tests. */
export class SystemMillisecondClock implements IClockPort {
  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number): Promise<void> {
    await Bun.sleep(milliseconds);
  }
}

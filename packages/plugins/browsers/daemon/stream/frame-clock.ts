import type { FrameClock, FrameTimer } from '../../../lib/index.ts';

/** The real timer wheel behind the frame governor and the viewer stream's recovery poll. */
export class SystemFrameClock implements FrameClock {
  now(): number {
    return Date.now();
  }

  schedule(callback: () => void, delayMs: number): FrameTimer {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(timer),
    };
  }
}

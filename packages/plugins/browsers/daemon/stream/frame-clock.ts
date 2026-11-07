import type { Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { FrameClock, FrameTimer } from './contracts.ts';

/** The kernel's clock behind the frame governor and the viewer stream's recovery poll (today's `SystemFrameClock`). */
export class KernelFrameClock implements FrameClock {
  constructor(private readonly clock: Clock) {}

  now(): number {
    return this.clock.nowMs();
  }

  schedule(callback: () => void, delayMs: number): FrameTimer {
    return { cancel: this.clock.after(milliseconds(delayMs), callback) };
  }
}

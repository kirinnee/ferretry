import type { ClockPort } from '../../lib/index.ts';

export class SystemClock implements ClockPort {
  constructor(private readonly currentDate: () => Date = () => new Date()) {}

  now(): string {
    return this.currentDate().toISOString();
  }
}

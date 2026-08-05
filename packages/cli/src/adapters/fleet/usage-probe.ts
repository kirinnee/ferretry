/** The wall clock the usage collector stamps a snapshot with. */
export class SystemUsageClock {
  now(): number {
    return Date.now();
  }
}

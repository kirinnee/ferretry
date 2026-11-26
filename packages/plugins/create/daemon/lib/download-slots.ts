/**
 * A place in line to bring one large file down (a made video clip). Downloads were moved out of the shared serial queue so
 * a two-minute fetch no longer holds up the other creative tools; this is the bound that move took away. At most
 * `concurrent` run at once and at most `waiting` more wait for a place; anyone past that is turned away at once (the ferret
 * is told to ask again, which costs nothing). A task holds its place until it has finished with the bytes, so the number of
 * clips held in memory is never more than `concurrent`.
 */
export interface DownloadSlots {
  /** Runs `task` when a place is free, or answers `busy` without running it when the line is full. */
  readonly run: <T>(
    task: () => Promise<T>,
  ) => Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false }>;
}

export function downloadSlots(concurrent: number, waiting: number): DownloadSlots {
  let active = 0;
  const line: (() => void)[] = [];
  return {
    run: async task => {
      if (active >= concurrent) {
        if (line.length >= waiting) return { ran: false };
        await new Promise<void>(resolve => line.push(resolve));
      } else active += 1;
      try {
        return { ran: true, value: await task() };
      } finally {
        // Hand the place straight to the next in line, or give it up.
        const next = line.shift();
        if (next === undefined) active -= 1;
        else next();
      }
    },
  };
}

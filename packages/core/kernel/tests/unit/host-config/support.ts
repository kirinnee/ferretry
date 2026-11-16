import { z } from 'zod';
import { type Clock, defineConfig, type Log } from '../../../contract/index.ts';
import { configEtagger } from '../../../host/config/etag.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';

export const HOME = '/home/fy';

/**
 * The key of every etag a test service makes when the test compares one with another it computed (or one service with
 * another: a restart, the two doors of one write): a fixed key, so two services agree as one daemon's restarts do.
 */
export const TEST_ETAG_KEY = new Uint8Array(32).fill(7);
/** The etag of a text under {@link TEST_ETAG_KEY}: what a service given that key reads the text at. */
export const testEtag = configEtagger(TEST_ETAG_KEY);

/** Raising `limit` above what is in effect (10 when nothing is) loosens; lowering never does. */
export const updatesDef = defineConfig({
  file: 'updates.yaml',
  schema: z.strictObject({
    limit: z.number().int().default(10),
    note: z.string().optional(),
    apiKey: z.string().optional(),
  }),
  axis: 'configure',
  loosens: (before, after) =>
    after.limit > (before?.limit ?? 10) ? [`raises the limit from ${before?.limit ?? 10} to ${after.limit}`] : [],
});

export const loginsDef = defineConfig({
  collection: 'logins',
  name: /^[a-z0-9-]{1,40}$/,
  schema: z.strictObject({ model: z.string().default('x'), budget: z.number().optional() }),
  axis: 'configure',
  loosens: (before, after) =>
    (after.budget ?? Number.POSITIVE_INFINITY) > (before?.budget ?? Number.POSITIVE_INFINITY)
      ? ['raises or removes the budget']
      : [],
});

export interface ManualClock extends Pick<Clock, 'nowMs' | 'after' | 'every'> {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock a test advances by hand: timers fire in order as time passes. */
export function manualClock(start = 1_000_000): ManualClock {
  let now = start;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    nowMs: () => now,
    after: (delay, fn) => {
      const id = next++;
      timers.set(id, { at: now + delay, fn });
      return () => void timers.delete(id);
    },
    every: (interval, fn) => {
      const id = next++;
      timers.set(id, { at: now + interval, fn, every: interval });
      return () => void timers.delete(id);
    },
    advance: ms => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).toSorted(([, a], [, b]) => a.at - b.at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        now = Math.max(now, timer.at);
        if (timer.every === undefined) timers.delete(id);
        else timers.set(id, { ...timer, at: timer.at + timer.every });
        timer.fn();
      }
      now = target;
    },
    set: ms => {
      now = ms;
    },
  };
}

export function captureLog(): Log & { readonly lines: string[] } {
  const lines: string[] = [];
  const log: Log & { readonly lines: string[] } = {
    lines,
    debug: m => void lines.push(`debug ${m}`),
    info: m => void lines.push(`info ${m}`),
    warn: m => void lines.push(`warn ${m}`),
    error: m => void lines.push(`error ${m}`),
    child: () => log,
  };
  return log;
}

export function configHarness(fs = createMemoryHostFs()) {
  const clock = manualClock();
  const log = captureLog();
  const make = () =>
    createConfigFiles({
      home: HOME,
      fs,
      clock,
      log,
      binary: 'fy',
      etagKey: TEST_ETAG_KEY,
      defs: [
        { plugin: 'updates', def: updatesDef },
        { plugin: 'logins', def: loginsDef },
      ],
    });
  return { fs, clock, log, files: make(), restart: make, path: (relative: string) => `${HOME}/config/${relative}` };
}

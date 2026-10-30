import type { Page } from 'playwright-core';

type Bucket = { count: number; ms: number; worst: number };

const buckets = new Map<string, Bucket>();
const lastLap = new WeakMap<Page, number>();
const laps: { label: string; ms: number }[] = [];
let mark = performance.now();

/** Run `work`, charging its wall clock to `label` whether it returns or throws. */
export const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const ms = performance.now() - started;
    const bucket = buckets.get(label) ?? { count: 0, ms: 0, worst: 0 };
    bucket.count += 1;
    bucket.ms += ms;
    bucket.worst = Math.max(bucket.worst, ms);
    buckets.set(label, bucket);
  }
};

const PAGE_METHODS = ['goto', 'reload', 'screenshot', 'waitForTimeout', 'setViewportSize', 'emulateMedia'] as const;

/** Charge every call to the page methods that cost wall clock to a `page.<method>` bucket. */
export const timePage = (page: Page): void => {
  for (const method of PAGE_METHODS) {
    const original = page[method].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      timed(`page.${method}`, () => original(...args));
  }
};

/** Charge the time since this page's previous lap (or since the call that made the page) to `label`, so the log can name the slowest steps. */
export const lapPage = (page: Page, label: string): void => {
  const now = performance.now();
  const before = lastLap.get(page);
  lastLap.set(page, now);
  if (before !== undefined) laps.push({ label, ms: now - before });
};

/** The stage's wall clock, then one line per bucket, slowest first, so the log says where the walk's time went. */
export const reportWalkTiming = (stage: string): void => {
  const now = performance.now();
  process.stdout.write(`⏱ stage ${stage}: ${((now - mark) / 1_000).toFixed(1)}s\n`);
  mark = now;
  const rows = [...buckets.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [label, bucket] of rows)
    process.stdout.write(
      `⏱   ${label.padEnd(28)} ${(bucket.ms / 1_000).toFixed(1).padStart(6)}s over ${String(bucket.count).padStart(4)} calls, worst ${(bucket.worst / 1_000).toFixed(2)}s\n`,
    );
  buckets.clear();
  for (const lap of laps.sort((a, b) => b.ms - a.ms).slice(0, 25))
    process.stdout.write(`⏱ step ${(lap.ms / 1_000).toFixed(2).padStart(6)}s  ${lap.label}\n`);
  laps.length = 0;
};

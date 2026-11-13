/**
 * INDEPENDENT BROWSER CASES, OVERLAPPED.
 *
 * Nearly all of a visual case's time is a fresh context starting, a scene loading and the page's own
 * timers running — time the runner spends idle. Cases that share no state (each opens its own context
 * from a static server) do not have to queue: `overlapped().start` begins every body together, in a
 * `beforeAll`, and each registered test only waits for and reports ITS body — so names, failures and
 * per-test times stay per case, and a body's failure is thrown from its own test, never from the
 * hook or as an unhandled rejection.
 *
 * `boundedContext` is the one throttle: at most `limit` contexts of a file are open at once, so
 * overlapping cannot starve the runner of memory or CPU. A body that holds a context while it opens
 * another is safe only while the bodies that do so are fewer than the limit.
 */
import { it } from 'bun:test';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright-core';

/** At most `limit` jobs at once; the rest wait their turn in the order they asked. */
export const gate = (limit: number) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    while (running >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
};

/** `browser.newContext` with at most `limit` contexts open at once; `close()` frees the place. */
export const boundedContext = (getBrowser: () => Browser, limit: number) => {
  let open = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    open -= 1;
    waiting.shift()?.();
  };
  return async (options?: BrowserContextOptions): Promise<BrowserContext> => {
    while (open >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    open += 1;
    try {
      const context = await getBrowser().newContext(options);
      const close = context.close.bind(context);
      let freed = false;
      context.close = async closeOptions => {
        try {
          await close(closeOptions);
        } finally {
          if (!freed) {
            freed = true;
            release();
          }
        }
      };
      return context;
    } catch (error) {
      release();
      throw error;
    }
  };
};

type Outcome = { readonly error: unknown } | undefined;

export const overlapped = () => {
  const bodies: (() => Promise<void>)[] = [];
  const outcomes: Promise<Outcome>[] = [];
  return {
    /** Registers a test whose body begins at `start()`. */
    it: (name: string, body: () => Promise<void>, timeout?: number): void => {
      const index = bodies.length;
      bodies.push(body);
      it(
        name,
        async () => {
          const outcome = await outcomes[index];
          if (outcome !== undefined) throw outcome.error;
        },
        timeout,
      );
    },
    /** Begins every registered body. Call it from a `beforeAll` registered AFTER the one that serves the scene. */
    start: (): void => {
      for (const body of bodies)
        outcomes.push(
          body().then(
            (): Outcome => undefined,
            (error: unknown): Outcome => ({ error }),
          ),
        );
    },
  };
};

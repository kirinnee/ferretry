/**
 * What `read-scope.test.ts` (unit: small screens, every mask checked) and `tests/perf/daemon/secrets/read-scope.test.ts`
 * (perf: a busy screen, the cost bounded) share. It reads no clock.
 */
import type { TextRange } from '../../../../daemon/lib/secrets/policy.ts';

/** A value source that counts its opens, or fails. */
export function source(entries: Record<string, string> | Error) {
  let opens = 0;
  return {
    opens: () => opens,
    values: async () => {
      opens += 1;
      if (entries instanceof Error) throw entries;
      return new Map(Object.entries(entries));
    },
  };
}

/** `ranges` behind a proxy that counts every element read, so a test can tell one pass from a pass per character. */
export function counted(ranges: readonly TextRange[]): {
  readonly ranges: readonly TextRange[];
  readonly reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy([...ranges], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { ranges: proxy, reads: () => reads };
}

// A 4-character value printed densely: one match range every 5 characters.
export const PIN = '1234';
export const dense = (width: number) => `${PIN} `.repeat(width / 5);

/**
 * zod's JIT is off before the first schema (r12 H8): the app's start imports `zod-jitless.ts` FIRST, and the module turns the
 * probe that `require-trusted-types-for 'script'` would report off. The browser half (0 Trusted Types violations on a real page
 * under the real policy) is Conversation's `hypermedia-csp.visual.test.ts`, which no longer tolerates the probe.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import '../../../src/security/zod-jitless.ts';

describe('zod jitless', () => {
  it('is on once the module is imported', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('does not probe `new Function` while a schema is made and parsed', () => {
    const real = globalThis.Function;
    let built = 0;
    // A page under Trusted Types reports every `new Function`; count them the way the browser would.
    globalThis.Function = new Proxy(real, {
      construct(target, args) {
        built += 1;
        return Reflect.construct(target, args) as object;
      },
    });
    try {
      const schema = z.object({ id: z.string(), n: z.number().int() });
      expect(schema.parse({ id: 'a', n: 1 })).toEqual({ id: 'a', n: 1 });
    } finally {
      globalThis.Function = real;
    }
    expect(built).toBe(0);
  });

  it('is the first import of the app entry, so no schema is built before it', () => {
    const main = readFileSync(join(import.meta.dir, '../../../src/main.tsx'), 'utf8');
    const firstImport = main.split('\n').find(line => line.startsWith('import '));
    expect(firstImport?.startsWith("import './security/zod-jitless.ts';")).toBe(true);
  });
});

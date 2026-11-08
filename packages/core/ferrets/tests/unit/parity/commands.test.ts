import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The parity ledger's command rows for the names verb name this file; the proof lives in the test that carries the id. */
const PROOF: Readonly<Record<string, string>> = { 'V-0333': 'cli/session/controllers.test.ts' };

describe('the names command rows are proven where the ids are tagged', () => {
  for (const [id, file] of Object.entries(PROOF))
    test(`${id} is proven by a test in ${file}`, () => {
      const path = join(import.meta.dir, '..', file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(id);
    });
});

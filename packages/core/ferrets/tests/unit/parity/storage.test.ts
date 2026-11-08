import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The parity ledger's file rows for the names state name this file; the proof lives in the tests that carry the ids. */
const PROOF: Readonly<Record<string, string>> = {
  'F-0232': 'daemon/ferrets/names-ledger.test.ts',
  'F-0349': 'daemon/names/system-callsigns.test.ts',
};

describe('the names state rows are proven where the ids are tagged', () => {
  for (const [id, file] of Object.entries(PROOF))
    test(`${id} is proven by a test in ${file}`, () => {
      const path = join(import.meta.dir, '..', file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(id);
    });
});

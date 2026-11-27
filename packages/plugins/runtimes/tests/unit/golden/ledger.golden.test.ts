/**
 * E-276 0a: the ledger of the goldens themselves. Every committed golden is listed here, so a later PR cannot make one pass by
 * deleting it or renaming it: the list changes, and this golden is as frozen as the rest.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { expectGolden } from './support/golden.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** Every file under the fixtures as a path from them; one that is no `.golden.txt` is named as such, so it cannot hide. This ledger's own file is left out. */
const goldens = (directory: string, prefix = ''): string[] =>
  readdirSync(join(FIXTURES, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return goldens(join(directory, entry.name), `${prefix}${entry.name}/`);
    const path = `${prefix}${entry.name}`;
    if (path === 'ledger.golden.txt') return [];
    return [entry.name.endsWith('.golden.txt') ? path : `NOT A GOLDEN: ${path}`];
  });

describe('golden ledger', () => {
  it('should list every committed golden', () => {
    expectGolden('ledger', goldens('').toSorted());
  });
});

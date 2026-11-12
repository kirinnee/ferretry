import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };

const FYD = join(import.meta.dir, '../../../host/fyd.ts');

test('fyd reports the version of packages/core/kernel/package.json: no literal that bump.sh cannot stamp', () => {
  const source = readFileSync(FYD, 'utf8');
  expect(source).toMatch(/^const VERSION = pkg\.version;$/m);
  expect(source).toMatch(/^import pkg from '\.\.\/package\.json' with \{ type: 'json' \};$/m);
  expect(source).not.toMatch(/const VERSION = '/);
  const child = Bun.spawnSync(['bun', FYD, '--version'], { timeout: 30_000 });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain(pkg.version);
});

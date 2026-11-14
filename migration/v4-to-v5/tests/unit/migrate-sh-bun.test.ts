import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox, SECRET_VALUE, type Sandbox } from './migrate-harness.ts';

/**
 * The converter's bun.lock is written by the devshell's bun; an older bun cannot read it, so `convert` died on
 * `bun install --frozen-lockfile` AFTER the quiet window and the backup. `preflight` now refuses an older bun first.
 * The minimum is migration/v4-to-v5/bun-version, and nix/bun.nix (the devshell's bun) is its one owner: the last
 * test fails the day the two drift.
 */

setDefaultTimeout(60_000);

const here = import.meta.dir;
const pinFile = join(here, '..', '..', 'bun-version');
const nixBun = join(here, '..', '..', '..', '..', 'nix', 'bun.nix');

const made: Sandbox[] = [];
const box = async (): Promise<Sandbox> => {
  const sb = await makeSandbox();
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('preflight refuses a bun older than the converter lockfile needs', () => {
  test('bun 1.3.13: exit 1 with one remedy sentence naming the needed version, and nothing is touched', async () => {
    const sb = await box();
    const needed = (await readFile(pinFile, 'utf8')).trim();
    await sb.state('bun.version', '1.3.13\n');
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('bun 1.3.13');
    expect(result.err).toContain(`bun ${needed} or later`);
    expect(result.err.trim().split('\n')).toHaveLength(1);
    // Nothing was written, stopped or read: no notes file, no tmux, no fy/fyd call, no secret anywhere.
    expect(await exists(sb.notes)).toBe(false);
    expect((await sb.calls()).filter(line => /^(tmux|fy|fyd|brew|nix) /.test(line))).toEqual([]);
    expect(result.out + result.err).not.toContain(SECRET_VALUE);
  });

  test('a bun below the pin in any component is refused (1.4.3), and one above it passes (1.4.5, 1.10.0)', async () => {
    const sb = await box();
    await sb.state('bun.version', '1.4.3\n');
    expect((await sb.run('preflight', ['--notes', sb.notes])).code).toBe(1);
    for (const version of ['1.4.5', '1.10.0']) {
      const again = await makeSandbox();
      made.push(again);
      await again.state('bun.version', `${version}\n`);
      expect((await again.run('preflight', ['--notes', again.notes])).code).toBe(0);
    }
  });

  test('bun at exactly the pinned version passes preflight', async () => {
    const sb = await box();
    await sb.state('bun.version', (await readFile(pinFile, 'utf8')).trim() + '\n');
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    expect(result.code).toBe(0);
    expect(await exists(sb.notes)).toBe(true);
  });
});

describe('the pin has one owner', () => {
  test('migration/v4-to-v5/bun-version equals the Bun version nix/bun.nix puts in the devshell', async () => {
    const nix = await readFile(nixBun, 'utf8');
    const devshell = /^\s*version = "(\d+\.\d+\.\d+)";/m.exec(nix)?.[1];
    expect(devshell).toBeDefined();
    expect((await readFile(pinFile, 'utf8')).trim()).toBe(devshell as string);
  });
});

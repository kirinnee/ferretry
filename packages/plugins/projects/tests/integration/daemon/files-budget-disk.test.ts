/**
 * The sign-in look of a folder spends the build's budget on a REAL disk (&F6061 U5 review R3): the kernel's pinned listing
 * stops where the budget stops, and a folder the look could not finish is "partial", never "no sign-in file here".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import { cleanUp, put, world } from './files-support.ts';

afterEach(cleanUp);

/** A budget that says "time left" for its first `fresh` questions and "spent" ever after. */
const spentAfter = (fresh: number) => {
  let asked = 0;
  return { expired: () => ++asked > fresh, remainingMs: () => 1_000 };
};

describe('holdsSignIn takes the build’s budget', () => {
  test('a budget already spent is not listed against at all: the folder is not proved free, so it is "partial"', async () => {
    const machine = await world();
    await put(machine.project, { 'docs/a.txt': 'a', 'docs/b.txt': 'b' });
    const browser = kernelBrowser(machine.kernel);

    expect(await browser.holdsSignIn(join(machine.project, 'docs'), spentAfter(0))).toBe('partial');
  });

  test('a budget that runs out part-way through the listing stops the listing and says the look is not whole', async () => {
    const machine = await world();
    await put(machine.project, { 'docs/a.txt': 'a', 'docs/b.txt': 'b', 'docs/c.txt': 'c' });
    const browser = kernelBrowser(machine.kernel);

    // One question before the pin; the listing then finds the budget spent at its first name.
    expect(await browser.holdsSignIn(join(machine.project, 'docs'), spentAfter(1))).toBe('partial');
  });

  test('with time left it answers as before: no sign-in file is false, a sign-in file is true', async () => {
    const machine = await world();
    await put(machine.project, { 'docs/a.txt': 'a', 'vault/auth.json': '{}' });
    await mkdir(join(machine.project, 'empty'));
    const browser = kernelBrowser(machine.kernel);
    const plenty = { expired: () => false, remainingMs: () => 1_000 };

    expect(await browser.holdsSignIn(join(machine.project, 'docs'), plenty)).toBe(false);
    expect(await browser.holdsSignIn(join(machine.project, 'vault'), plenty)).toBe(true);
    expect(await browser.holdsSignIn(join(machine.project, 'empty'))).toBe(false);
  });
});

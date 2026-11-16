import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh temp directory per test. Nothing here ever resolves a real state home — a test that
 * touched the operator's state would be a broken test, not a thorough one.
 */
export const withTempRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-state-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Hands out pinned scratch names so a fault test can assert on the exact file that was cleaned up. */
export class FixedTempNameSource {
  private readonly names: readonly string[];
  private index = 0;

  constructor(names: readonly string[]) {
    this.names = names;
  }

  next(): string {
    const name = this.names[this.index % this.names.length];
    this.index += 1;
    return name ?? 'fallback';
  }
}

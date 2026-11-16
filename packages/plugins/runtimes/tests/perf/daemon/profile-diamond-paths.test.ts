/**
 * R2 (M-1): a diamond of `profile/<base>` layers must not hang the daemon on ANY public path that reads a profile's stack.
 * Any agent can write `profiles/*.yaml`, so 42 small files (a lattice of 2^20 paths) is an input, not a thought experiment.
 * What each path answers is tests/unit/daemon/profile-diamond-paths.test.ts, on a 4-deep lattice; this file holds only the
 * time: each path that expands bases is timed against a deadline on the 20-deep one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { latticeDocument, world } from '../../support/diamond-world.ts';

const DEPTH = 20;
/** Reading every path would take minutes; a pure answer takes milliseconds. */
const DEADLINE_MS = 1000;

/** How long `act` takes to settle, and what it settled with. */
async function timed<T>(act: () => Promise<T>): Promise<{ readonly took: number; readonly value: T }> {
  const started = performance.now();
  const value = await act();
  return { took: performance.now() - started, value };
}

describe('R2 a 20-deep diamond of profile bases answers at once through every public path (M-1)', () => {
  it('R2 should read the model itself inside the deadline', () => {
    // Act
    const started = performance.now();
    parseAccountModel(latticeDocument(DEPTH));

    // Assert
    should(performance.now() - started).be.below(DEADLINE_MS);
  });

  it('R2 should list the components, with who uses each, inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(async () => await service.components());

    // Assert — every item is used by the profiles that reach it: a0's item by a0 alone, a1's by a0 and the profiles above.
    const mcp = value.kinds.find(group => group.kind === 'mcp');
    should(mcp?.components.length).equal(42);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should list the profiles inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(async () => await service.profiles());

    // Assert
    should(value.profiles.length).equal(42);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should preview a profile draft that names the lattice inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(
      async () => await service.previewProfile({ layers: ['profile/a0', 'mcp/b0'], editing: undefined }),
    );

    // Assert
    should(value.refusal).be.undefined();
    should(took).be.below(DEADLINE_MS);
  });

  // A draft that EDITS a profile so that the layer graph reaches back to it (a loop cut below every path) was exponential
  // in the scope fold: 3.1 s at 42 files, x4 every two levels. These run synchronously, so a regression shows as a wall
  // time over the deadline (or, with a deeper lattice, a hang bun's per-test timeout cannot cut) — keep DEPTH at 20.
  it('R2 should preview a draft that makes the lattice’s bottom name its top (a loop) inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(
      async () => await service.previewProfile({ layers: ['profile/a0'], editing: 'b20' }),
    );

    // Assert — b20 is the bottom of the lattice, so a0 reaches it: the loop is named, and nothing walks every path.
    should(value.refusal).match(/would include itself/);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should preview a draft that makes a middle profile name the top, with a base below it, inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(
      async () => await service.previewProfile({ layers: ['profile/a0', 'profile/b11', 'mcp/b3'], editing: 'a10' }),
    );

    // Assert
    should(value.refusal).match(/would include itself/);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should refuse a proposed profile that makes the lattice’s bottom name its top inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(
      async () =>
        await service.propose({ kind: 'profile.put', name: 'b20', layers: ['profile/a0'], create: false }).then(
          () => 'proposed',
          (error: unknown) => (error as Error).message,
        ),
    );

    // Assert
    should(value).match(/would include itself/);
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should propose a change, which resolves every runtime’s profile as an apply does, inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(
      async () => await service.propose({ kind: 'runtime.rename', name: 'second', to: 'renamed' }),
    );

    // Assert
    should(value).not.be.undefined();
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should republish inside the deadline', async () => {
    // Arrange
    const service = world(DEPTH);

    // Act
    const { took, value } = await timed(async () => await service.republish());

    // Assert
    should(value).equal('applied');
    should(took).be.below(DEADLINE_MS);
  });
});

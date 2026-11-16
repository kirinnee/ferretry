/**
 * R2: `layers()`, `profiles()` and `changeProfileLayers()` on a 20-deep lattice of shared bases (about a million paths)
 * answer at once. What they answer is tests/unit/daemon/profile-layers.test.ts, on a 4-deep lattice; this file holds
 * only the time.
 */
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { RuntimeIdSchema } from '../../../contract/index.ts';
import { lattice, owner, stopWorlds, world } from '../../support/profile-layers-world.ts';

afterEach(stopWorlds);

describe('R2 layers — a lattice of shared bases is judged at once', () => {
  const runtime = RuntimeIdSchema.parse('work');

  it('R2 should resolve a 20-deep lattice (about a million paths) at once', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a0', agent: true } },
      profiles: lattice(20),
    });

    // Act
    const started = performance.now();
    const layers = await runtimes.layers(runtime);
    const took = performance.now() - started;

    // Assert — an expansion per path would take minutes.
    should(layers?.mcp.length).equal(41);
    should(new Set(layers?.mcp).size).equal(41);
    should(layers?.mcp.at(-1)).equal('a0');
    should(took).be.below(1000);
  });

  it('R2 should list the profiles and change one of a 20-deep lattice (about a million paths) at once', async () => {
    // Arrange
    const { port: runtimes } = await world({
      runtimes: { work: { login: 'claude-you', profile: 'a0', agent: true } },
      profiles: lattice(20),
    });

    // Act
    const listedAt = performance.now();
    const listed = await runtimes.profiles();
    const listedTook = performance.now() - listedAt;
    const addedAt = performance.now();
    const added = await runtimes.changeProfileLayers({ kind: 'add', profile: 'a0', layer: 'mcp/extra' }, owner);
    const addedTook = performance.now() - addedAt;
    const removedAt = performance.now();
    const removed = await runtimes.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/extra' }, owner);
    const removedTook = performance.now() - removedAt;

    // Assert
    should(listed.length).equal(42);
    should(added).deepEqual({ kind: 'written', profiles: ['a0'] });
    should(removed).deepEqual({ kind: 'written', profiles: ['a0'] });
    should(listedTook).be.below(1000);
    should(addedTook).be.below(1000);
    should(removedTook).be.below(1000);
  });
});

import { describe, it } from 'bun:test';
import should from 'should';
import { WatchedDocument } from '../../../src/lib/fleet-reading/watched-document.ts';

/** A file a test changes on cue, behind a watch it can make live or not, and a count of its reads. */
function documentWorld() {
  const world = {
    listener: undefined as (() => void) | undefined,
    live: true,
    closed: false,
    loads: 0,
    content: 'v1',
    hold: undefined as Promise<void> | undefined,
  };
  const document = new WatchedDocument('/fleet/manifest.json', {
    watch: (_path, listener) => {
      world.listener = listener;
      return {
        live: () => world.live,
        close: () => {
          world.closed = true;
        },
      };
    },
    load: async () => {
      world.loads += 1;
      const content = world.content;
      if (world.hold !== undefined) await world.hold;
      return content;
    },
  });
  return { world, document };
}

describe('WatchedDocument', () => {
  it('should read the file once, and again only after its watch saw a change', async () => {
    // Arrange
    const { world, document } = documentWorld();

    // Act
    const first = await document.read();
    const again = await document.read();
    world.content = 'v2';
    world.listener?.();
    const changed = await document.read();

    // Assert
    should([first, again, changed]).deepEqual(['v1', 'v1', 'v2']);
    should(world.loads).equal(2);
  });

  it('should keep nothing while its watch is not live', async () => {
    // Arrange
    const { world, document } = documentWorld();
    world.live = false;

    // Act
    await document.read();
    await document.read();

    // Assert
    should(world.loads).equal(2);
  });

  it('should not keep an answer read while the file changed under it', async () => {
    // Arrange
    const { world, document } = documentWorld();
    const { promise, resolve } = Promise.withResolvers<void>();
    world.hold = promise;

    // Act — the file changes while the read that saw its old content is still out.
    const reading = document.read();
    world.content = 'v2';
    world.listener?.();
    resolve();
    const stale = await reading;
    world.hold = undefined;
    const next = await document.read();

    // Assert
    should([stale, next]).deepEqual(['v1', 'v2']);
    should(world.loads).equal(2);
  });

  it('should close its watch', () => {
    // Arrange
    const { world, document } = documentWorld();

    // Act
    document.close();

    // Assert
    should(world.closed).be.true();
  });
});

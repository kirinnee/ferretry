/**
 * A STALL MUST SAY WHERE IT SPENT ITS TIME.
 *
 * "event loop stalled for 5.3s — during fleet refresh, analytics ingest, boot: arming the warden,
 * self-check, terminal reaper, declared-wait watcher, turn watcher" named everything that was running and
 * pinned nothing. These drive the real JavaScriptCore sampling profiler against a function that blocks
 * the loop, and prove the sample names it.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  AsyncActivityScope,
  JscStackSampler,
  jscSamples,
  stackSamplerEnabled,
} from '../../../src/adapters/runtime/stall-attribution.ts';
import { summariseStacks } from '../../../src/lib/runtime/liveness.ts';

/** Blocks the loop, as a synchronous parse over a huge transcript did. */
function blockTheLoopForAWhile(milliseconds: number): number {
  const until = performance.now() + milliseconds;
  let spins = 0;
  while (performance.now() < until) spins += 1;
  return spins;
}

describe('JscStackSampler', () => {
  it('should name the function that blocked the loop in the samples it drains', async () => {
    // Arrange
    const sampler = await JscStackSampler.start();
    should(sampler).not.be.undefined();
    sampler?.drain();

    // Act
    blockTheLoopForAWhile(120);
    const stacks = summariseStacks(sampler?.drain() ?? []);

    // Assert
    should(stacks.length).be.above(0);
    should(stacks.map(stack => stack.stack).join('\n')).containEql('blockTheLoopForAWhile');
  });

  it('should forget what it drained, so the next window holds only its own samples', async () => {
    // Arrange
    const sampler = await JscStackSampler.start();
    blockTheLoopForAWhile(30);
    sampler?.drain();

    // Act
    const next = sampler?.drain() ?? [];

    // Assert
    should(
      summariseStacks(next)
        .map(stack => stack.stack)
        .join('\n'),
    ).not.containEql('blockTheLoopForAWhile');
  });

  it('should forget what it discarded too, so an on-time window never reaches a later stall', async () => {
    // Arrange
    const sampler = await JscStackSampler.start();
    blockTheLoopForAWhile(30);

    // Act
    sampler?.discard();
    const next = sampler?.drain() ?? [];

    // Assert
    should(
      summariseStacks(next)
        .map(stack => stack.stack)
        .join('\n'),
    ).not.containEql('blockTheLoopForAWhile');
  });
});

describe('JscStackSampler.start', () => {
  it('should answer no sampler for a runtime whose module has no sampling profiler, or none at all', async () => {
    // Act / Assert
    should(await JscStackSampler.start(async () => ({}))).be.undefined();
    should(
      await JscStackSampler.start(async () => {
        throw new Error('Cannot find module bun:jsc');
      }),
    ).be.undefined();
  });
});

describe('AsyncActivityScope', () => {
  it('should carry a value across awaits inside its scope, and nothing outside it', async () => {
    // Arrange
    const scope = new AsyncActivityScope<string>();
    let inside: string | undefined;

    // Act
    await scope.within('fleet refresh', async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      inside = scope.current();
    });

    // Assert
    should(inside).equal('fleet refresh');
    should(scope.current()).be.undefined();
  });

  it('should carry nothing into a timer run outside, though the timer was armed inside', async () => {
    // Arrange
    const scope = new AsyncActivityScope<string>();
    const seen: (string | undefined)[] = [];

    // Act — the pass arms the next one; the next one must not belong to it.
    await scope.within('fleet refresh', async () => {
      await new Promise<void>(resolve =>
        setTimeout(() => {
          seen.push(scope.current());
          scope.outside(() => seen.push(scope.current()));
          resolve();
        }, 1),
      );
    });

    // Assert
    should(seen).deepEqual(['fleet refresh', undefined]);
  });
});

describe('jscSamples', () => {
  it('should read frames innermost first, dropping the positions the profiler does not know', () => {
    // Act
    const actual = jscSamples({
      traces: [
        {
          frames: [
            { name: 'now', line: 4_294_967_295 },
            { name: 'scan', sourceURL: '/w/packages/fleet/src/x.ts', line: 12 },
            { sourceURL: '' },
          ],
        },
        {},
      ],
    });

    // Assert
    should(actual).deepEqual([
      { frames: [{ name: 'now' }, { name: 'scan', url: '/w/packages/fleet/src/x.ts', line: 12 }, { name: '' }] },
      { frames: [] },
    ]);
  });

  it('should read anything it does not recognise as no samples', () => {
    // Act / Assert
    should(jscSamples(undefined)).deepEqual([]);
    should(jscSamples({ traces: 'nope' })).deepEqual([]);
  });
});

describe('stackSamplerEnabled', () => {
  it('should leave the sampler on unless the variable says 0', () => {
    // Act / Assert
    should(stackSamplerEnabled(undefined)).be.true();
    should(stackSamplerEnabled('1')).be.true();
    should(stackSamplerEnabled(' 0 ')).be.false();
  });
});

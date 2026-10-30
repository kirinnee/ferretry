/**
 * THE ROUTING KEEP: PACK'S ROUTING LINE, DERIVED ONCE PER CONFIGURATION.
 *
 * A scripted generation, derivation and clock stand in for the configuration files and Pack's service. What
 * must hold: callers asking while the generation holds share one derivation — concurrent ones the derivation
 * in flight; a new configuration load or an old line is derived again; and a derivation that fails is
 * thrown to its callers and not kept.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { PACK_ROUTING_MAX_AGE_MS, PackRoutingKeep } from '../../../src/lib/pack/routing-keep.ts';

const NOW = 1_786_000_000_000;

/** The configuration and the service the keep reads, scripted: the load in effect, the clock, the derivations. */
class Pack {
  /** A configuration load, as the files service answers it: a new object per load. */
  load: object = {};
  now = NOW;
  derivations = 0;
  line = 'Routing: claude-opus-5-5 for planning.';
  fail = false;
  held: Array<() => void> = [];
  hold = false;

  keep(): PackRoutingKeep {
    return new PackRoutingKeep({
      generation: async () => await Promise.resolve(this.load),
      derive: async () => {
        this.derivations += 1;
        const line = this.line;
        if (this.hold) {
          const { promise, resolve } = Promise.withResolvers<void>();
          this.held.push(resolve);
          await promise;
        }
        if (this.fail) throw new Error('the model catalogs could not be read');
        return line;
      },
      now: () => this.now,
      maxAgeMs: PACK_ROUTING_MAX_AGE_MS,
    });
  }
}

describe('PackRoutingKeep', () => {
  it('should answer every caller from one derivation while the configuration holds', async () => {
    // Arrange
    const pack = new Pack();
    const subject = pack.keep();

    // Act
    const first = await subject.line();
    pack.line = 'Routing: a line nobody saved.';
    const again = await subject.line();
    pack.now = NOW + PACK_ROUTING_MAX_AGE_MS - 1;
    const later = await subject.line();

    // Assert
    should(pack.derivations).equal(1);
    should(first).equal('Routing: claude-opus-5-5 for planning.');
    should(again).equal(first);
    should(later).equal(first);
  });

  it('should share the derivation in flight with every caller that asks while it runs', async () => {
    // Arrange
    const pack = new Pack();
    pack.hold = true;
    const subject = pack.keep();

    // Act
    const asks = Array.from({ length: 40 }, async () => await subject.line());
    while (pack.held.length === 0) await Promise.resolve();
    for (const release of pack.held) release();
    const answers = await Promise.all(asks);

    // Assert
    should(pack.derivations).equal(1);
    should(new Set(answers)).deepEqual(new Set(['Routing: claude-opus-5-5 for planning.']));
  });

  it('should derive again when a saved file replaced the configuration load', async () => {
    // Arrange
    const pack = new Pack();
    const subject = pack.keep();
    await subject.line();

    // Act
    pack.load = {};
    pack.line = 'Routing: glm-5.3 for chores.';
    const saved = await subject.line();

    // Assert
    should(pack.derivations).equal(2);
    should(saved).equal('Routing: glm-5.3 for chores.');
  });

  it('should derive again once the line is as old as its bound, however still the configuration is', async () => {
    // Arrange — a newer published catalog moves no configuration file.
    const pack = new Pack();
    const subject = pack.keep();
    await subject.line();

    // Act
    pack.line = 'Routing: a model the published catalog added.';
    pack.now = NOW + PACK_ROUTING_MAX_AGE_MS;
    const old = await subject.line();

    // Assert
    should(pack.derivations).equal(2);
    should(old).equal('Routing: a model the published catalog added.');
  });

  it('should throw a failed derivation to its callers, and derive again on the next ask', async () => {
    // Arrange
    const pack = new Pack();
    pack.fail = true;
    const subject = pack.keep();

    // Act
    const failed = await subject.line().then(
      () => undefined,
      (error: unknown) => error,
    );
    pack.fail = false;
    const recovered = await subject.line();

    // Assert
    should(failed).be.instanceOf(Error);
    should((failed as Error).message).equal('the model catalogs could not be read');
    should(recovered).equal('Routing: claude-opus-5-5 for planning.');
    should(pack.derivations).equal(2);
  });

  it('should keep a newer derivation when an older one fails after it was replaced', async () => {
    // Arrange — a derivation is in flight when a file is saved and a second one starts.
    const pack = new Pack();
    pack.hold = true;
    const subject = pack.keep();
    const older = subject.line().then(
      () => 'landed',
      () => 'failed',
    );
    while (pack.held.length < 1) await Promise.resolve();
    pack.load = {};
    pack.line = 'Routing: the saved one.';
    const newer = subject.line();
    while (pack.held.length < 2) await Promise.resolve();

    // Act — the older derivation fails; the newer one lands.
    pack.fail = true;
    pack.held[0]?.();
    const outcome = await older;
    pack.fail = false;
    pack.held[1]?.();
    const landed = await newer;
    const kept = await subject.line();

    // Assert — the failure did not drop the newer derivation.
    should(outcome).equal('failed');
    should(landed).equal('Routing: the saved one.');
    should(kept).equal(landed);
    should(pack.derivations).equal(2);
  });
});

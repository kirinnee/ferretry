import { describe, it } from 'bun:test';
import type { CompactAt } from '../../../../../daemon/seams/protocol.ts';
import should from 'should';
import {
  type CompactAtFacts,
  SessionCompactAtError,
  SessionCompactAtService,
} from '../../../../../daemon/turns/compact-at/lib/service.ts';
import { at } from '../../../../support/instant.ts';

const AT = at('2026-11-02T10:00:00.000Z');

function world(facts: CompactAtFacts | undefined) {
  const writes: Array<readonly [string, CompactAt | undefined, string]> = [];
  const service = new SessionCompactAtService({
    facts: async () => facts,
    write: async (sessionId, value, at) => {
      writes.push([sessionId, value, at]);
    },
    now: () => AT,
  });
  return { service, writes };
}

const facts = (over: Partial<CompactAtFacts> = {}): CompactAtFacts => ({
  own: undefined,
  accountDefault: undefined,
  window: 1_000_000,
  running: true,
  ...over,
});

describe('SessionCompactAtService.get', () => {
  it('should read auto when nothing is set, with the window and no restart', async () => {
    // Act
    const reading = await world(facts()).service.get('s1');

    // Assert
    should(reading).deepEqual({
      effective: 'auto',
      window: 1_000_000,
      restartRequired: false,
      note: 'Memory is compacted at the harness’s own trigger (Auto).',
    });
  });

  it('should name the login as the source when its default applies', async () => {
    // Act
    const reading = await world(facts({ accountDefault: 400_000 })).service.get('s1');

    // Assert
    should(reading.effective).equal(400_000);
    should(reading.own).be.undefined();
    should(reading.note).equal('Memory is compacted at 400k tokens (this login’s default).');
  });

  it('should report the ferret’s own value over the login’s', async () => {
    // Act
    const reading = await world(facts({ own: 250_000, accountDefault: 400_000 })).service.get('s1');

    // Assert
    should(reading.effective).equal(250_000);
    should(reading.own).equal(250_000);
  });

  it('should refuse a session that does not exist', async () => {
    // Act
    const error = await world(undefined)
      .service.get('nope')
      .catch((caught: unknown) => caught);

    // Assert
    should(error).be.instanceOf(SessionCompactAtError);
    should((error as SessionCompactAtError).reason).equal('not-found');
  });
});

describe('SessionCompactAtService.set', () => {
  it('should record the value and say a running ferret takes it at its next restart', async () => {
    // Arrange
    const { service, writes } = world(facts({ running: true }));

    // Act
    const outcome = await service.set('s1', 250_000);

    // Assert
    should(writes).deepEqual([['s1', 250_000, AT]]);
    should(outcome.effective).equal(250_000);
    should(outcome.restartRequired).be.true();
    should(outcome.note).containEql('takes effect when the ferret restarts');
  });

  it('should say a stopped ferret takes it at its next launch, with no restart owed', async () => {
    // Act
    const outcome = await world(facts({ running: false })).service.set('s1', 250_000);

    // Assert
    should(outcome.restartRequired).be.false();
    should(outcome.note).containEql('next launch');
  });

  it('should report "already" when the effective value does not change', async () => {
    // Arrange
    const { service, writes } = world(facts({ own: 250_000 }));

    // Act
    const outcome = await service.set('s1', 250_000);

    // Assert
    should(outcome.restartRequired).be.false();
    should(outcome.note).endWith('already.');
    should(writes).have.length(1);
  });

  it('should refuse a size below the floor and write nothing', async () => {
    // Arrange
    const { service, writes } = world(facts());

    // Act
    const error = await service.set('s1', 50_000).catch((caught: unknown) => caught);

    // Assert
    should(error).be.instanceOf(SessionCompactAtError);
    should((error as SessionCompactAtError).reason).equal('invalid');
    should((error as Error).message).equal('50k is too small: the lowest is 100k.');
    should(writes).have.length(0);
  });

  it('should refuse a size above the model’s window', async () => {
    // Act
    const error = await world(facts({ window: 200_000 }))
      .service.set('s1', 400_000)
      .catch((caught: unknown) => caught);

    // Assert
    should((error as Error).message).containEql('larger than this model');
  });

  it('should let inherit drop the ferret’s own value so the login’s default applies again', async () => {
    // Arrange
    const { service, writes } = world(facts({ own: 250_000, accountDefault: 400_000 }));

    // Act
    const outcome = await service.set('s1', 'inherit');

    // Assert
    should(writes).deepEqual([['s1', undefined, AT]]);
    should(outcome.effective).equal(400_000);
    should(outcome.restartRequired).be.true();
  });

  it('should let an explicit auto beat a login default', async () => {
    // Act
    const outcome = await world(facts({ accountDefault: 400_000 })).service.set('s1', 'auto');

    // Assert
    should(outcome.effective).equal('auto');
  });
});

describe('SessionCompactAtService against the model window', () => {
  it('should not use a login default larger than the window, and say why', async () => {
    // Act
    const reading = await world(facts({ accountDefault: 400_000, window: 200_000 })).service.get('s1');

    // Assert
    should(reading.effective).equal('auto');
    should(reading.note).containEql('This login’s default 400k is not used');
    should(reading.note).containEql('larger than this model');
  });

  it('should refuse inherit when it would hand the ferret a default its model cannot honour', async () => {
    // Arrange
    const { service, writes } = world(facts({ own: 150_000, accountDefault: 400_000, window: 200_000 }));

    // Act
    const error = await service.set('s1', 'inherit').catch((caught: unknown) => caught);

    // Assert
    should(error).be.instanceOf(SessionCompactAtError);
    should((error as SessionCompactAtError).reason).equal('invalid');
    should((error as Error).message).containEql('login’s default can’t be used');
    should(writes).have.length(0);
  });

  it('should let inherit through when the default fits the window', async () => {
    // Act
    const outcome = await world(facts({ own: 150_000, accountDefault: 400_000, window: 1_000_000 })).service.set(
      's1',
      'inherit',
    );

    // Assert
    should(outcome.effective).equal(400_000);
  });
});

describe('SessionCompactAtService with a restart pending', () => {
  it('should keep reporting the restart on a repeat of the same change and on a read', async () => {
    // Arrange: launched at 250k, then changed to 400k, not yet restarted
    const afterChange = facts({ own: 400_000, launched: 250_000 });

    // Act
    const repeated = await world(afterChange).service.set('s1', 400_000);
    const read = await world(afterChange).service.get('s1');

    // Assert
    should(repeated.restartRequired).be.true();
    should(repeated.note).containEql('already');
    should(repeated.note).containEql('running on 250k');
    should(read.restartRequired).be.true();
    should(read.note).containEql('running on 250k');
  });

  it('should owe a restart for a change away from what the process launched with', async () => {
    // Act
    const outcome = await world(facts({ own: 250_000, launched: 250_000 })).service.set('s1', 400_000);

    // Assert
    should(outcome.restartRequired).be.true();
    should(outcome.note).containEql('running on 250k');
  });

  it('should owe nothing once the value is changed back to what the process launched with', async () => {
    // Act
    const outcome = await world(facts({ own: 400_000, launched: 250_000 })).service.set('s1', 250_000);

    // Assert
    should(outcome.restartRequired).be.false();
    should(outcome.note).containEql('nothing needs to restart');
  });

  it('should owe a restart when the process launched without the login default now in force', async () => {
    // Act
    const reading = await world(facts({ accountDefault: 250_000, launched: 'auto' })).service.get('s1');

    // Assert
    should(reading.restartRequired).be.true();
  });

  it('should owe nothing for a stopped ferret, whatever it last launched with', async () => {
    // Act
    const reading = await world(facts({ own: 400_000, launched: 250_000, running: false })).service.get('s1');

    // Assert
    should(reading.restartRequired).be.false();
  });
});

import { describe, it } from 'bun:test';
import should from 'should';
import {
  isAncestorOf,
  isSubFerret,
  NO_SUB_FERRETS,
  type SubFerretDirectory,
  subFerretRefusal,
} from '../../../../daemon/lib/sub-ferret/index.ts';
import { DIRECTORY } from './support.ts';

describe('isAncestorOf', () => {
  it('should not follow a cycle forever', async () => {
    // Arrange
    const loop: SubFerretDirectory = {
      leadOf: async sessionId => (sessionId === 'a' ? 'b' : 'a'),
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(loop, 'z', 'a');

    // Assert
    should(found).be.false();
  });

  it('should stop at a chain deeper than it follows', async () => {
    // Arrange
    const deep: SubFerretDirectory = {
      leadOf: async sessionId => `${sessionId}x`,
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(deep, 'never', 'a');

    // Assert
    should(found).be.false();
  });

  it('should not count a session as its own ancestor', async () => {
    // Act
    const found = await isAncestorOf(DIRECTORY, 'child', 'child');

    // Assert
    should(found).be.false();
  });
});

describe('isAncestorOf failing closed', () => {
  it('should answer no when the directory cannot say who started a session', async () => {
    // Arrange
    const broken: SubFerretDirectory = {
      leadOf: async () => await Promise.reject(new Error('directory down')),
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(broken, 'lead', 'child');

    // Assert
    should(found).be.false();
  });

  it('should find an ancestor through a chain of leads', async () => {
    // Act
    const found = await isAncestorOf(DIRECTORY, 'lead', 'grandchild');

    // Assert
    should(found).be.true();
  });
});

describe('isSubFerret', () => {
  it('should be true for a session another session started', async () => {
    should(await isSubFerret(DIRECTORY, 'child')).be.true();
  });

  it('should be false for a lead, and for a session the directory cannot place', async () => {
    // Arrange
    const broken: SubFerretDirectory = {
      leadOf: async () => await Promise.reject(new Error('directory down')),
      addressOf: async sessionId => sessionId,
    };

    // Assert
    should(await isSubFerret(DIRECTORY, 'stranger')).be.false();
    should(await isSubFerret(broken, 'child')).be.false();
  });
});

describe('subFerretRefusal', () => {
  it('should send a refused sub-ferret to its lead by the lead callsign', async () => {
    // Act
    const refusal = await subFerretRefusal(DIRECTORY, 'child', 'raise an agenda item', 'read the agenda');

    // Assert
    should(refusal).equal(
      `You are a sub-ferret, so you can't raise an agenda item. You may read the agenda. For anything else ask your lead: fy send lizzette "…"`,
    );
  });

  it('should send the caller to the claim command when its lead holds the card', async () => {
    // Act
    const refusal = await subFerretRefusal(DIRECTORY, 'child', 'move this card', undefined, 'fy task claim &F12');

    // Assert
    should(refusal).startWith("You are a sub-ferret, so you can't move this card. You may note on,");
    should(refusal).endWith('Your lead holds this card: claim it first: fy task claim &F12');
  });

  it('should fall back to the lead id when the lead has no address', async () => {
    // Arrange
    const noAddress: SubFerretDirectory = {
      leadOf: async () => 'lead-id',
      addressOf: async () => await Promise.reject(new Error('no callsign')),
    };

    // Act
    const refusal = await subFerretRefusal(noAddress, 'child', 'x', 'y');

    // Assert
    should(refusal).containEql('fy send lead-id "…"');
  });

  it('should refuse nothing for a lead, or when the directory cannot answer', async () => {
    // Arrange
    const broken: SubFerretDirectory = {
      leadOf: async () => await Promise.reject(new Error('directory down')),
      addressOf: async sessionId => sessionId,
    };

    // Assert
    should(await subFerretRefusal(DIRECTORY, 'stranger', 'x')).be.null();
    should(await subFerretRefusal(broken, 'child', 'x')).be.null();
  });
});

describe('NO_SUB_FERRETS', () => {
  it('should treat every session as a lead, addressed by its id', async () => {
    should(await NO_SUB_FERRETS.leadOf('any')).be.undefined();
    should(await NO_SUB_FERRETS.addressOf('any')).equal('any');
  });
});

describe('a directory that can say its lineage is unreadable', () => {
  it('should refuse, saying the lineage cannot be read, rather than let an unplaced ferret through', async () => {
    // Arrange
    const unreadable: SubFerretDirectory = {
      leadOf: async () => undefined,
      addressOf: async sessionId => sessionId,
      readable: async () => false,
    };

    // Act
    const refusal = await subFerretRefusal(unreadable, 'stranger', 'raise agenda items');

    // Assert
    should(refusal).startWith("You can't raise agenda items just now");
    should(refusal).containEql('cannot be read');
  });

  it('should refuse nothing when the lineage is readable and the caller is a lead', async () => {
    // Arrange
    const readable: SubFerretDirectory = { ...DIRECTORY, readable: async () => true };

    // Assert
    should(await subFerretRefusal(readable, 'stranger', 'x')).be.null();
  });
});

describe('a lineage that is readable once and gone on the next read', () => {
  const FLAKY_REFUSAL = "You can't raise agenda items just now";

  it('should refuse, not grant lead authority, when the second leadOf read rejects', async () => {
    // Arrange: first read finds the parent, every later read rejects (the provider went away between the two checks).
    let reads = 0;
    const flaky: SubFerretDirectory = {
      leadOf: async () => {
        reads += 1;
        if (reads > 1) throw new Error('ferrets went away');
        return 'lead';
      },
      addressOf: async sessionId => sessionId,
      // The probe is itself a lookup whose answer is discarded (as the adapter did before lineage()).
      readable: async sessionId => (await flaky.leadOf(sessionId), true),
    };

    // Act
    const refusal = await subFerretRefusal(flaky, 'child', 'raise agenda items');

    // Assert
    should(refusal).startWith(FLAKY_REFUSAL);
    should(refusal).containEql('cannot be read');
  });

  it('should read the lineage once and reuse that answer for the readability and the lead', async () => {
    // Arrange
    let reads = 0;
    const once: SubFerretDirectory = {
      leadOf: async () => {
        throw new Error('a directory that answers lineage() is not asked leadOf() again');
      },
      addressOf: async sessionId => (sessionId === 'lead' ? 'lizzette' : sessionId),
      lineage: async () => {
        reads += 1;
        return { readable: true, lead: 'lead' };
      },
    };

    // Act
    const refusal = await subFerretRefusal(once, 'child', 'raise agenda items', 'read the agenda');

    // Assert
    should(reads).equal(1);
    should(refusal).containEql('fy send lizzette');
  });

  it('should refuse when the single lineage read rejects or says it is unreadable', async () => {
    // Arrange
    const rejecting: SubFerretDirectory = {
      ...DIRECTORY,
      lineage: async () => Promise.reject(new Error('down')),
    };
    const unreadable: SubFerretDirectory = { ...DIRECTORY, lineage: async () => ({ readable: false }) };

    // Assert
    should(await subFerretRefusal(rejecting, 'child', 'raise agenda items')).startWith(FLAKY_REFUSAL);
    should(await subFerretRefusal(unreadable, 'child', 'raise agenda items')).startWith(FLAKY_REFUSAL);
  });

  it('should refuse nothing when the single lineage read says the caller is a lead', async () => {
    // Arrange
    const lead: SubFerretDirectory = { ...DIRECTORY, lineage: async () => ({ readable: true, lead: undefined }) };

    // Assert
    should(await subFerretRefusal(lead, 'stranger', 'x')).be.null();
  });
});

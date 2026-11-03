import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import { CredentialAgentIdentities, type CredentialedSession } from '../../../../src/lib/agent-tools/policy.ts';
import { secretsMatch } from '../../../../src/lib/api/authentication.ts';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function credentialed(id: string, capability: string, active = true): CredentialedSession {
  return { id, name: null, active, sessionCapabilityHash: digest(capability) };
}

/** Mutable documents stand in for the source; the lookup must prove them again on EVERY hit. */
function harness(...records: CredentialedSession[]) {
  const scans: string[][] = [];
  const reads: string[] = [];
  const compared: (readonly [string, string])[] = [];
  const byDigest = new Map<string, string | null>();
  let configWrites = 0;
  const subject = new CredentialAgentIdentities(
    {
      snapshot: async () => {
        scans.push(records.map(record => record.id));
        return records.slice();
      },
      session: async id => {
        reads.push(id);
        return records.find(record => record.id === id);
      },
    },
    digest,
    (left, right) => {
      compared.push([left, right]);
      return secretsMatch(left, right);
    },
    byDigest,
    () => String(configWrites),
  );
  /** A configuration write, as the daemon's storage counts it. */
  const wrote = () => {
    configWrites += 1;
  };
  return { subject, records, scans, reads, compared, byDigest, wrote };
}

describe('CredentialAgentIdentities digest lookup', () => {
  it('should prove a known credential by reading only its session, using its current name', async () => {
    // Arrange — the first scan remembers the entire fleet, including credentials not yet presented.
    const { subject, records, scans, reads, compared } = harness(
      credentialed('first', 'alpha'),
      credentialed('second', 'beta'),
      credentialed('third', 'gamma'),
    );
    await subject.resolve('alpha');
    records[1] = { ...credentialed('second', 'beta'), name: 'New task', teammate: 'marin' };
    compared.length = 0;

    // Act
    const actual = await subject.resolve('beta');

    // Assert — the map locates the session; the constant-time matcher still decides acceptance.
    should(actual).deepEqual({ sessionId: 'second', name: 'Marin' });
    should(scans).deepEqual([['first', 'second', 'third']]);
    should(reads).deepEqual(['second']);
    should(compared).deepEqual([[digest('beta'), digest('beta')]]);
  });

  for (const change of ['ended', 'removed', 'rotated'] as const) {
    it(`should refuse a cached credential immediately when its session is ${change}`, async () => {
      // Arrange
      const { subject, records, scans, reads } = harness(credentialed('first', 'alpha'));
      should(await subject.resolve('alpha')).deepEqual({ sessionId: 'first' });
      if (change === 'removed') records.splice(0);
      else records[0] = credentialed('first', change === 'rotated' ? 'fresh' : 'alpha', change !== 'ended');

      // Act
      const actual = await subject.resolve('alpha');

      // Assert — failed fresh proof falls back to a scan, never to the remembered identity.
      should(actual).be.undefined();
      should(reads).deepEqual(['first']);
      should(scans).have.length(2);
      if (change === 'rotated') should(await subject.resolve('fresh')).deepEqual({ sessionId: 'first' });
    });
  }

  it('should scan on every unknown credential without retaining the bogus digests', async () => {
    // Arrange
    const { subject, byDigest, scans, reads } = harness(credentialed('first', 'alpha'));
    await subject.resolve('alpha');

    // Act
    const actual = await Promise.all(Array.from({ length: 12 }, (_, index) => subject.resolve(`bogus-${index}`)));

    // Assert — memory is bounded by the fleet, not by requests, including concurrent misses.
    should(actual.every(identity => identity === undefined)).be.true();
    should(scans).have.length(13);
    should(reads).be.empty();
    should([...byDigest]).deepEqual([[digest('alpha'), 'first']]);
  });

  it('should find a new session on a miss and discard digests absent from the new snapshot', async () => {
    // Arrange
    const { subject, records, scans, reads, byDigest } = harness(credentialed('first', 'alpha'));
    await subject.resolve('alpha');
    records.splice(0, 1, credentialed('new', 'beta'));

    // Act
    const actual = await subject.resolve('beta');
    const cached = await subject.resolve('beta');

    // Assert
    should(actual).deepEqual({ sessionId: 'new' });
    should(cached).deepEqual(actual);
    should(scans).have.length(2);
    should(reads).deepEqual(['new']);
    should([...byDigest]).deepEqual([[digest('beta'), 'new']]);
  });

  it('should scan ambiguous digests in snapshot order, even when an earlier inactive holder revives', async () => {
    // Arrange
    const { subject, records, scans, reads, byDigest } = harness(
      credentialed('earlier', 'shared', false),
      credentialed('later', 'shared'),
    );
    should(await subject.resolve('shared')).deepEqual({ sessionId: 'later' });
    should(byDigest.get(digest('shared'))).be.null();
    records[0] = credentialed('earlier', 'shared');

    // Act
    const actual = await subject.resolve('shared');

    // Assert
    should(actual).deepEqual({ sessionId: 'earlier' });
    should(scans).have.length(2);
    should(reads).be.empty();
  });

  it('should answer a rotation that makes a digest shared exactly as a fresh full scan does', async () => {
    // Arrange — warm the map while the digests are distinct, so 'later' is the remembered holder of H2.
    const { subject, records, scans, reads, wrote } = harness(
      credentialed('earlier', 'h1'),
      credentialed('later', 'h2'),
    );
    should(await subject.resolve('h2')).deepEqual({ sessionId: 'later' });
    records[0] = credentialed('earlier', 'h2');
    wrote();
    const fresh = new CredentialAgentIdentities(
      { snapshot: async () => records.slice(), session: async id => records.find(record => record.id === id) },
      digest,
      secretsMatch,
      new Map(),
      () => '',
    );
    reads.length = 0;

    // Act
    const actual = await subject.resolve('h2');

    // Assert — the first active holder in snapshot order wins, not the remembered one.
    should(await fresh.resolve('h2')).deepEqual({ sessionId: 'earlier' });
    should(actual).deepEqual({ sessionId: 'earlier' });
    should(scans).have.length(2);
    should(reads).be.empty();
  });

  it('should trust a remembered location only while no configuration has been written since the scan', async () => {
    // Arrange
    const { subject, scans, reads, wrote } = harness(credentialed('first', 'alpha'));
    await subject.resolve('alpha');
    await subject.resolve('alpha');
    should(scans).have.length(1);
    should(reads).deepEqual(['first']);

    // Act
    wrote();
    const actual = await subject.resolve('alpha');

    // Assert — a write discards every remembered location, so it is a scan again.
    should(actual).deepEqual({ sessionId: 'first' });
    should(scans).have.length(2);
  });

  it('should refuse a digest-map hit when the injected matcher refuses its freshly read hash', async () => {
    // Arrange — map equality must never replace the constant-time acceptance check.
    const record = credentialed('first', 'alpha');
    const compared: (readonly [string, string])[] = [];
    const subject = new CredentialAgentIdentities(
      { snapshot: async () => [record], session: async () => record },
      digest,
      (left, right) => {
        compared.push([left, right]);
        return false;
      },
      new Map(),
      () => '',
    );
    await subject.resolve('alpha');
    compared.length = 0;

    // Act
    const actual = await subject.resolve('alpha');

    // Assert — both the narrow proof and the fallback scan went through the matcher.
    should(actual).be.undefined();
    should(compared).deepEqual([
      [digest('alpha'), digest('alpha')],
      [digest('alpha'), digest('alpha')],
    ]);
  });
});

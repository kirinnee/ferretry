import { describe, it } from 'bun:test';
import should from 'should';
import type { AccountHealthHead } from '../../../src/lib/fleet-health/head.ts';
import { ACCOUNT_HEALTH_FILE, FileSystemAccountHealthStore } from '../../../src/lib/fleet-health/store.ts';

const NOW = 1_786_000_000_000;
const FILE = `/state/fleet/${ACCOUNT_HEALTH_FILE}`;
const RESPONSE_FINGERPRINT = {
  status: 401,
  contentType: 'application/json',
  headerNames: ['content-type'],
  bodyLength: 42,
  bodySha256: 'e'.repeat(64),
  json: { type: 'object' as const, fields: [{ path: 'error.type', type: 'string' as const }] },
};

const head = (patch: Partial<AccountHealthHead> = {}): AccountHealthHead =>
  ({
    accountId: 'acct',
    kind: 'claude',
    verdict: 'healthy',
    reason: 'provider_accepted',
    evidence: 'anthropic_usage',
    lastCheckedAt: NOW,
    verdictAt: NOW,
    lastCheckInconclusive: false,
    fingerprint: 'aaa',
    responseFingerprint: RESPONSE_FINGERPRINT,
    ...patch,
  }) as AccountHealthHead;

/** An in-memory filing surface satisfying exactly the two port methods the store consumes. */
const files = (seed?: string) => {
  const written = new Map<string, string>();
  if (seed !== undefined) written.set(FILE, seed);
  return {
    port: {
      readText: async (path: string) => written.get(path),
      writeTextAtomic: async (path: string, text: string) => {
        written.set(path, text);
      },
    },
    text: () => written.get(FILE),
  };
};

describe('FileSystemAccountHealthStore', () => {
  it('round-trips the heads through the injected port', async () => {
    // Arrange
    const surface = files();
    const store = new FileSystemAccountHealthStore(surface.port, FILE);

    // Act
    await store.write([head()]);

    // Assert
    should(await store.read()).deepEqual([head()]);
    should(surface.text()).endWith('\n');
  });

  it('reads an absent document as no heads', async () => {
    // Arrange — a daemon that has never observed anything, which is the first-boot case.
    // Act / Assert
    should(await new FileSystemAccountHealthStore(files().port, FILE).read()).be.empty();
  });

  it('discards a damaged document rather than refusing to serve health', async () => {
    // Arrange — a torn write, a hand edit, or a document from a build with a different shape. These
    // rows are disposable derived evidence: every account publishes as never-checked and the next
    // free pass repopulates them, which is strictly better than taking a surface down over a cache.
    for (const text of ['not json at all', '{}', '{"accounts":[{"accountId":""}]}', '{"accounts":42}', 'null']) {
      should(await new FileSystemAccountHealthStore(files(text).port, FILE).read()).be.empty();
    }
  });

  it('refuses to write a head the schema rejects', async () => {
    // Arrange — the schema is the enforcement that no secret can travel in this document, so a write
    // that bypassed it would be the one place a field could appear unvalidated.
    const store = new FileSystemAccountHealthStore(files().port, FILE);

    // Act / Assert
    await should(store.write([{ ...head(), verdict: 'wat' } as unknown as AccountHealthHead])).be.rejected();
  });

  it('propagates a write failure instead of silently dropping it', async () => {
    // Arrange — a store that swallowed writes would look exactly like a store whose verdicts never
    // change. The one place that knows a failed health write must not fail the quota read it rode in
    // on is the caller, so the decision belongs there.
    const store = new FileSystemAccountHealthStore(
      {
        readText: async () => undefined,
        writeTextAtomic: async () => {
          throw new Error('the disk is full');
        },
      },
      FILE,
    );

    // Act / Assert
    await should(store.write([head()])).be.rejectedWith(/the disk is full/u);
  });

  it('stores only codes, instants, the credential digest and the secret-safe response fingerprint', async () => {
    // Arrange
    const surface = files();

    // Act
    await new FileSystemAccountHealthStore(surface.port, FILE).write([head()]);

    // Assert — the whole document, field by field. A new field on the head is a deliberate decision
    // about what this daemon keeps about somebody's account, and it should fail here first.
    should(Object.keys(JSON.parse(surface.text() ?? '{}').accounts[0]).sort()).deepEqual([
      'accountId',
      'evidence',
      'fingerprint',
      'kind',
      'lastCheckInconclusive',
      'lastCheckedAt',
      'reason',
      'responseFingerprint',
      'verdict',
      'verdictAt',
    ]);
  });
});

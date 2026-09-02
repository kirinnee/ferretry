/**
 * Seed provenance — the record, the comparison, and the ONE claim it is allowed to make.
 *
 * The most consequential case in this file is not a comparison at all: it is that
 * `harnessRefreshRotation('claude')` answers `unproven`. Nothing in this repository proves that
 * Claude's refresh tokens rotate; single-use rotation is established for Codex only. A test that let
 * that flip would let two surfaces start asserting a measurement nobody has taken, on somebody's own
 * login, in the one report they are reading to decide whether to renew it.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetSeedResult } from '../../src/lib/credential-seed.ts';
import type { FleetManifestAccount } from '../../src/lib/manifest.ts';
import {
  decideSeedProvenance,
  FleetSeedProvenanceDocumentSchema,
  type FleetSeedProvenanceRecord,
  FleetSeedProvenanceRecorder,
  type FleetSeedProvenanceStore,
  harnessRefreshRotation,
  mergeSeedProvenanceRecords,
  SEED_PROVENANCE_FILE,
  SEED_PROVENANCE_VERSION,
} from '../../src/lib/seed-provenance.ts';

const SEEDED_AT = 1_786_000_000_000;
const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

const record = (patch: Partial<FleetSeedProvenanceRecord> = {}): FleetSeedProvenanceRecord => ({
  accountId: ID_ONE,
  kind: 'claude',
  seededFrom: 'host:claude',
  donorHome: '/home/me/.claude',
  seedFingerprint: 'aaaa',
  seededAt: SEEDED_AT,
  ...patch,
});

const account = (id: string, kind: 'claude' | 'codex' = 'claude'): FleetManifestAccount =>
  ({
    id,
    kind,
    mode: 'auto',
    wrapper: `/fleet/bin/${kind}-${id}`,
    home: `/fleet/homes/${id}`,
    displayName: id,
    defaultModel: null,
    models: [],
    available: true,
    unavailableReason: null,
  }) as unknown as FleetManifestAccount;

const seeded = (id: string, kind: 'claude' | 'codex', donorHome: string): FleetSeedResult => ({
  account: `${kind}-${id}`,
  accountId: id,
  kind,
  outcome: { kind: 'seeded', donorHome },
});

/** A store that remembers what it was handed, so a write can be asserted rather than assumed. */
const memoryStore = () => {
  let records: readonly FleetSeedProvenanceRecord[] = [];
  const writes: (readonly FleetSeedProvenanceRecord[])[] = [];
  const store: FleetSeedProvenanceStore = {
    read: async () => records,
    write: async next => {
      writes.push([...next]);
      records = [...next];
    },
  };
  return { store, writes, current: () => records };
};

describe('harnessRefreshRotation', () => {
  it('refuses to claim that Claude rotates its refresh tokens', () => {
    // Assert — THE honesty constraint. The evidence for Claude is that a REPLACEMENT refresh token is
    // stored, which is not the same claim as the old one being invalidated. Nobody has measured that,
    // so every sentence built on this stays conditional.
    should(harnessRefreshRotation('claude')).equal('unproven');
  });

  it('states single-use rotation for Codex, which is established', () => {
    // Assert — Codex's rotation is the reason `health.ts` publishes `codex_liveness_unproven` rather
    // than refreshing to measure liveness. It is safe to say flatly.
    should(harnessRefreshRotation('codex')).equal('single_use');
  });

  it('stays unproven for a harness this build does not recognise', () => {
    // Assert — fail-open toward the WEAKER claim. Inventing a rotation claim about an unknown
    // provider is the same overstatement the Claude row exists to prevent.
    should(harnessRefreshRotation('gemini')).equal('unproven');
  });
});

describe('decideSeedProvenance', () => {
  it('says nothing at all about an account with no record', () => {
    // Assert — absence of a record is NOT evidence of an own login. A home seeded before this shipped
    // has no record and can never get one, so silence is the only honest answer.
    should(decideSeedProvenance(undefined, 'aaaa')).be.undefined();
  });

  it('reports a home still holding the bytes it was seeded with', () => {
    // Assert
    should(decideSeedProvenance(record(), 'aaaa')).deepEqual({
      state: 'seeded_copy',
      donorHome: '/home/me/.claude',
      seededAt: SEEDED_AT,
      rotation: 'unproven',
    });
  });

  it('reports a home whose harness has since rewritten its credential as its own', () => {
    // Assert — the digest moved, so this home has been rewritten at least once since it was copied.
    // That is the only definition of ownership observable without reading material.
    should(decideSeedProvenance(record(), 'bbbb')?.state).equal('own_login');
  });

  it('fails closed when there is no current digest to compare', () => {
    // Assert — a locked keychain or a missing home discloses a risk that may not exist, rather than
    // staying quiet about one that does. The other direction spends somebody's login.
    should(decideSeedProvenance(record(), undefined)?.state).equal('undetermined');
  });

  it('carries the rotation claim of the harness the record was written for', () => {
    // Assert — read from the RECORD's kind rather than from a caller's opinion, so a Codex row cannot
    // be rendered with Claude's conditional or the other way round.
    should(decideSeedProvenance(record({ kind: 'codex' }), 'aaaa')?.rotation).equal('single_use');
  });

  it('never compares against a donor: only the recorded digest decides', () => {
    // Assert — the trap this design exists to avoid. If the DONOR rotates first, a live comparison
    // concludes "this home has its own credential" about the home holding the DEAD copy. Here the
    // same current digest yields the same verdict whatever any donor now holds, because no donor is
    // an input at all.
    const stillSeeded = decideSeedProvenance(record({ seedFingerprint: 'aaaa' }), 'aaaa');
    should(stillSeeded?.state).equal('seeded_copy');
    should(Object.keys(stillSeeded ?? {})).not.containEql('donorFingerprint');
  });
});

describe('mergeSeedProvenanceRecords', () => {
  it('replaces a record for an account rather than keeping both', () => {
    // Act
    const merged = mergeSeedProvenanceRecords(
      [record({ seedFingerprint: 'old' })],
      [record({ seedFingerprint: 'new' })],
    );

    // Assert — two digests for one home would leave no rule for which is current.
    should(merged).have.length(1);
    should(merged[0]?.seedFingerprint).equal('new');
  });

  it('keeps records for accounts this seed said nothing about', () => {
    // Assert — a second boot that seeds one new account must not delete what the first recorded.
    const merged = mergeSeedProvenanceRecords([record({ accountId: ID_TWO })], [record({ accountId: ID_ONE })]);
    should(merged.map(row => row.accountId)).deepEqual([ID_ONE, ID_TWO]);
  });
});

describe('the persisted document', () => {
  it('names the file once, so a writer and a reader cannot disagree', () => {
    // Assert
    should(SEED_PROVENANCE_FILE).equal('seed-provenance.json');
  });

  it('carries a version, because a record it cannot parse is a fact permanently lost', () => {
    // Assert — unlike the health head, which is disposable derived evidence rebuilt every minute.
    const parsed = FleetSeedProvenanceDocumentSchema.parse({
      version: SEED_PROVENANCE_VERSION,
      accounts: [record()],
    });
    should(parsed.version).equal(1);
    should(parsed.accounts).have.length(1);
  });

  it('refuses a document from a version this build does not own', () => {
    // Assert — recognised rather than guessed at. The reader turns this into "no records".
    should(FleetSeedProvenanceDocumentSchema.safeParse({ version: 2, accounts: [] }).success).be.false();
  });

  it('refuses a record with no digest to compare against', () => {
    // Assert — a record whose digest could never match anything would report every later reading as
    // an own login, which is the one direction this must not fail in.
    should(
      FleetSeedProvenanceDocumentSchema.safeParse({
        version: SEED_PROVENANCE_VERSION,
        accounts: [{ ...record(), seedFingerprint: '' }],
      }).success,
    ).be.false();
  });
});

describe('FleetSeedProvenanceRecorder', () => {
  const recorder = (parts: {
    readonly store: FleetSeedProvenanceStore;
    readonly digests: Record<string, string | undefined>;
    readonly reads?: string[];
  }) =>
    new FleetSeedProvenanceRecorder({
      store: parts.store,
      digests: {
        classify: async subject => {
          parts.reads?.push(subject.id);
          const fingerprint = parts.digests[subject.id];
          return fingerprint === undefined ? {} : { fingerprint };
        },
      },
      now: () => SEEDED_AT,
    });

  it('records the digest of the COPY, read back from the home the seed just wrote', async () => {
    // Arrange
    const memory = memoryStore();
    const reads: string[] = [];

    // Act
    const written = await recorder({ store: memory.store, digests: { [ID_ONE]: 'copy-digest' }, reads }).record({
      accounts: [account(ID_ONE)],
      results: [seeded(ID_ONE, 'claude', '/home/me/.claude')],
    });

    // Assert — the SEEDED HOME is what was read, not the donor. On macOS a seed is a keychain
    // read-and-rewrite, so the bytes written are not necessarily the bytes read: digesting the donor
    // would make every seeded Mac account read as already-rotated on its first check.
    should(reads).deepEqual([ID_ONE]);
    should(written).deepEqual([
      {
        accountId: ID_ONE,
        kind: 'claude',
        seededFrom: 'host:claude',
        donorHome: '/home/me/.claude',
        seedFingerprint: 'copy-digest',
        seededAt: SEEDED_AT,
      },
    ]);
    should(memory.current()).deepEqual(written);
  });

  it('reads back nothing for an account the seed did not write', async () => {
    // Arrange — `kept`, `refused`, `no-donor` and `failed` all leave a home this never copied into.
    const memory = memoryStore();
    const reads: string[] = [];

    // Act
    const written = await recorder({ store: memory.store, digests: { [ID_ONE]: 'x' }, reads }).record({
      accounts: [account(ID_ONE)],
      results: [{ account: 'claude-default', accountId: ID_ONE, kind: 'claude', outcome: { kind: 'kept' } }],
    });

    // Assert — no read, no record, and no write at all. There is no copy to be a copy of.
    should(reads).be.empty();
    should(written).be.empty();
    should(memory.writes).be.empty();
  });

  it('skips an account whose copy could not be read back rather than recording a placeholder', async () => {
    // Arrange — the read-back yields no digest.
    const memory = memoryStore();

    // Act
    const written = await recorder({ store: memory.store, digests: { [ID_ONE]: undefined } }).record({
      accounts: [account(ID_ONE)],
      results: [seeded(ID_ONE, 'claude', '/home/me/.claude')],
    });

    // Assert — a record with a digest that can never match would report this home as an OWN login
    // forever, on the strength of a read that failed. Saying nothing is the honest failure.
    should(written).be.empty();
    should(memory.writes).be.empty();
  });

  it('ignores a result whose account is not among the ones it was given', async () => {
    // Arrange — a caller that passed a mismatched pair. There is no home to read.
    const memory = memoryStore();

    // Act
    const written = await recorder({ store: memory.store, digests: { [ID_TWO]: 'x' } }).record({
      accounts: [account(ID_TWO)],
      results: [seeded(ID_ONE, 'claude', '/home/me/.claude')],
    });

    // Assert
    should(written).be.empty();
  });

  it('states the donor as the harness rather than as an account somebody could go looking for', async () => {
    // Arrange
    const memory = memoryStore();

    // Act
    const written = await recorder({ store: memory.store, digests: { [ID_TWO]: 'd' } }).record({
      accounts: [account(ID_TWO, 'codex')],
      results: [seeded(ID_TWO, 'codex', '/home/me/.codex')],
    });

    // Assert — `host:codex` is what `hostHarnessInstall` mints, and it is deliberately not a uuid.
    should(written[0]?.seededFrom).equal('host:codex');
  });

  it('folds onto what a previous seed recorded rather than replacing the document', async () => {
    // Arrange — a host seeded once already.
    const memory = memoryStore();
    await memory.store.write([record({ accountId: ID_TWO, kind: 'codex', seededFrom: 'host:codex' })]);

    // Act
    await recorder({ store: memory.store, digests: { [ID_ONE]: 'fresh' } }).record({
      accounts: [account(ID_ONE)],
      results: [seeded(ID_ONE, 'claude', '/home/me/.claude')],
    });

    // Assert — both survive. A boot that seeds one new account must not delete the disclosure for
    // every account the last one seeded.
    should(memory.current().map(row => row.accountId)).deepEqual([ID_ONE, ID_TWO]);
  });
});

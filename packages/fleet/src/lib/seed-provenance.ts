/**
 * WHETHER AN ACCOUNT IS STILL HOLDING THE COPY A FIRST RUN TOOK FROM THIS HOST — and saying so.
 *
 * `./credential-seed.ts` copies this host's own harness login into the homes a boot just created, and
 * it closes by naming two consequences it calls "properties a person has to be told about": a spent
 * refresh token is indistinguishable from a live one, and the donor sits outside every identity so
 * nothing repairs it. Until this module, nothing told them. This is the telling, and it is ALL this
 * module does: it records a digest, compares one home against its own past, and publishes a verdict.
 * It refuses nothing, gates nothing and changes no decision, so it cannot break a working fleet.
 *
 * ## THE HONESTY CONSTRAINT, AND IT IS THE POINT OF THE `rotation` FIELD
 *
 * **Nothing in this repository proves that CLAUDE's refresh tokens rotate.** Single-use rotation is
 * established for Codex — `./token-refresh.ts` and `./health.ts` both reason from it, and Codex's own
 * refresh is why no liveness probe exists for it. For Claude the evidence is that a replacement
 * refresh token is STORED, which is not the same claim as the old one being invalidated. Nobody has
 * measured that, and this module does not measure it either: no call is made here, to anybody.
 *
 * So a sentence about Claude has to be CONDITIONAL — "if Claude rotates refresh tokens, renewing this
 * may sign that install out" — and a sentence about Codex may be flat. Two surfaces render this (a
 * terminal and a browser), each owning its own words, which is two places a copy-editing pass could
 * flatten "may" into "will" and assert a measurement nobody took. {@link harnessRefreshRotation} is
 * what stops that: the CLAIM is a value published beside the verdict, decided once, here — and a
 * surface that hardened its wording would be contradicting a field on its own row.
 *
 * `unproven` is also the fail-open answer for a harness this build does not recognise, because
 * inventing a rotation claim about an unknown provider is exactly the overstatement above.
 *
 * ## THE COMPARISON, AND THE TRAP IN IT
 *
 * > Compare a home's CURRENT credential digest against its OWN recorded seed digest. Never against
 * > the donor's live credential.
 *
 * A live donor comparison inverts the verdict exactly when it matters. If the DONOR rotates first the
 * two digests differ, and a live comparison concludes "this home has its own credential" about the
 * home holding the DEAD copy. A recorded digest has no such failure mode: it is a statement about one
 * home across time rather than about two homes at one moment.
 *
 * ## WHAT IS DIGESTED, AND WHY IT IS THE COPY RATHER THAN THE DONOR
 *
 * The SEEDED HOME, read back right after the copy. On macOS a seed is a keychain read-and-rewrite
 * rather than a file copy, so the bytes written are not necessarily the bytes read — digesting the
 * DONOR would make every seeded Mac account read as "already rotated" on its first check, with a
 * file-copy-only test passing and proving nothing. Reading the copy back also leaves
 * `CredentialCloneOutcome` exactly as it is, which matters: no credential crosses that boundary, and
 * that is a property of the types rather than of anybody's care.
 *
 * A digest is not credential material. It is the same opaque, truncated SHA-256 the health head
 * already persists for a narrower job, compared for equality and used for nothing else, and it is
 * never logged, rendered or returned.
 *
 * ## ABSENCE OF A RECORD IS NOT EVIDENCE OF AN OWN LOGIN
 *
 * {@link decideSeedProvenance} answers `undefined` for an account with no record, and every surface
 * must render that as nothing said rather than as "this account owns its credential". A home seeded
 * before this shipped has no record and can never get one — the digest at seed time is gone — so the
 * hosts most likely to be affected today are exactly the ones this can say nothing about. That is a
 * declared gap, not an oversight.
 *
 * A home whose credential cannot be READ is `undetermined` and is disclosed as still-seeded, which is
 * fail-closed: it discloses a risk that may not exist rather than staying quiet about one that does.
 */
import { z } from 'zod';
import type { FleetSeedResult } from './credential-seed.ts';
import type { FleetManifestAccount } from './manifest.ts';

const epochMilliseconds = z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite number');

/** The document a boot writes its records into, beside the manifest and never inside it. */
export const SEED_PROVENANCE_FILE = 'seed-provenance.json';

/**
 * What is known about one harness's refresh tokens — a MEASUREMENT CLAIM, not a wording preference.
 *
 * `single_use` means this repository holds evidence that redeeming the refresh token invalidates it,
 * so every other copy of that blob is left holding a dead one. `unproven` means nobody has measured
 * it and a surface must stay conditional. See the module note; do not add a third value that means
 * "probably".
 */
export const HarnessRefreshRotationSchema = z.enum(['single_use', 'unproven']);
export type HarnessRefreshRotation = z.infer<typeof HarnessRefreshRotationSchema>;

/**
 * The one owner of that claim, keyed on the harness the fleet published.
 *
 * Codex is `single_use` because its rotation is the reason `./health.ts` publishes
 * `codex_liveness_unproven` rather than refreshing to measure liveness. Claude is `unproven`, and an
 * unrecognised harness is `unproven` too — a default that can only ever weaken a sentence.
 */
export function harnessRefreshRotation(kind: string): HarnessRefreshRotation {
  return kind === 'codex' ? 'single_use' : 'unproven';
}

/**
 * One seeded account's provenance, as the durable fact it is.
 *
 * `kind` is stored rather than re-derived from the manifest, so a record stays readable about an
 * account the fleet has since stopped publishing, and `donorHome` is stored because the directory is
 * the only thing a person can go and look at.
 *
 * `seededFrom` is the donor's own spelling — `host:claude` — which is what `hostHarnessInstall`
 * mints and is deliberately not an account id anybody could go looking for.
 */
export const FleetSeedProvenanceRecordSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  seededFrom: z.string().min(1),
  donorHome: z.string().min(1),
  /** The opaque digest of what this home held immediately after the copy. Never material. */
  seedFingerprint: z.string().min(1),
  seededAt: epochMilliseconds,
});
export type FleetSeedProvenanceRecord = z.infer<typeof FleetSeedProvenanceRecordSchema>;

/**
 * The whole persisted document, and it HAS a version where the health head deliberately does not.
 *
 * The health head is disposable: every row can be re-established for free by a pass that already
 * runs. A provenance record cannot be re-established at all — the digest at seed time is gone the
 * moment the seed returns — so a shape this build cannot parse is a fact permanently lost, and the
 * version is what lets a later build recognise its own document rather than guess at one.
 */
export const SEED_PROVENANCE_VERSION = 1;
export const FleetSeedProvenanceDocumentSchema = z.strictObject({
  version: z.literal(SEED_PROVENANCE_VERSION),
  accounts: z.array(FleetSeedProvenanceRecordSchema),
});
export type FleetSeedProvenanceDocument = z.infer<typeof FleetSeedProvenanceDocumentSchema>;

/**
 * What the comparison yielded, as three readings a surface says three different things about.
 *
 * There is no `unknown` member, and that is deliberate: "no record" is the ABSENCE of this value, so
 * a surface cannot accidentally render it as a reading. See the module note.
 */
export const FleetSeedProvenanceStateSchema = z.enum(['seeded_copy', 'own_login', 'undetermined']);
export type FleetSeedProvenanceState = z.infer<typeof FleetSeedProvenanceStateSchema>;

/**
 * One account's published provenance: the reading, what it is about, and what may be claimed of it.
 *
 * `rotation` travels WITH the reading rather than being re-derived by each surface, because it is the
 * measurement claim rather than a rendering detail — see the module note.
 */
export const FleetAccountSeedProvenanceSchema = z.strictObject({
  state: FleetSeedProvenanceStateSchema,
  /** The absolute directory the login was copied from, so somebody can go and check it. */
  donorHome: z.string().min(1),
  seededAt: epochMilliseconds,
  rotation: HarnessRefreshRotationSchema,
});
export type FleetAccountSeedProvenance = z.infer<typeof FleetAccountSeedProvenanceSchema>;

/**
 * Read a home's current digest against its own record.
 *
 * PURE, TOTAL, AND IT DECIDES NOTHING ELSE. It never reaches a donor, never reads material and never
 * produces a verdict any other part of the system branches on.
 *
 * `undefined` in, `undefined` out: an account with no record has nothing said about it. A record with
 * no current digest — the home is missing or could not be read — is `undetermined`, which every
 * surface discloses as still-seeded.
 */
export function decideSeedProvenance(
  record: FleetSeedProvenanceRecord | undefined,
  fingerprint: string | undefined,
): FleetAccountSeedProvenance | undefined {
  if (record === undefined) return undefined;
  const state: FleetSeedProvenanceState =
    fingerprint === undefined ? 'undetermined' : fingerprint === record.seedFingerprint ? 'seeded_copy' : 'own_login';
  return {
    state,
    donorHome: record.donorHome,
    seededAt: record.seededAt,
    rotation: harnessRefreshRotation(record.kind),
  };
}

/** Durable storage for the records. Read-all / write-all: the document is one small row per seed. */
export interface FleetSeedProvenanceStore {
  /** Every stored record. A document this build cannot parse reads as none, never as an error. */
  read(): Promise<readonly FleetSeedProvenanceRecord[]>;
  write(records: readonly FleetSeedProvenanceRecord[]): Promise<void>;
}

/**
 * Fold fresh records over stored ones, REPLACING by account rather than appending.
 *
 * A second seed of one account is a new fact about that home, not a second fact — keeping both would
 * leave two digests and no rule for which is current. Ordered by account id so a re-write of an
 * unchanged fleet produces an identical document.
 */
export function mergeSeedProvenanceRecords(
  stored: readonly FleetSeedProvenanceRecord[],
  fresh: readonly FleetSeedProvenanceRecord[],
): readonly FleetSeedProvenanceRecord[] {
  const merged = new Map(stored.map(record => [record.accountId, record]));
  for (const record of fresh) merged.set(record.accountId, record);
  return [...merged.values()].sort((left, right) => left.accountId.localeCompare(right.accountId));
}

/**
 * Reading back one seeded home's digest.
 *
 * STRUCTURAL rather than the health classifier's own interface, so this module needs nothing from
 * `./health.ts` and `./health.ts` can import the record type from here without a cycle. The platform
 * classifier satisfies it as it stands; a state is deliberately not part of the shape, because the
 * only question here is whether there is a digest to record.
 */
export interface SeedCredentialDigestReader {
  classify(account: FleetManifestAccount): Promise<{ readonly fingerprint?: string }>;
}

export interface FleetSeedProvenanceRecorderDeps {
  readonly store: FleetSeedProvenanceStore;
  readonly digests: SeedCredentialDigestReader;
  readonly now: () => number;
}

/**
 * Record what a first run just seeded, by reading each copy back.
 *
 * ONE EXTRA LOCAL READ PER SEEDED ACCOUNT, on a boot that already does two, and only for the accounts
 * the seed actually wrote. Nothing is read for an account that was kept, refused or failed — there is
 * no copy to be a copy of.
 *
 * A read-back that yields no digest is SKIPPED rather than recorded with a placeholder. A record
 * whose digest could never match anything would report every later reading as `own_login`, which is
 * the one direction this must not fail in: it would tell somebody their credential is their own on
 * the strength of a read that failed.
 */
export class FleetSeedProvenanceRecorder {
  constructor(private readonly deps: FleetSeedProvenanceRecorderDeps) {}

  async record(input: {
    /** The accounts a preparation added, so a result can be joined back to the home it wrote. */
    readonly accounts: readonly FleetManifestAccount[];
    readonly results: readonly FleetSeedResult[];
  }): Promise<readonly FleetSeedProvenanceRecord[]> {
    const accounts = new Map(input.accounts.map(account => [account.id, account]));
    const seededAt = Math.trunc(this.deps.now());
    const fresh: FleetSeedProvenanceRecord[] = [];
    for (const result of input.results) {
      if (result.outcome.kind !== 'seeded') continue;
      const account = accounts.get(result.accountId);
      if (account === undefined) continue;
      const fingerprint = (await this.deps.digests.classify(account)).fingerprint;
      if (fingerprint === undefined) continue;
      fresh.push({
        accountId: account.id,
        kind: result.kind,
        seededFrom: `host:${result.kind}`,
        donorHome: result.outcome.donorHome,
        seedFingerprint: fingerprint,
        seededAt,
      });
    }
    if (fresh.length === 0) return [];
    const records = mergeSeedProvenanceRecords(await this.deps.store.read(), fresh);
    await this.deps.store.write(records);
    return fresh;
  }
}

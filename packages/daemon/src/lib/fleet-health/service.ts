/**
 * THE DAEMON'S ACCOUNT-HEALTH SERVICE: a persisted head per account, and no request of its own.
 *
 * ## Reading is free; checking is a side effect of a read somebody else was making
 *
 * {@link FleetAccountHealthService.snapshot} touches nothing but the store. It cannot check, cannot
 * dial and cannot spend, so `GET /v1/fleet/health` is safe to hydrate on page load and a restart
 * serves the last known verdicts immediately instead of an empty fleet.
 *
 * {@link FleetAccountHealthService.observe} is called with a usage snapshot the caller ALREADY
 * collected. That is the whole cadence design: the daemon's free quota pass runs on `usage.interval`
 * (one minute by default) and its one read-only `GET /api/oauth/usage` per credential is the same
 * request health needs, so health rides it and adds no provider call whatever. There is no health
 * timer, and this service has no way to arm one — it takes values.
 *
 * ## Why the whole roster is published, every time
 *
 * One row per manifest account, including accounts no observation has ever covered. An account
 * missing from the response would render as absent rather than as unknown, and "we have never checked
 * this" is exactly the fact the surfaces are being given so they can stop guessing.
 *
 * ## What is never stored
 *
 * Reason codes, verdicts, timestamps, one opaque credential digest and a secret-safe provider
 * response fingerprint. The response contributes status, bounded header metadata, body length/hash
 * and JSON key/type/error-code shape — never a body, token, authorization value or harness output.
 * `AccountHealthHeadSchema` is the enforcement: there is no free-form field a secret could travel in.
 */
import type {
  AccountHealthObservation,
  FleetConfig,
  FleetHealthSnapshot,
  FleetManifest,
  FleetUsageSnapshot,
} from '@ferretry/fleet';
import {
  type FleetCredentialClassifier,
  FleetHealthSnapshotSchema,
  type FleetSeedProvenanceStore,
  observeAccountHealth,
  readLocalCredentials,
  readSeedProvenance,
} from '@ferretry/fleet';
import { type AccountHealthHead, mergeAccountHealthHead, neverCheckedHead, projectAccountHealth } from './head.ts';

/**
 * Durable storage for the heads.
 *
 * Read-all / write-all rather than per-row, because the document is one small record per published
 * account and the writer is a single serialized pass. A per-row store would be a lock and a
 * transaction protecting a file the daemon rewrites in one go anyway.
 */
export interface AccountHealthStore {
  /** Every stored head. An unreadable or unrecognised document reads as no heads, never as an error. */
  read(): Promise<readonly AccountHealthHead[]>;
  write(heads: readonly AccountHealthHead[]): Promise<void>;
}

export interface FleetAccountHealthClock {
  now(): number;
}

export interface FleetAccountHealthParts {
  readonly store: AccountHealthStore;
  readonly credentials: FleetCredentialClassifier;
  readonly clock: FleetAccountHealthClock;
  /**
   * What this host's first run recorded about the homes it seeded.
   *
   * READ HERE RATHER THAN AT THE SNAPSHOT, because the comparison needs the credential digest and the
   * digest only exists where a classification happens — which is this pass and nowhere else.
   * {@link FleetAccountHealthService.snapshot} stays a pure store read that spends nothing and reads
   * no credential, which is what makes `GET /v1/fleet/health` safe to hydrate on page load.
   */
  readonly provenance: FleetSeedProvenanceStore;
}

export class FleetAccountHealthService {
  /**
   * A settled tail serializes observations.
   *
   * Two collections can overlap — the timer's pass and a person pressing the button — and both end
   * by rewriting the same document. Without this, the later read-modify-write silently discards the
   * earlier one's verdicts. Serializing is enough because the store is read inside the queued work
   * rather than before it.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly parts: FleetAccountHealthParts) {}

  /**
   * The published snapshot. A pure store read plus staleness; it checks nothing and writes nothing.
   *
   * The manifest decides the ROWS and the store decides their CONTENT, so an account that has been
   * removed from the fleet stops being published without its stored head having to be deleted first,
   * and an account that has just been added is published as never-checked rather than omitted.
   */
  async snapshot(manifest: FleetManifest): Promise<FleetHealthSnapshot> {
    const stored = new Map((await this.parts.store.read()).map(head => [head.accountId, head]));
    const at = this.#now();
    return FleetHealthSnapshotSchema.parse({
      at,
      accounts: [...manifest.accounts]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(account => projectAccountHealth(stored.get(account.id) ?? neverCheckedHead(account.id, account.kind), at)),
    });
  }

  /**
   * Record what the caller's free usage collection established.
   *
   * IT PROPAGATES A FAILURE, deliberately. Whether a failed health write matters is knowledge the
   * CALL SITE has and this service does not: see `MountedFleet.usage()`, where the quota feed, the
   * advisor and the warden are all waiting on the snapshot this rode in on and none of them asked
   * about health. A service that swallowed the failure here would be deciding, on its caller's
   * behalf, that nobody cares whether it failed — and it would leave the caller holding a `.catch()`
   * that can never fire, which is worse than no error handling at all because it reads like some.
   *
   * READ THE TWO AWAITS BELOW CAREFULLY; they are not interchangeable.
   *
   * `this.chain` KEEPS BOTH HANDLERS and is what the NEXT observation queues behind, so one failed
   * pass cannot poison every later one. The awaited expression is `queued` — the un-neutralised copy
   * — so this call's own failure reaches this call's own caller. Awaiting `this.chain` instead looks
   * identical and silently restores the dead-`catch` bug; awaiting `queued` but ALSO assigning it to
   * `this.chain` makes the first failure permanent.
   */
  async observe(input: {
    readonly manifest: FleetManifest;
    readonly config: FleetConfig;
    readonly usage: FleetUsageSnapshot;
  }): Promise<void> {
    const queued = this.chain.then(async () => await this.#record(input));
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  async #record(input: {
    readonly manifest: FleetManifest;
    readonly config: FleetConfig;
    readonly usage: FleetUsageSnapshot;
  }): Promise<void> {
    const [local, provenance] = await Promise.all([
      readLocalCredentials(input.manifest, this.parts.credentials),
      readSeedProvenance(this.parts.provenance),
    ]);
    const observations = observeAccountHealth({
      manifest: input.manifest,
      config: input.config,
      usage: input.usage,
      local,
      provenance,
      at: this.#now(),
    });
    // Read INSIDE the queued work, so a pass that started while another was writing still folds onto
    // what that one committed rather than onto the document as it looked before.
    const stored = new Map((await this.parts.store.read()).map(head => [head.accountId, head]));
    await this.parts.store.write(nextHeads(stored, observations));
  }

  #now(): number {
    const now = this.parts.clock.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('the fleet health clock did not return a valid instant');
    return Math.trunc(now);
  }
}

/**
 * Fold the observations in and drop heads for accounts the manifest no longer publishes.
 *
 * Dropping matters: a head kept for a deleted account is a verdict about something that does not
 * exist, and the file would grow by one row for every account anybody ever removed.
 */
function nextHeads(
  stored: ReadonlyMap<string, AccountHealthHead>,
  observations: readonly AccountHealthObservation[],
): readonly AccountHealthHead[] {
  return observations.map(observation => mergeAccountHealthHead(stored.get(observation.accountId), observation));
}

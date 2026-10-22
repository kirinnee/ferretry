/**
 * A credential's store, read as rarely as its facts allow (docs/design/housekeeping-worker.md §4, PR 1
 * (b) and (c)).
 *
 * The usage pass used to read every credential's material three times — a classification for the
 * digest, the probe's own read for the bearer token, and a classification again for the view — and the
 * credentials list read it a fourth time, with the second Codex read for its facts. On macOS each Claude
 * read is a `security` process. Nothing had changed between those reads.
 *
 * ## What is kept, and what never is
 *
 * KEPT: {@link LocalCredentialFacts} — presence flags, an expiry, Codex's `last_refresh`, its plan word
 * and display email, and the truncated digest `credentialFingerprint` takes. None of it is a token, and
 * none of it can be turned back into one (docs/secrets.md).
 *
 * NEVER KEPT: the material, or any token in it. This class never even sees it: it asks a
 * {@link CredentialStoreReads} for facts. {@link MaterialCredentialReads} is the one place material
 * exists — it reads the store, takes the facts, hands the material to the probe for the bearer, and drops
 * it, all inside one call — and the daemon runs it on its housekeeping worker, so the token is never in
 * the main thread's heap at all (housekeeping-worker.md §2.4). A token is never cached to save a read
 * (rule 7).
 *
 * ## When kept facts are answered
 *
 * - A **file** store (Claude on Linux, the macOS fallback file, every Codex `auth.json`): while the
 *   file's stamp — inode, size, change and modification times, of the link and of what it points at —
 *   is the one the facts were read under. The stamp is taken BEFORE the read, so a write that lands
 *   during it leaves a stamp that no longer matches, and the next call reads again.
 * - A **keychain** store (Claude on macOS): no stamp covers a keychain item, so its facts are kept for
 *   one usage interval — which is how often the usage pass read it anyway — and its fallback file's
 *   stamp must match too.
 * - Nothing is answered from a stamp that could not be taken, and a `fresh` read always reads.
 *
 * Every free read refreshes the kept facts for nothing, because it reads the material anyway.
 */

import type { BigIntStats } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import {
  type ActiveUsageRead,
  type CredentialReadOptions,
  type LocalCredentialFacts,
  localCredentialFacts,
} from '../lib/account/credential-status.ts';
import type { StoredCredentialResolution } from '../lib/account/credentials.ts';
import type { CredentialMaterial } from '../lib/identity.ts';
import type { FleetUsageProbeResult } from '../lib/usage.ts';
import { credentialFingerprint, type StoredCredentialMaterialReader } from './credential-classifier.ts';

/** One store's kept facts, and what makes them still true. */
export interface KeptCredentialFacts {
  /** The store file's stamp when the facts were read. */
  readonly stamp: string;
  /** When they were read, for a keychain store's interval. */
  readonly at: number;
  readonly facts: LocalCredentialFacts;
}

/** Where kept facts live, by store. A `Map` is one; a test passes its own to see everything ever kept. */
export interface CredentialFactsCache {
  get(store: string): KeptCredentialFacts | undefined;
  set(store: string, kept: KeptCredentialFacts): void;
}

/**
 * One read of a credential's store, answered as FACTS. Whoever implements it holds the material for the
 * length of one call and returns none of it: {@link MaterialCredentialReads} in-process, or the daemon's
 * housekeeping worker by job.
 */
export interface CredentialStoreReads {
  /** The store, read once, as facts. */
  facts(resolution: StoredCredentialResolution): Promise<LocalCredentialFacts>;
  /** The free read, with a token from ONE read of the store, and that read's facts. */
  active(resolution: StoredCredentialResolution): Promise<ActiveUsageRead>;
}

export interface MaterialCredentialReadsDeps {
  /** The one store read (`PlatformFleetCredentialStore.storedMaterial`). */
  readonly store: StoredCredentialMaterialReader;
  /**
   * The free read, made with material THIS class read. Adapter to adapter: the token is taken from it
   * inside the probe and goes nowhere else.
   */
  probe(resolution: StoredCredentialResolution, material: CredentialMaterial): Promise<FleetUsageProbeResult>;
}

/** What a free read answers when the probe itself threw: inconclusive, and no message kept. */
const INCONCLUSIVE: FleetUsageProbeResult = { usageBased: true, ok: false, credentialSignal: 'inconclusive' };

/**
 * THE ONE PLACE A CREDENTIAL'S MATERIAL EXISTS on the status path: read, reduced to facts or used for one
 * bearer, and dropped before the call returns. Nothing is kept between calls — no field, no closure.
 */
export class MaterialCredentialReads implements CredentialStoreReads {
  constructor(private readonly deps: MaterialCredentialReadsDeps) {}

  async facts(resolution: StoredCredentialResolution): Promise<LocalCredentialFacts> {
    return factsOf(resolution, await this.deps.store.storedMaterial(resolution));
  }

  async active(resolution: StoredCredentialResolution): Promise<ActiveUsageRead> {
    const material = await this.deps.store.storedMaterial(resolution);
    const local = factsOf(resolution, material);
    let result: FleetUsageProbeResult;
    try {
      result = await this.deps.probe(resolution, material);
    } catch {
      // A caught error's message could quote what it was handed. Nothing of it is kept.
      result = INCONCLUSIVE;
    }
    return { result, local };
  }
}

/** One read's material as facts, with the digest of what was found. The material is not kept. */
function factsOf(resolution: StoredCredentialResolution, material: CredentialMaterial): LocalCredentialFacts {
  return localCredentialFacts(
    resolution.harness,
    material,
    // Only material that was actually found has a digest (see `credentialFingerprint`).
    material.outcome === 'found' ? credentialFingerprint(material.blob) : undefined,
  );
}

export interface CachedCredentialReadsDeps {
  /** The store, read as facts. */
  readonly reads: CredentialStoreReads;
  /** A file's stamp ({@link credentialFileStamp}): `undefined` when it cannot be taken. */
  stamp(path: string): Promise<string | undefined>;
  /** Whether a Claude login is read from the macOS keychain first, which no file stamp covers. */
  readonly keychain: boolean;
  /** How long a keychain store's facts are kept: one usage interval, read when asked. */
  keychainFreshMs(): number;
  now(): number;
  readonly cache: CredentialFactsCache;
}

/** The store a resolution names, as a key. Two credentials naming one store share its facts. */
function storeKey(resolution: StoredCredentialResolution): string {
  return resolution.harness === 'claude'
    ? `claude\u0000${resolution.secureStorage}\u0000${resolution.credentialFile}`
    : `codex\u0000${resolution.canonicalFile}`;
}

/** The file whose stamp says the store may have changed. */
const storeFile = (resolution: StoredCredentialResolution): string =>
  resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;

/** The `CredentialStatusPorts.local` and `.activeUsage` of the account model, over one platform store. */
export class CachedCredentialReads {
  constructor(private readonly deps: CachedCredentialReadsDeps) {}

  /** The store's facts: kept ones while they are still true, else one read. Never material. */
  async local(
    resolution: StoredCredentialResolution,
    options: CredentialReadOptions = {},
  ): Promise<LocalCredentialFacts> {
    const stamp = await this.deps.stamp(storeFile(resolution));
    if (options.fresh !== true && stamp !== undefined) {
      const kept = this.deps.cache.get(storeKey(resolution));
      if (kept !== undefined && kept.stamp === stamp && this.#inInterval(resolution, kept)) return kept.facts;
    }
    return this.#keep(resolution, stamp, await this.deps.reads.facts(resolution));
  }

  /**
   * The free read, from ONE read of the store: its facts are kept and returned with the answer, and its
   * digest is of the very material whose token was sent.
   */
  async active(resolution: StoredCredentialResolution): Promise<ActiveUsageRead> {
    const stamp = await this.deps.stamp(storeFile(resolution));
    const read = await this.deps.reads.active(resolution);
    return { result: read.result, local: this.#keep(resolution, stamp, read.local) };
  }

  /** A keychain store's facts age out after one interval; a file store's only change with the file. */
  #inInterval(resolution: StoredCredentialResolution, kept: KeptCredentialFacts): boolean {
    if (resolution.harness !== 'claude' || !this.deps.keychain) return true;
    const age = this.deps.now() - kept.at;
    return age >= 0 && age < this.deps.keychainFreshMs();
  }

  #keep(
    resolution: StoredCredentialResolution,
    stamp: string | undefined,
    facts: LocalCredentialFacts,
  ): LocalCredentialFacts {
    if (stamp !== undefined) this.deps.cache.set(storeKey(resolution), { stamp, at: this.deps.now(), facts });
    return facts;
  }
}

const describeStats = (stats: BigIntStats): string =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

/** `null` for a path that is not there, `undefined` for one that could not be looked at. */
async function statOf(look: () => Promise<BigIntStats>): Promise<BigIntStats | null | undefined> {
  try {
    return await look();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

/**
 * A credential file's stamp: whatever could change when its bytes do. The link itself and what it
 * points at, each by device, inode, size and both times to the nanosecond — an atomic save is a new
 * inode, an in-place one a new change time. A file that is not there has a stamp too (`absent`), so
 * its appearing is a change. `undefined` when the file could not be looked at, which keeps nothing.
 *
 * Metadata only: the file is never opened here, and nothing in a stamp says anything about its content.
 */
export async function credentialFileStamp(path: string): Promise<string | undefined> {
  const link = await statOf(async () => await lstat(path, { bigint: true }));
  if (link === undefined) return undefined;
  if (link === null) return 'absent';
  if (!link.isSymbolicLink()) return describeStats(link);
  const target = await statOf(async () => await stat(path, { bigint: true }));
  if (target === undefined) return undefined;
  return `${describeStats(link)}>${target === null ? 'dangling' : describeStats(target)}`;
}

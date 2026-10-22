/**
 * The credential status service's store reads, BY JOB (docs/design/housekeeping-worker.md §2.1, §2.2).
 *
 * What stays here, on the main thread, is everything that lasts: the facts kept per store and the stamps
 * that say they still hold (`CachedCredentialReads`) — and, in the service itself, the per-credential
 * flight and the status heads. What goes to the housekeeping worker is the work: reading a store, and the
 * free usage read with its token. A store that has not changed is answered from its kept facts and no job
 * is sent at all. Passive readings are the fleet reading's (`lib/fleet-reading`), which watches them.
 */
import type {
  ActiveUsageRead,
  CredentialReadOptions,
  CredentialStatusPorts,
  LocalCredentialFacts,
  StoredCredentialResolution,
} from '@ferretry/fleet';
import { CachedCredentialReads, type CredentialFactsCache } from '@ferretry/fleet/adapters';
import type { HousekeepingJobs } from '../../lib/housekeeping/ports.ts';

export interface WorkerCredentialPortsDeps {
  /** Where the jobs run: the worker, or the main thread. */
  readonly jobs: HousekeepingJobs;
  /**
   * A store file's stamp: a store whose stamp held is not read again. The fleet reading's, which answers
   * from its live watch without a system call, or `credentialFileStamp`.
   */
  stamp(path: string): Promise<string | undefined>;
  /** Whether a Claude login is read from the macOS keychain first, which no file stamp covers. */
  readonly keychain: boolean;
  /** How long a keychain store's facts are kept: one usage interval. */
  keychainFreshMs(): number;
  now(): number;
  readonly cache: CredentialFactsCache;
}

/** `CredentialStatusPorts.local` and `.activeUsage`, answered by housekeeping jobs. */
export class WorkerCredentialPorts implements Pick<CredentialStatusPorts, 'local' | 'activeUsage'> {
  readonly #reads: CachedCredentialReads;

  constructor(deps: WorkerCredentialPortsDeps) {
    const { jobs } = deps;
    this.#reads = new CachedCredentialReads({
      reads: {
        facts: async resolution => await jobs.run({ kind: 'credential.local', resolution }),
        active: async resolution => await jobs.run({ kind: 'credential.active', resolution }),
      },
      stamp: deps.stamp,
      keychain: deps.keychain,
      keychainFreshMs: deps.keychainFreshMs,
      now: deps.now,
      cache: deps.cache,
    });
  }

  async local(resolution: StoredCredentialResolution, options?: CredentialReadOptions): Promise<LocalCredentialFacts> {
    return await this.#reads.local(resolution, options);
  }

  async activeUsage(resolution: StoredCredentialResolution): Promise<ActiveUsageRead> {
    return await this.#reads.active(resolution);
  }
}

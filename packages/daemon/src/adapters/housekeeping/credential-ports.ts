/**
 * The credential status service's reads, BY JOB (docs/design/housekeeping-worker.md §2.1, §2.2).
 *
 * What stays here, on the main thread, is everything that lasts: the facts kept per store and the file
 * stamps that say they still hold (`CachedCredentialReads`), the attribution of Codex rollouts from the
 * session index, and — in the service itself — the per-credential flight and the status heads. What
 * goes to the housekeeping worker is the work: reading a store, the free usage read with its token,
 * the passive usage file and the rollout tails. A store that has not changed is answered from its kept
 * facts and no job is sent at all.
 */
import type {
  ActiveUsageRead,
  CredentialReadOptions,
  CredentialStatusPorts,
  CredentialSubject,
  LocalCredentialFacts,
  PassiveUsageRecord,
  StoredCredentialResolution,
} from '@ferretry/fleet';
import { CachedCredentialReads, type CredentialFactsCache } from '@ferretry/fleet/adapters';
import { type CredentialPassiveUsageDeps, credentialPassiveUsage } from '../../lib/fleet/credentials-service.ts';
import type { HousekeepingJobs } from '../../lib/housekeeping/ports.ts';

export interface WorkerCredentialPortsDeps {
  /** Where the jobs run: the worker, or the main thread. */
  readonly jobs: HousekeepingJobs;
  /** A store file's stamp (`credentialFileStamp`): a store whose stamp held is not read again. */
  stamp(path: string): Promise<string | undefined>;
  /** Whether a Claude login is read from the macOS keychain first, which no file stamp covers. */
  readonly keychain: boolean;
  /** How long a keychain store's facts are kept: one usage interval. */
  keychainFreshMs(): number;
  now(): number;
  readonly cache: CredentialFactsCache;
  /** Which runtimes use each credential, for Codex rollout attribution. */
  readonly catalog: CredentialPassiveUsageDeps['catalog'];
  /** The sessions this daemon has records for, from its index. */
  sessions: CredentialPassiveUsageDeps['sessions'];
}

/** `CredentialStatusPorts.local`, `.activeUsage` and `.passiveUsage`, answered by housekeeping jobs. */
export class WorkerCredentialPorts implements Pick<CredentialStatusPorts, 'local' | 'activeUsage' | 'passiveUsage'> {
  readonly #reads: CachedCredentialReads;
  readonly #passive: (subject: CredentialSubject) => Promise<PassiveUsageRecord | undefined>;

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
    this.#passive = credentialPassiveUsage({
      catalog: deps.catalog,
      sessions: deps.sessions,
      claude: async credential => (await jobs.run({ kind: 'usage.passive.claude', credential })) ?? undefined,
      newestRollout: async files => (await jobs.run({ kind: 'usage.passive.codex', files })) ?? undefined,
    });
  }

  async local(resolution: StoredCredentialResolution, options?: CredentialReadOptions): Promise<LocalCredentialFacts> {
    return await this.#reads.local(resolution, options);
  }

  async activeUsage(resolution: StoredCredentialResolution): Promise<ActiveUsageRead> {
    return await this.#reads.active(resolution);
  }

  async passiveUsage(subject: CredentialSubject): Promise<PassiveUsageRecord | undefined> {
    return await this.#passive(subject);
  }
}

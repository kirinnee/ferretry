/**
 * ONE HOUSEKEEPING JOB, RUN — the same code on the housekeeping worker and, when the worker is switched
 * off or retired, on the main thread (docs/design/housekeeping-worker.md §2.1, §2.5).
 *
 * Because both places run exactly this, moving a job to the worker changes WHERE it runs and never WHAT
 * it concludes. The ports are built per job over this host — the platform credential store, the two free
 * usage probes, the passive usage file, the rollout reader and the Codex rollout index — each counting what
 * it spends, so the worker can say what one job cost (its `metrics` message) where main's instruments
 * cannot see.
 *
 * Material exists only inside {@link MaterialCredentialReads}, for one call: a job answers facts.
 *
 * THE ONE THING KEPT BETWEEN JOBS is the Codex rollout index the host passes in: what each rollout and
 * directory of a home was found to be, so a walk stats and reads only what changed (#693, #697). It is a
 * cache, not state — a thread that crashed or ended starts with an empty one, and its first walk reads
 * the home afresh and answers exactly what a warm one would.
 */
import type { PassiveUsageRecord } from '@ferretry/fleet';
import {
  AnthropicUsageProbe,
  CodexUsageProbe,
  type CredentialCommand,
  type CredentialStoreReads,
  FilePassiveUsageStore,
  fetchQuota,
  MaterialCredentialReads,
  newestRolloutRateLimits,
  PlatformFleetCredentialStore,
  type QuotaFetch,
  SpawnCredentialCommand,
} from '@ferretry/fleet/credential-worker';
import type {
  HousekeepingChild,
  HousekeepingJob,
  HousekeepingJobValues,
  HousekeepingSettings,
} from '../../lib/housekeeping/protocol.ts';
import { rolloutFiles } from '../fleet-credentials/credential-facts.ts';
import { NodeCodexRolloutIndex } from '../session/transcript/node-codex-rollout-index.ts';

/** What a job needs from this host. */
export interface HousekeepingJobPorts {
  readonly reads: CredentialStoreReads;
  passiveClaude(credential: string): Promise<PassiveUsageRecord | undefined>;
  newestRollout(files: readonly string[]): Promise<PassiveUsageRecord | undefined>;
  discover(
    home: string,
    correlationToken: string,
    skip: readonly string[],
  ): Promise<HousekeepingJobValues['codex.discover']>;
}

/** Runs one job over `ports`. Total over the job kinds; a port that throws is the caller's to refuse. */
export async function runHousekeepingJob<J extends HousekeepingJob>(
  ports: HousekeepingJobPorts,
  job: J,
): Promise<HousekeepingJobValues[J['kind']]> {
  const value = await answer(ports, job);
  return value as HousekeepingJobValues[J['kind']];
}

async function answer(
  ports: HousekeepingJobPorts,
  job: HousekeepingJob,
): Promise<HousekeepingJobValues[HousekeepingJob['kind']]> {
  switch (job.kind) {
    case 'credential.local':
      return await ports.reads.facts(job.resolution);
    case 'credential.active':
      return await ports.reads.active(job.resolution);
    case 'usage.passive.claude':
      return (await ports.passiveClaude(job.credential)) ?? null;
    case 'usage.passive.codex':
      return (await ports.newestRollout(job.files)) ?? null;
    case 'codex.discover':
      return await ports.discover(job.home, job.correlationToken, job.skip);
  }
}

/** What one job spent, as its ports counted it. */
export class HousekeepingCounters {
  readonly children: HousekeepingChild[] = [];
  fileReads = 0;
  fetches = 0;
}

/** `security` answered with a login: the store does not go on to read the fallback file. */
const keychainAnswered = (code: number, stdout: string): boolean => code === 0 && stdout.trim().length > 0;

/**
 * The real ports over this host for ONE job, counting into `counters`. Cheap to build — no handle is
 * opened until a port is called — so each job gets its own and no count leaks between two jobs that
 * overlap.
 */
/** What a host's ports run on: its clock, how it runs a keychain command, and the rollout index it keeps. */
export interface HostHousekeepingOptions {
  readonly now?: () => number;
  readonly command?: CredentialCommand;
  /** The host's one Codex rollout index, kept across jobs; without one a walk starts cold every time. */
  readonly rollouts?: NodeCodexRolloutIndex;
}

export function hostHousekeepingPorts(
  settings: HousekeepingSettings,
  counters: HousekeepingCounters,
  {
    now = Date.now,
    command: spawn = new SpawnCredentialCommand(),
    rollouts = new NodeCodexRolloutIndex(),
  }: HostHousekeepingOptions = {},
): HousekeepingJobPorts {
  let keychainHadLogin = false;
  const command: CredentialCommand = {
    run: async (argv, timeoutMs, stdin) => {
      const started = now();
      const result = await spawn.run(argv, timeoutMs, stdin);
      counters.children.push({ argv: [...argv], wallMs: Math.max(0, now() - started) });
      keychainHadLogin = keychainAnswered(result.code, result.stdout);
      return result;
    },
  };
  const store = new PlatformFleetCredentialStore({
    platform: settings.platform,
    command,
    now,
    keychainAccount: settings.keychainAccount,
    defaultClaudeHome: settings.defaultClaudeHome,
  });
  const fetch: QuotaFetch = async request => {
    counters.fetches += 1;
    return await fetchQuota(request);
  };
  const urls = settings.probeUrls;
  const timeout = settings.usageTimeoutMs === undefined ? {} : { timeoutMs: settings.usageTimeoutMs };
  const anthropic = new AnthropicUsageProbe({
    fetch,
    credentials: store,
    ...timeout,
    ...(urls === undefined ? {} : { url: urls.anthropic }),
  });
  const codex = new CodexUsageProbe({
    fetch,
    stored: store,
    now,
    ...timeout,
    ...(urls === undefined ? {} : { url: urls.codex }),
  });
  const reads = new MaterialCredentialReads({
    store: {
      storedMaterial: async resolution => {
        keychainHadLogin = false;
        const material = await store.storedMaterial(resolution);
        // A Claude login on a Mac is read from the keychain first, and from its file only when the
        // keychain held none; every other store is its one file.
        const viaKeychain = resolution.harness === 'claude' && settings.platform === 'darwin';
        if (!viaKeychain || !keychainHadLogin) counters.fileReads += 1;
        return material;
      },
    },
    probe: async (resolution, material) =>
      resolution.harness === 'claude' ? await anthropic.probeMaterial(material) : await codex.probeMaterial(material),
  });
  const passive = new FilePassiveUsageStore(settings.fleetRoot);
  return {
    reads,
    passiveClaude: async credential => {
      counters.fileReads += 1;
      return await passive.read(credential);
    },
    newestRollout: async files => {
      // `newestRolloutRateLimits`' own order — newest first, and the first file with a reading answers —
      // one file at a time, so the count is of the files actually opened.
      const ordered = [...(await rolloutFiles(files))].sort((left, right) => right.modifiedAt - left.modifiedAt);
      for (const file of ordered) {
        counters.fileReads += 1;
        const reading = await newestRolloutRateLimits([file]);
        if (reading !== undefined) return reading;
      }
      return undefined;
    },
    discover: async (home, correlationToken, skip) => {
      // Two jobs on one thread may share a walk, so each counts what the index did while it ran: a
      // shared walk is counted by both, which is what each of them waited on.
      const [changes, opened] = [rollouts.changes(home), rollouts.opened];
      try {
        const candidates = await rollouts.candidates(home, correlationToken, new Set(skip));
        return { candidates, changed: rollouts.changes(home) - changes, frontier: rollouts.frontier(home) };
      } finally {
        counters.fileReads += rollouts.opened - opened;
      }
    },
  };
}

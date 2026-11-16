import type { FetchPort } from '@ferretry/kernel/contract';
import { latestReleaseApiUrl, parseGitHubLatestRelease } from '../../contract/index.ts';
import type { LatestReleaseAnswer, LatestReleaseSource } from '../lib/ports.ts';

/** How long the latest-release question may take before the answer is "could not reach GitHub". */
const RELEASE_CHECK_TIMEOUT_MS = 10_000;

export interface GitHubLatestReleaseOptions {
  readonly timeoutMs?: number;
  /** Sent as `User-Agent`, which the GitHub API requires: `<daemon>/<version>`. */
  readonly userAgent: string;
}

/**
 * ONE HTTP READ: what is the latest published release?
 *
 * A version compare only — nothing is downloaded here. `no-store` because a cached answer is an update nobody hears
 * about. It never throws and never retries: every failure is one plain sentence, and the domain keeps the last good
 * answer beside it.
 */
export class GitHubLatestRelease implements LatestReleaseSource {
  private readonly timeoutMs: number;

  constructor(
    private readonly product: string,
    private readonly network: FetchPort,
    private readonly options: GitHubLatestReleaseOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? RELEASE_CHECK_TIMEOUT_MS;
  }

  async latest(): Promise<LatestReleaseAnswer> {
    let response: Response;
    try {
      response = await this.network.request(latestReleaseApiUrl(this.product), {
        cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', 'user-agent': this.options.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'failed', reason: 'could not reach GitHub' };
    }
    if (!response.ok) return { kind: 'failed', reason: `GitHub answered ${String(response.status)}` };
    const release = parseGitHubLatestRelease(await response.json().catch(() => undefined));
    return release === undefined
      ? { kind: 'failed', reason: 'GitHub did not name a published release' }
      : { kind: 'ok', release };
  }
}

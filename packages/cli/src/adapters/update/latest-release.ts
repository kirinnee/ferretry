import { latestReleaseApiUrl, parseGitHubLatestRelease } from '@ferretry/protocol';
import type { ILatestReleasePort, LatestReleaseAnswer } from '../../lib/update/ports.ts';

/** The narrow slice of `fetch` a release read needs, injected so no suite dials out. */
export type ReleaseFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubLatestReleaseOptions {
  readonly fetcher?: ReleaseFetch;
  readonly timeoutMs?: number;
}

const RELEASE_TIMEOUT_MS = 15_000;

/**
 * The latest published release, asked of the GitHub releases API — the release GoReleaser publishes.
 *
 * It never throws: every failure is one `failed` sentence, because `fy daemon update` reports it and
 * stops, and `--check` prints it beside what it does know.
 */
export class GitHubLatestRelease implements ILatestReleasePort {
  private readonly fetcher: ReleaseFetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly product: string,
    options: GitHubLatestReleaseOptions = {},
  ) {
    // Wrapped rather than stored bare, so the builtin is never invoked with this object as receiver.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? RELEASE_TIMEOUT_MS;
  }

  async latest(): Promise<LatestReleaseAnswer> {
    let response: Response;
    try {
      response = await this.fetcher(latestReleaseApiUrl(this.product), {
        headers: { accept: 'application/vnd.github+json', 'user-agent': this.product },
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'failed', reason: 'could not reach GitHub' };
    }
    if (!response.ok) return { kind: 'failed', reason: `GitHub answered ${String(response.status)}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'failed', reason: 'GitHub answered something that is not JSON' };
    }
    const release = parseGitHubLatestRelease(body);
    if (release === undefined) return { kind: 'failed', reason: 'GitHub named no published release' };
    return { kind: 'found', release };
  }
}

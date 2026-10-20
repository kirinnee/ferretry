import {
  latestReleaseApiUrl,
  parseGitHubLatestRelease,
  parseGitHubNewestTag,
  releaseTagsApiUrl,
} from '@ferretry/protocol';
import type { ILatestReleasePort, LatestReleaseAnswer } from '../../lib/update/ports.ts';

/** The narrow slice of `fetch` a release read needs, injected so no suite dials out. */
export type ReleaseFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubLatestReleaseOptions {
  readonly fetcher?: ReleaseFetch;
  readonly timeoutMs?: number;
}

const RELEASE_TIMEOUT_MS = 15_000;

/**
 * The latest published release, asked of the GitHub releases API — the release GoReleaser publishes —
 * and the newest tag, asked of the tags API.
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
    const body = await this.#read(latestReleaseApiUrl(this.product));
    if ('failed' in body) return { kind: 'failed', reason: body.failed };
    const release = parseGitHubLatestRelease(body.json);
    if (release === undefined) return { kind: 'failed', reason: 'GitHub named no published release' };
    return { kind: 'found', release };
  }

  async newestTag(): Promise<LatestReleaseAnswer> {
    const body = await this.#read(releaseTagsApiUrl(this.product));
    if ('failed' in body) return { kind: 'failed', reason: body.failed };
    const release = parseGitHubNewestTag(this.product, body.json);
    if (release === undefined) return { kind: 'failed', reason: 'GitHub named no release tag' };
    return { kind: 'found', release };
  }

  async #read(url: string): Promise<{ readonly json: unknown } | { readonly failed: string }> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': this.product },
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { failed: 'could not reach GitHub' };
    }
    if (!response.ok) return { failed: `GitHub answered ${String(response.status)}` };
    try {
      return { json: await response.json() };
    } catch {
      return { failed: 'GitHub answered something that is not JSON' };
    }
  }
}

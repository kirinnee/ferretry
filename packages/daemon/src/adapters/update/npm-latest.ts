import { HARNESS_PACKAGES, type Harness, npmLatestUrl, parseNpmLatest } from '@ferretry/protocol';
import type { HarnessLatestSource, LatestReleaseAnswer } from '../../lib/index.ts';
import type { ReleaseFetch } from './github-releases.ts';

/** How long the newest-version question may take before the answer is "could not reach npm". */
const NPM_CHECK_TIMEOUT_MS = 10_000;

export interface NpmHarnessLatestOptions {
  readonly fetcher?: ReleaseFetch;
  readonly timeoutMs?: number;
  readonly userAgent: string;
}

/**
 * ONE HTTP READ: what is the newest published `claude` or `codex`? npm's `latest` dist-tag is where
 * both harnesses publish first; Homebrew and nixpkgs follow it, sometimes days later. A version compare
 * only — nothing is downloaded. It never throws and never retries.
 */
export class NpmHarnessLatest implements HarnessLatestSource {
  private readonly fetcher: ReleaseFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: NpmHarnessLatestOptions) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? NPM_CHECK_TIMEOUT_MS;
  }

  async latest(harness: Harness): Promise<LatestReleaseAnswer> {
    let response: Response;
    try {
      response = await this.fetcher(npmLatestUrl(HARNESS_PACKAGES[harness].npm), {
        cache: 'no-store',
        headers: { accept: 'application/json', 'user-agent': this.options.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'failed', reason: 'could not reach npm' };
    }
    if (!response.ok) return { kind: 'failed', reason: `npm answered ${String(response.status)}` };
    const release = parseNpmLatest(harness, await response.json().catch(() => undefined));
    return release === undefined
      ? { kind: 'failed', reason: 'npm did not name a stable version' }
      : { kind: 'ok', release };
  }
}

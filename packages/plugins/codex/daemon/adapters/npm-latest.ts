import type { Clock, FetchPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { type HarnessLatestSource, type LatestReleaseAnswer, NPM_LATEST_URL, parseNpmLatest } from '../lib/update/index.ts';

/** How long the newest-version question may take before the answer is 'could not reach npm'. */
const NPM_CHECK_TIMEOUT_MS = 10_000;

/**
 * ONE HTTP READ: what is the newest published `codex`? npm's `latest` dist-tag is where it publishes first; Homebrew and
 * nixpkgs follow it, sometimes days later. A version compare only — nothing is downloaded. It never throws and never
 * retries.
 */
export class NpmCodexLatest implements HarnessLatestSource {
  constructor(
    private readonly fetch: FetchPort,
    private readonly clock: Clock,
    private readonly userAgent: string,
    private readonly timeoutMs: number = NPM_CHECK_TIMEOUT_MS,
  ) {}

  async latest(): Promise<LatestReleaseAnswer> {
    const aborter = new AbortController();
    const cancel = this.clock.after(milliseconds(this.timeoutMs), () => aborter.abort());
    let response: Response;
    try {
      response = await this.fetch.request(NPM_LATEST_URL, {
        cache: 'no-store',
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        signal: aborter.signal,
      });
    } catch {
      return { kind: 'failed', reason: 'could not reach npm' };
    } finally {
      cancel();
    }
    if (!response.ok) return { kind: 'failed', reason: `npm answered ${String(response.status)}` };
    const release = parseNpmLatest(await response.json().catch(() => undefined));
    return release === undefined
      ? { kind: 'failed', reason: 'npm did not name a stable version' }
      : { kind: 'ok', release };
  }
}

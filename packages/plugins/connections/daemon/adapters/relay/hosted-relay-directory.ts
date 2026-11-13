/**
 * ONE HTTP READ: what carrier does Ferretry advertise today? (Asked at boot, and asked again in the
 * background while a failure was transient — see `lib/relay/directory-retry.ts`.)
 *
 * THE ORIGIN IS A BUILD CONSTANT AND THE CARRIER IS NOT. What a release may carry is the address of
 * the DIRECTORY — a service, never a daemon and never a person. The relay it names is a runtime
 * value that its operator can change or withdraw between this release and this boot, which is why
 * the answer is asked rather than assumed and why `cache: 'no-store'` is not optional: a cached
 * advertisement is the kill switch not working.
 *
 * IT NEVER THROWS, AND IT DOES NOT DECIDE WHETHER TO RETRY. Every failure — no origin, an origin that
 * is not an address this daemon may ask, a refusal, a timeout, a document in the wrong shape —
 * becomes one `undetermined` sentence, and the boot carries on direct-only and says so. This adapter
 * only REPORTS how the read ended; `classifyDirectoryOutcome` is the one place that sorts an ending
 * into transient (the network, a timeout, 5xx, 429 — asked again) or definitive (everything else —
 * never asked again). A daemon that failed to start because a discovery service was down would be a
 * worse product than one that cannot be reached remotely.
 */

import {
  classifyDirectoryOutcome,
  type DirectoryOutcome,
  RELAY_DISCOVERY_TIMEOUT_MS,
  type RelayAdvertisement,
  relayAdvertisementAddress,
  type RelayDirectoryPort,
} from '../../lib/relay/discovery.ts';

/** The narrow slice of `fetch` this read needs, injected so no suite dials out. */
export type RelayDirectoryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedRelayDirectoryOptions {
  readonly fetcher: RelayDirectoryFetch;
  readonly timeoutMs?: number;
}

export class HostedRelayDirectory implements RelayDirectoryPort {
  private readonly fetcher: RelayDirectoryFetch;
  private readonly timeoutMs: number;

  /**
   * @param origin The discovery origin this build carries, or `undefined` when it carries none —
   *   which is the state a local build, a fork, and a deploy that never configured one all ship in.
   */
  constructor(
    private readonly origin: string | undefined,
    options: HostedRelayDirectoryOptions,
  ) {
    // Wrapped rather than stored bare: a builtin kept as a value takes its holder as the receiver
    // when it is invoked as a member, which is a failure no injected-fetcher test can reproduce.
    this.fetcher = options.fetcher;
    this.timeoutMs = options.timeoutMs ?? RELAY_DISCOVERY_TIMEOUT_MS;
  }

  async read(signal?: AbortSignal): Promise<RelayAdvertisement> {
    return classifyDirectoryOutcome(await this.#outcome(signal));
  }

  async #outcome(signal: AbortSignal | undefined): Promise<DirectoryOutcome> {
    if (this.origin === undefined) return { kind: 'no-origin' };
    const address = relayAdvertisementAddress(this.origin);
    if (address === undefined) return { kind: 'refused-origin' };
    const deadline = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(address, {
        cache: 'no-store',
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
    } catch {
      return deadline.aborted ? { kind: 'timeout' } : { kind: 'unreachable' };
    }
    if (!response.ok)
      return { kind: 'status', status: response.status, retryAfter: response.headers.get('retry-after') };
    try {
      return { kind: 'document', value: await response.json() };
    } catch (error) {
      // A body that is not JSON is an answer; a body that broke on the wire is the network again.
      return error instanceof SyntaxError ? { kind: 'body-not-document' } : { kind: 'body-interrupted' };
    }
  }
}

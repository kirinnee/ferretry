/**
 * ONE HTTP READ, ONCE PER BOOT: what carrier does Ferretry advertise today?
 *
 * THE ORIGIN IS A BUILD CONSTANT AND THE CARRIER IS NOT. What a release may carry is the address of
 * the DIRECTORY — a service, never a daemon and never a person. The relay it names is a runtime
 * value that its operator can change or withdraw between this release and this boot, which is why
 * the answer is asked rather than assumed and why `cache: 'no-store'` is not optional: a cached
 * advertisement is the kill switch not working.
 *
 * IT NEVER THROWS AND IT NEVER RETRIES. Every failure — no origin, an origin that is not an address
 * this daemon may ask, a refusal, a timeout, a document in the wrong shape — becomes one
 * `undetermined` sentence, and the boot carries on direct-only and says so. A daemon that failed to
 * start because a discovery service was down would be a worse product than one that cannot be
 * reached remotely.
 */

import {
  NO_RELAY_DIRECTORY,
  parseRelayAdvertisement,
  RELAY_DISCOVERY_TIMEOUT_MS,
  type RelayAdvertisement,
  relayAdvertisementAddress,
  type RelayDirectoryPort,
} from '../../lib/relay/index.ts';

/** The narrow slice of `fetch` this read needs, injected so no suite dials out. */
export type RelayDirectoryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostedRelayDirectoryOptions {
  readonly fetcher?: RelayDirectoryFetch;
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
    options: HostedRelayDirectoryOptions = {},
  ) {
    // Wrapped rather than stored bare: a builtin kept as a value takes its holder as the receiver
    // when it is invoked as a member, which is a failure no injected-fetcher test can reproduce.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? RELAY_DISCOVERY_TIMEOUT_MS;
  }

  async read(): Promise<RelayAdvertisement> {
    if (this.origin === undefined) return NO_RELAY_DIRECTORY;
    const address = relayAdvertisementAddress(this.origin);
    if (address === undefined) {
      return { kind: 'undetermined', reason: 'the configured relay directory is not an address this daemon may ask' };
    }
    let response: Response;
    try {
      response = await this.fetcher(address, {
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: 'undetermined', reason: 'this daemon could not reach the relay directory' };
    }
    if (!response.ok) return { kind: 'undetermined', reason: `the relay directory answered ${response.status}` };
    try {
      return parseRelayAdvertisement(await response.json());
    } catch {
      return { kind: 'undetermined', reason: 'the relay directory answered something that is not a document' };
    }
  }
}

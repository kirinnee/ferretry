/**
 * Waiting for a REAL libdatachannel peer, and saying why when it does not come.
 *
 * A suite that waits for `onGatheringStateChange('complete')` or `channel.onOpen` as a promise has one
 * way to fail: the event never reaches its listener, and the test sits until the runner's 120 s timeout
 * with nothing to read. Every wait here is a CONDITION on the peer or channel itself (`isOpen()`, the
 * gathering state), polled by {@link waitFor}, so an event that a loaded runner delivered late — or that
 * the wrapper dropped — cannot hold a test hostage; and the failure names every state the peer went
 * through and when, so a connection that really never came says which step it stopped at.
 *
 * ONE LISTENER PER SLOT. node-datachannel keeps a single callback per peer event, so a test that wants
 * a state must read it from the watch rather than register a second listener that would replace it.
 */
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { waitFor } from './wait-for.ts';

/**
 * How long a loopback peer may take to gather or connect before the test calls it lost. A loopback
 * connection takes tens of milliseconds, and libdatachannel gives up on its own ICE after about 30 s, so
 * this is a bound on "never", not a budget to tune: well inside the runner's 120 s, so the failure reaches
 * the log with its explanation instead of as a bare timeout.
 */
const PEER_SETTLE_MS = 20_000;

/** How many fresh browser stand-ins a test may try before it calls the failure real. */
const OFFEROR_ATTEMPTS = 4;

/**
 * The test's own libdatachannel offerer had closed before it saw the answer.
 *
 * Non-trickle loopback signalling lets the daemon-side answerer start its connectivity checks the moment it
 * answers; on a loaded runner they reach the offerer before it has applied that answer, and (measured in CI,
 * about 1 run in 20) the offerer is already `closed` when the answer arrives, so applying it throws "Got a
 * remote candidate without ICE transport". A real browser holds its offer open until the answer comes, and
 * the daemon is the answerer, so this is a property of the stand-in, not of the product.
 */
class OfferorClosedEarly extends Error {}

/** Runs `attempt` with a fresh browser stand-in each time the previous one closed before the answer. */
export async function withFreshOfferor<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof OfferorClosedEarly) || tries >= OFFEROR_ATTEMPTS) throw error;
    }
  }
}

/** The states a peer reported, in order, with the milliseconds since it was watched. */
export class PeerWatch {
  readonly #peer: PeerConnection;
  readonly #name: string;
  readonly #started = performance.now();
  readonly #log: string[] = [];
  #gathered = false;

  constructor(name: string, peer: PeerConnection) {
    this.#name = name;
    this.#peer = peer;
    peer.onStateChange(state => this.#note(`connection ${state}`));
    peer.onIceStateChange(state => this.#note(`ice ${state}`));
    peer.onSignalingStateChange(state => this.#note(`signaling ${state}`));
    peer.onGatheringStateChange(state => {
      this.#note(`gathering ${state}`);
      if (state === 'complete') this.#gathered = true;
    });
  }

  #note(what: string): void {
    this.#log.push(`+${Math.round(performance.now() - this.#started)}ms ${what}`);
  }

  /** What this peer reported so far, for a failure message. */
  describe(): string {
    let now: string;
    try {
      now = `now: connection ${this.#peer.state()}, ice ${this.#peer.iceState()}, gathering ${this.#peer.gatheringState()}`;
    } catch {
      now = 'now: the peer is closed';
    }
    return `${this.#name} — ${now}; reported: ${this.#log.join(', ') || 'nothing'}`;
  }

  /** Applies the remote answer; a refusal carries the peer's history, because it says the peer was already closed. */
  answered(sdp: string): void {
    if (this.#peer.state() === 'closed')
      throw new OfferorClosedEarly(`the peer closed before the answer — ${this.describe()}`);
    try {
      this.#peer.setRemoteDescription(sdp, 'answer');
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${this.describe()}`);
    }
  }

  /** Resolves once the peer has finished gathering; fails with the peer's history when it never does. */
  async gathered(): Promise<void> {
    await this.#until(() => this.#gathered || this.#peer.gatheringState() === 'complete', 'to finish gathering');
  }

  /** Resolves once `channel` is open; fails at once if the peer failed, and with its history if it never opens. */
  async opened(channel: DataChannel, label: string): Promise<void> {
    let announced = false;
    channel.onOpen(() => {
      announced = true;
      this.#note(`channel ${label} open (event)`);
    });
    await this.#until(() => channel.isOpen(), `for the ${label} channel to open`);
    if (!announced) this.#note(`channel ${label} was open before its event arrived`);
  }

  async #until(condition: () => boolean, what: string): Promise<void> {
    try {
      await waitFor(
        () => {
          const state = this.#peer.state();
          if (state === 'failed' || state === 'closed') throw new Error(`the peer connection ${state}`);
          return condition();
        },
        `${this.#name} ${what}`,
        { within: PEER_SETTLE_MS },
      );
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} — ${this.describe()}`);
    }
  }
}

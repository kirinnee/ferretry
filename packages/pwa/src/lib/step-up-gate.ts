/**
 * WHEN A REQUEST NEEDS A PASSKEY, ASK ONCE AND RETRY IT (`docs/design/zero-trust.md` B1).
 *
 * The daemon refuses an act that needs a step-up with `403 grant_step_up_required`. The router then
 * asks this gate, which shows ONE prompt — however many requests are waiting on that machine — and
 * resolves every one of them when the person has confirmed, so each is sent again exactly once. A
 * dismissed prompt resolves them `false`, and each request returns the daemon's refusal unchanged.
 *
 * THE CEREMONY STARTS ON A TAP, NEVER ON ITS OWN. Safari refuses WebAuthn without a user gesture, and a
 * passkey sheet nobody asked for is precisely the prompt a person must learn to refuse — so the gate
 * only opens a prompt; `confirm` (the button) runs the ceremony.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. A verified step-up is a fact the DAEMON remembers about this copy of
 * the app; the browser holds nothing it could lose, replay or leak.
 */

import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

/** What the prompt shows: which machine is asking, and whether the last attempt failed and why. */
export interface StepUpPrompt {
  readonly daemon: DaemonConnection;
  readonly busy: boolean;
  /** One plain sentence for the person, or nothing. */
  readonly failure?: string;
}

export interface StepUpGateDependencies {
  /** Runs the whole ceremony for one machine: options, the passkey sheet, and the daemon's verdict. */
  readonly ceremony: (daemon: DaemonConnection) => Promise<void>;
  /** The sentence a person is shown for a ceremony that failed. Never a raw exception. */
  readonly describe: (reason: unknown) => string;
}

interface Waiting {
  readonly daemon: DaemonConnection;
  readonly resolvers: ((stepped: boolean) => void)[];
}

export class StepUpGate {
  readonly #listeners = new Set<() => void>();
  /** Machines with requests waiting, in the order they first asked. The first one is on screen. */
  readonly #waiting = new Map<DaemonId, Waiting>();
  #prompt: StepUpPrompt | null = null;

  constructor(private readonly deps: StepUpGateDependencies) {}

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The prompt on screen, or nothing. A stable object between changes, for `useSyncExternalStore`. */
  snapshot(): StepUpPrompt | null {
    return this.#prompt;
  }

  /**
   * Waits for a step-up on this machine. `true` when the person confirmed and the daemon accepted it;
   * `false` when they dismissed the prompt.
   */
  require(daemon: DaemonConnection): Promise<boolean> {
    return new Promise(resolve => {
      const waiting = this.#waiting.get(daemon.daemonId);
      if (waiting !== undefined) {
        waiting.resolvers.push(resolve);
        return;
      }
      this.#waiting.set(daemon.daemonId, { daemon, resolvers: [resolve] });
      if (this.#prompt === null) this.#show(daemon);
    });
  }

  /** The prompt's button: runs the ceremony for the machine on screen. */
  async confirm(): Promise<void> {
    const prompt = this.#prompt;
    if (prompt === null || prompt.busy) return;
    this.#set({ daemon: prompt.daemon, busy: true });
    try {
      await this.deps.ceremony(prompt.daemon);
    } catch (reason) {
      this.#set({ daemon: prompt.daemon, busy: false, failure: this.deps.describe(reason) });
      return;
    }
    this.#settle(prompt.daemon.daemonId, true);
  }

  /** The prompt's cancel: every request waiting on this machine returns its refusal. */
  dismiss(): void {
    const prompt = this.#prompt;
    if (prompt === null || prompt.busy) return;
    this.#settle(prompt.daemon.daemonId, false);
  }

  #settle(daemonId: DaemonId, stepped: boolean): void {
    const waiting = this.#waiting.get(daemonId);
    this.#waiting.delete(daemonId);
    for (const resolve of waiting?.resolvers ?? []) resolve(stepped);
    const next = this.#waiting.values().next();
    if (next.done === true) this.#set(null);
    else this.#show(next.value.daemon);
  }

  #show(daemon: DaemonConnection): void {
    this.#set({ daemon, busy: false });
  }

  #set(prompt: StepUpPrompt | null): void {
    this.#prompt = prompt;
    for (const listener of this.#listeners) listener();
  }
}

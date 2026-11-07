import type { ScriptedOriginsView } from './borrowed-grants.ts';

/**
 * WHERE PAGE SCRIPTS RAN ACROSS THE MACHINE, as Browsers tells Vault (lead DECISIONS-2 #5): the in-memory half of
 * today's `RuleSignInGrants` (`running`, `scriptedOn`, `scriptedOrigins`), copied. A page card's lock reads it in
 * `steerOf`: a script on the card's site, on a host that could not be read, or one running anywhere now, makes the
 * card `scripted` (I98). Memory only: a restart ends every script.
 *
 * GAP: today's `scriptedOn` also suspended every standing sign-in rule pinned to that host ON DISK, so planted storage
 * could not wait out a restart. Standing rules are Accounts' and no grant source is bound to Vault in 5.0, so there is
 * nothing to suspend yet; the RAM taint is kept.
 */
export class MachineScripts {
  /** Where a page script ran, by host, and when one ran where its origin couldn't be read: machine-wide, in RAM. */
  readonly #scripted = new Map<string, number>();
  #scriptedEverywhere: number | undefined;
  /** Agent scripts running now, anywhere on the machine. */
  #running = 0;

  constructor(private readonly now: () => number) {}

  scriptedOrigins(): ScriptedOriginsView {
    return {
      hosts: this.#scripted,
      ...(this.#scriptedEverywhere === undefined ? {} : { everywhere: this.#scriptedEverywhere }),
      ...(this.#running > 0 ? { running: true } : {}),
    };
  }

  /**
   * AN AGENT SCRIPT IS ABOUT TO RUN (any session's `browser_eval`): until the returned function is called, every page
   * counts as scripted. The page may move between the daemon's look and the script's world being made, so the origin
   * the script really runs in is known only once it answered; this closes that window.
   */
  running(): () => void {
    this.#running += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#running -= 1;
    };
  }

  /** A PAGE SCRIPT RAN on `host` (any session's `browser_eval`), or on a page whose origin couldn't be read. */
  scriptedOn(host: string | undefined): void {
    const now = this.now();
    if (host === undefined) this.#scriptedEverywhere = now;
    else this.#scripted.set(host, now);
  }
}

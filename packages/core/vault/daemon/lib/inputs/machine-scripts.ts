import type { ScriptedOriginsView } from './borrowed-grants.ts';

/** What the Vault keeps of where page scripts ran: the latest time per host, and when one ran on an unreadable page. */
export interface ScriptRecordSnapshot {
  readonly hosts: ReadonlyMap<string, number>;
  readonly everywhere?: number;
}

/** Where the record lives between runs (`state/vault/script-record.json`); `'damaged'` when it is there but unusable. */
export interface ScriptRecordStore {
  load(): Promise<ScriptRecordSnapshot | 'damaged' | undefined>;
  save(record: ScriptRecordSnapshot): Promise<void>;
}

/** The most hosts the record keeps; the oldest beyond it fold into `everywhere`, so forgetting one only ever refuses more. */
export const SCRIPT_RECORD_MAX_HOSTS = 500;

/**
 * WHERE PAGE SCRIPTS RAN ACROSS THE MACHINE, as Browsers tells Vault (lead DECISIONS-2 #5): today's `RuleSignInGrants`
 * view (`running`, `scriptedOn`, `scriptedOrigins`), kept by the Vault itself. A page card's lock reads it in `steerOf`:
 * a script on the card's site, on a host that could not be read, or one running anywhere now, makes the card `scripted`
 * (I98).
 *
 * It is also the record a standing rule is held to: Accounts' grant source is told of every script too, but only in its
 * own RAM, which is empty while Accounts is off and after a plugin or daemon restart. The input service reads THIS record
 * as well when it matches a rule and again right before the write (`sightingOf`, `scriptedUnderRule`), so a script that
 * ran while Accounts was away still stops the rule.
 *
 * DURABLE: the host and "everywhere" times are written to the Vault's own state on every report (an atomic, owner-only
 * file) and read back by {@link load} at start, so a rule approved before a script on its place is refused across a
 * daemon restart, whether or not Accounts was listening. Fails CLOSED: until the record has been read, and for as long
 * as it cannot be, every place counts as scripted just now. Which agent scripts are running now is not kept: a restart
 * ends them.
 *
 * GAP: today's `scriptedOn` also suspended every standing sign-in rule pinned to that host ON DISK. That suspension is
 * Accounts' to write, from the report the Vault forwards (`SignInGrantsThroughHook.scriptedOn`), and is lost when no
 * source is listening; the record here is not.
 */
export class MachineScripts {
  /** Where a page script ran, by host, and when one ran where its origin couldn't be read: machine-wide. */
  readonly #scripted = new Map<string, number>();
  #scriptedEverywhere: number | undefined;
  /** Agent scripts running now, anywhere on the machine. */
  #running = 0;
  /** With a store: false until {@link load} has answered, or while the file cannot be used. */
  #trusted: boolean;
  readonly #ready = Promise.withResolvers<void>();
  #saving: Promise<void> = Promise.resolve();

  /**
   * `store`: absent, the record lives in RAM only. `warn`: a plain sentence for the log when the record cannot be read
   * or written (never a host name).
   */
  constructor(
    private readonly now: () => number,
    private readonly store?: ScriptRecordStore,
    private readonly warn?: (sentence: string) => void,
  ) {
    this.#trusted = store === undefined;
  }

  /** Reads the record kept by an earlier run and joins it with what was reported since. Total. */
  async load(): Promise<void> {
    if (this.store === undefined) return;
    let read: Awaited<ReturnType<ScriptRecordStore['load']>>;
    try {
      read = await this.store.load();
    } catch {
      read = 'damaged';
    }
    if (read === 'damaged') {
      this.warn?.(
        'The page-script record cannot be read: no standing sign-in rule fills until it is repaired or removed.',
      );
    } else {
      this.#trusted = true;
      if (read !== undefined) {
        for (const [host, at] of read.hosts) this.#scripted.set(host, Math.max(at, this.#scripted.get(host) ?? at));
        if (read.everywhere !== undefined) this.#everywhere(read.everywhere);
        this.#fold();
      }
    }
    this.#ready.resolve();
  }

  scriptedOrigins(): ScriptedOriginsView {
    const everywhere = this.#trusted ? this.#scriptedEverywhere : this.now();
    return {
      hosts: this.#scripted,
      ...(everywhere === undefined ? {} : { everywhere }),
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
    if (host === undefined) this.#everywhere(now);
    else this.#scripted.set(host, now);
    this.#fold();
    this.#persist();
  }

  /** Resolves once every report so far has been written (or has failed and said so). */
  async settled(): Promise<void> {
    await this.#saving;
  }

  #everywhere(at: number): void {
    this.#scriptedEverywhere = Math.max(at, this.#scriptedEverywhere ?? at);
  }

  /** Keeps the newest hosts; an older one is remembered as "somewhere unreadable then", which only refuses more. */
  #fold(): void {
    if (this.#scripted.size <= SCRIPT_RECORD_MAX_HOSTS) return;
    const oldestFirst = [...this.#scripted].sort((a, b) => a[1] - b[1]);
    for (const [host, at] of oldestFirst.slice(0, oldestFirst.length - SCRIPT_RECORD_MAX_HOSTS)) {
      this.#scripted.delete(host);
      this.#everywhere(at);
    }
  }

  /** Writes what is known after the earlier write and after the load, so the file is never overwritten unread. */
  #persist(): void {
    const { store } = this;
    if (store === undefined) return;
    this.#saving = this.#saving.then(async () => {
      await this.#ready.promise;
      try {
        await store.save({
          hosts: new Map(this.#scripted),
          ...(this.#scriptedEverywhere === undefined ? {} : { everywhere: this.#scriptedEverywhere }),
        });
      } catch {
        this.warn?.('The page-script record could not be written: a restart may forget where a page script ran.');
      }
    });
  }
}

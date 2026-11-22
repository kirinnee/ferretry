import type { StatePort } from '@ferretry/kernel/contract';
import { AskBuzzesFile, type AskBuzzRecord } from '../../../contract/index.ts';
import type { AskBuzzLedger } from '../../lib/push/ask-buzz.ts';

/** The most keys the ledger keeps: past it the OLDEST go (an ask that old has long been seen or closed). */
export const ASK_BUZZ_LEDGER_CAP = 2_000;

/**
 * The ask-buzz ledger over the kernel's state folder: `state/access/ask-buzzes.jsonl`, one line per ask that buzzed. Read
 * once on first use, then kept in memory, so a lookup is not a scan. BOUNDED two ways: a key is dropped when its ask closes
 * or is answered ({@link forget}), and the file holds at most {@link ASK_BUZZ_LEDGER_CAP} keys (the newest). A damaged file
 * refuses the lookup rather than reading as empty: an unreadable ledger cannot testify, so nothing buzzes on its word.
 * Writes run one at a time, so a rewrite never races an append.
 */
export class StateAskBuzzLedger implements AskBuzzLedger {
  #loaded: Promise<Map<string, AskBuzzRecord>> | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: StatePort) {}

  async has(key: string): Promise<boolean> {
    return (await this.#records()).has(key);
  }

  append(record: AskBuzzRecord): Promise<void> {
    return this.#serial(async () => {
      const records = await this.#records();
      const dropped =
        records.size >= ASK_BUZZ_LEDGER_CAP ? [...records.keys()].slice(0, records.size - ASK_BUZZ_LEDGER_CAP + 1) : [];
      if (dropped.length === 0) await this.state.append(AskBuzzesFile, record);
      else await this.#replace([...[...records.values()].filter(r => !dropped.includes(r.key)), record]);
      for (const key of dropped) records.delete(key);
      records.set(record.key, record);
    });
  }

  forget(key: string): Promise<void> {
    return this.#serial(async () => {
      const records = await this.#records();
      if (!records.has(key)) return;
      const kept = [...records.values()].filter(record => record.key !== key);
      await this.#replace(kept);
      records.delete(key);
    });
  }

  /** Swaps the whole file in: a `jsonl` file's `write` takes the ARRAY of its records (the port types it as one record). */
  async #replace(all: readonly AskBuzzRecord[]): Promise<void> {
    await this.state.write(AskBuzzesFile, [...all] as unknown as AskBuzzRecord);
  }

  #serial(write: () => Promise<void>): Promise<void> {
    const run = this.#writes.then(write, write);
    this.#writes = run.catch(() => undefined);
    return run;
  }

  #records(): Promise<Map<string, AskBuzzRecord>> {
    this.#loaded ??= this.#read().catch((error: unknown) => {
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  async #read(): Promise<Map<string, AskBuzzRecord>> {
    const records = new Map<string, AskBuzzRecord>();
    for await (const record of this.state.lines(AskBuzzesFile)) records.set(record.key, record);
    return records;
  }
}

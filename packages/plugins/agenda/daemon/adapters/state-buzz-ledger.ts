import type { StatePort } from '@ferretry/kernel/contract';
import { BUZZES, type BuzzRecord } from '../../contract/index.ts';
import type { BuzzLedger } from '../lib/buzz-service.ts';

/**
 * The buzz ledger over the kernel's state folder: `state/agenda/buzzes.jsonl`, one line per moment that buzzed. Read once
 * on first use (the file only grows), then kept in memory, so a lookup is not a scan. A damaged file refuses the lookup
 * rather than reading as empty: an unreadable ledger cannot testify, so nothing buzzes on its word.
 */
export class StateBuzzLedger implements BuzzLedger {
  #loaded: Promise<Map<string, BuzzRecord>> | undefined;

  constructor(private readonly state: StatePort) {}

  async has(key: string): Promise<boolean> {
    return (await this.#records()).has(key);
  }

  async append(record: BuzzRecord): Promise<void> {
    const records = await this.#records();
    await this.state.append(BUZZES, record);
    records.set(record.key, record);
  }

  async forFerret(ferret: string): Promise<readonly BuzzRecord[]> {
    return [...(await this.#records()).values()].filter(record => record.ferret === ferret);
  }

  #records(): Promise<Map<string, BuzzRecord>> {
    this.#loaded ??= this.#read().catch((error: unknown) => {
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  async #read(): Promise<Map<string, BuzzRecord>> {
    const records = new Map<string, BuzzRecord>();
    for await (const record of this.state.lines(BUZZES)) records.set(record.key, record);
    return records;
  }
}

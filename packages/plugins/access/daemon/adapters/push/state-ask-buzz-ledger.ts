import type { StatePort } from '@ferretry/kernel/contract';
import { AskBuzzesFile, type AskBuzzRecord } from '../../../contract/index.ts';
import type { AskBuzzLedger } from '../../lib/push/ask-buzz.ts';

/**
 * The ask-buzz ledger over the kernel's state folder: `state/access/ask-buzzes.jsonl`, one line per ask that buzzed. Read
 * once on first use (the file only grows), then kept in memory, so a lookup is not a scan. A damaged file refuses the
 * lookup rather than reading as empty: an unreadable ledger cannot testify, so nothing buzzes on its word.
 */
export class StateAskBuzzLedger implements AskBuzzLedger {
  #loaded: Promise<Set<string>> | undefined;

  constructor(private readonly state: StatePort) {}

  async has(key: string): Promise<boolean> {
    return (await this.#keys()).has(key);
  }

  async append(record: AskBuzzRecord): Promise<void> {
    const keys = await this.#keys();
    await this.state.append(AskBuzzesFile, record);
    keys.add(record.key);
  }

  #keys(): Promise<Set<string>> {
    this.#loaded ??= this.#read().catch((error: unknown) => {
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  async #read(): Promise<Set<string>> {
    const keys = new Set<string>();
    for await (const record of this.state.lines(AskBuzzesFile)) keys.add(record.key);
    return keys;
  }
}

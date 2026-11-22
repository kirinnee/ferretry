import { askBuzzKey, askBuzzKind, askBuzzWords, type BuzzableAsk, type BuzzWords } from '@ferretry/core-asks/contract';
import type { Instant } from '@ferretry/std';
import type { AskBuzzRecord } from '../../../contract/index.ts';

/** The durable memory of which asks already buzzed. A rejection means the ledger cannot testify. */
export interface AskBuzzLedger {
  has(key: string): Promise<boolean>;
  append(record: AskBuzzRecord): Promise<void>;
  /** Drops one key (its ask is closed or answered, so it can never buzz again). Unknown: nothing. */
  forget(key: string): Promise<void>;
}

export interface AskBuzzerOptions {
  readonly ledger: AskBuzzLedger;
  /** Sends one push to every live enrolment; resolves how many devices it reached. */
  readonly buzz: (words: BuzzWords) => Promise<number>;
  readonly now: () => Instant;
  /** Where a failed buzz is said. Buzzing stays total. */
  readonly warn?: (message: string) => void;
}

/**
 * THE PHONE'S BUZZ FOR AN ASK, sent by Access (which owns push) so it reaches the owner with the Agenda plugin off. An ask
 * buzzes on its own for exactly two reasons (docs/notifications.md): a card's ask, and a notice that asked for the phone
 * (`fy notify --buzz`). Each ask is recorded under its own key BEFORE the send, so a repeat of the same event is no second
 * buzz, across restarts too: AT MOST ONCE (a crash between the two loses the buzz, never doubles it, which is the right way
 * to fail for a phone). One key is serialised, so two callers racing on it buzz once. The key is dropped when its ask
 * closes ({@link AskBuzzer.settle}), which keeps the ledger to the asks still open. Agenda no longer sends this buzz, so it
 * can never reach the phone twice.
 */
export class AskBuzzer {
  readonly #inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: AskBuzzerOptions) {}

  /** Buzzes once for `ask`, when it is a moment that buzzes. Resolves whether a device was reached. Total. */
  buzz(ask: BuzzableAsk): Promise<boolean> {
    const kind = askBuzzKind(ask);
    if (kind === undefined || ask.ferret === undefined) return Promise.resolve(false);
    const key = askBuzzKey(ask.ferret, ask.id);
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running.then(() => false);
    const run = this.#make(key, kind, ask).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run);
    return run;
  }

  /** An ask closed or was answered: its key is no longer kept. Total. */
  async settle(ferret: string, ask: string): Promise<void> {
    try {
      await this.options.ledger.forget(askBuzzKey(ferret, ask));
    } catch (error) {
      this.options.warn?.(
        `an ask's buzz record could not be dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #make(key: string, kind: AskBuzzRecord['kind'], ask: BuzzableAsk): Promise<boolean> {
    try {
      if (await this.options.ledger.has(key)) return false;
      await this.options.ledger.append({ format: 1, key, at: this.options.now(), kind });
      return (await this.options.buzz(askBuzzWords(ask))) > 0;
    } catch (error) {
      this.options.warn?.(`an ask's buzz could not be made: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

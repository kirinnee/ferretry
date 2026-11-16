import type { Instant } from '@ferretry/std';
import type { AccessBuzzApi } from '../../contract/others.ts';
import type { BuzzKind, BuzzRecord } from '../../contract/index.ts';
import type { BuzzWords } from './buzz-policy.ts';

/** The durable memory of which moments already buzzed. A rejection means the ledger cannot testify. */
export interface BuzzLedger {
  has(key: string): Promise<boolean>;
  append(record: BuzzRecord): Promise<void>;
  /** The buzzes made about one ferret (its asks and its stops), so opening an ask can take their lines down. */
  forFerret(ferret: string): Promise<readonly BuzzRecord[]>;
}

export interface BuzzServiceOptions {
  readonly ledger: BuzzLedger;
  /** Access, when it is on; absent, nothing can be delivered and nothing is recorded. */
  readonly access: () => Pick<AccessBuzzApi, 'buzz'> | undefined;
  readonly now: () => Instant;
  /** Said once for every moment that buzzed; never carries words. */
  readonly buzzed?: (key: string, kind: BuzzKind, at: Instant) => void;
  /** Where a failed buzz is said. Buzzing stays total. */
  readonly warn?: (message: string) => void;
}

/** What the ledger line names beyond the words: which ferret and ask the moment was about. */
export interface BuzzSubject {
  readonly ferret?: string;
  readonly ask?: string;
}

/**
 * THE PHONE'S BUZZES, with durable duplicate suppression, and the sole call into Access's push fan-out.
 *
 * A buzz is made for a notice that asked for one, for a card's ask, for the stop of a ferret that waits on the owner and
 * for a moment another plugin names (a deadline, a snooze waking) — and for nothing else (docs/notifications.md). Each is
 * recorded under its own key, so a repeat of the same moment is no second buzz, across restarts too. One key is
 * serialised, so two callers racing on it buzz once.
 */
export class BuzzService {
  readonly #inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: BuzzServiceOptions) {}

  /** Buzzes once per `key`. Resolves whether it buzzed: false for a repeat, with no Access, or when nothing was reached. Total. */
  buzz(key: string, kind: BuzzKind, words: BuzzWords, subject: BuzzSubject = {}): Promise<boolean> {
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running.then(() => false);
    const run = this.#make(key, kind, words, subject).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run);
    return run;
  }

  async #make(key: string, kind: BuzzKind, words: BuzzWords, subject: BuzzSubject): Promise<boolean> {
    try {
      if (await this.options.ledger.has(key)) return false;
      const access = this.options.access();
      if (access === undefined) return false;
      const reached = await access.buzz(words);
      const at = this.options.now();
      // Recorded after the send: a crash between them buzzes the moment once more, never loses it.
      await this.options.ledger.append({
        format: 1,
        key,
        at,
        kind,
        ...(subject.ferret === undefined ? {} : { ferret: subject.ferret as NonNullable<BuzzRecord['ferret']> }),
        ...(subject.ask === undefined ? {} : { ask: subject.ask }),
        title: words.title,
        enrolled: reached,
      });
      this.options.buzzed?.(key, kind, at);
      return reached > 0;
    } catch (error) {
      this.options.warn?.(`a buzz could not be made: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

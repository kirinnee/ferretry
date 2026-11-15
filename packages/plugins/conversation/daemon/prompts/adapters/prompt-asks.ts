import { type AskRef, type AsksApi, type EntryId, EntryIdSchema, type SourceKey } from '@ferretry/core-asks/contract';
import { promptEntry, promptWait, type PromptRead } from '../lib/prompt-wait.ts';

/** The ask source Conversation registers (`ask.sources:prompt`). */
const PROMPT_SOURCE = 'prompt' as SourceKey;

/** What the prompt obligations need of Asks: raise (idempotent by source and entry), read what is open, and close. */
export type PromptAsksPort = Pick<AsksApi, 'raise' | 'open' | 'close'>;

/** One ferret as the sweep sees it: whether it is still running (a stopped ferret waits on nobody). */
export interface PromptRoster {
  readonly id: string;
  readonly live: boolean;
}

/**
 * THE PROMPT OBLIGATIONS: a ferret parked on a permission prompt or a harness dialog waits on the owner exactly like
 * an ask does, so it IS an Agenda card (Asks' source `prompt`), raised once per prompt and closed the moment the wait
 * ends (answered in the console, the pane moved on, the ferret stopped or went away). Nothing here answers the prompt.
 *
 * It is a sweep, not an event: a pane that moves to `needs-input` changes no ferret state (`ferret.changed` is the
 * lifecycle), so the question watch's own tick looks. A raise or a close that failed is simply asked again by the next
 * sweep, and said once until it works.
 */
export class PromptAsks {
  readonly #failing = new Set<string>();

  constructor(
    private readonly asks: PromptAsksPort,
    private readonly read: (ferret: string) => Promise<PromptRead | undefined>,
    private readonly warn: (message: string) => void,
  ) {}

  /** Makes the Agenda say what every ferret's pane says. Throws only when Asks' open cards cannot be read. */
  async sweep(roster: readonly PromptRoster[]): Promise<void> {
    const open = await this.asks.open({ source: PROMPT_SOURCE, state: 'open' });
    const known = new Set(roster.map(ferret => ferret.id));
    for (const ask of open) {
      // A card of a ferret that is gone is over.
      if (!known.has(ask.ferret ?? '')) await this.#close({ ferret: ask.ferret ?? '', id: ask.id }, ask.entry);
    }
    for (const { id, live } of roster) {
      try {
        const wait = live ? promptWait(await this.read(id)) : undefined;
        const wanted = wait === undefined ? undefined : EntryIdSchema.parse(promptEntry(id, wait.ref));
        const mine = open.filter(ask => ask.ferret === id);
        for (const ask of mine) if (ask.entry !== wanted) await this.#close({ ferret: id, id: ask.id }, ask.entry);
        if (wait !== undefined && !mine.some(ask => ask.entry === wanted)) {
          await this.asks.raise({
            source: PROMPT_SOURCE,
            ref: wait.ref,
            entry: wanted as EntryId,
            kind: 'task',
            subject: wait.subject,
            why: `${id} is waiting on a prompt only you can answer.`,
            howToResolve: 'Answer it in the ferret’s console; this card closes by itself when the wait ends.',
            raisedBy: { kind: 'daemon' },
            ferret: id,
            blocking: true,
          });
        }
        this.#failing.delete(id);
      } catch (error) {
        if (!this.#failing.has(id)) this.warn(`conversation could not follow the prompt of ${id}: ${String(error)}`);
        this.#failing.add(id);
      }
    }
  }

  async #close(ref: AskRef, entry: EntryId): Promise<void> {
    await this.asks.close(ref, 'withdrawn', entry);
  }
}

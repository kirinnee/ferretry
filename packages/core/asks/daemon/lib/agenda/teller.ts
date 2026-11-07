import { z } from 'zod';
import type { SerialExecutor } from '../ports.ts';
import {
  AGENDA_REPLY_RECHECK_MS,
  type AgendaComposerState,
  type AgendaMessenger,
  AgendaNotTyped,
  type AgendaReplyTimers,
} from './reply-batch.ts';

/**
 * TELLING A FERRET SOMETHING THE DAEMON OWES IT (today's `AgendaReplyBatcher.add` for "your request ended").
 *
 * A tell goes through the same delivery as an owner's answer — the queued, non-interrupting send, and the composer
 * read first — but under the CALLER's send id, so asking twice types once. What was not typed (a draft in the composer,
 * a screen that cannot be read, nothing to type with) is kept in the ferret's own file and tried again every
 * {@link AGENDA_REPLY_RECHECK_MS}, and again after a restart ({@link AgendaTeller.resume}).
 *
 * Unlike an answer it is information, not a decision: a tell the ferret could not take is never turned into a card
 * for the owner, and a send refused outright is dropped rather than retried. The text is the caller's; nothing here
 * reads or keeps a secret, and the file holds only what was to be said.
 */

/** The most tells one ferret's file holds waiting; the oldest goes when a newer one needs the room. */
export const MAX_HELD_TELLS = 64;
/** How many sent ids are remembered so an asked-again id is not typed again, newest kept. */
const MAX_SENT_TELLS = 256;
/** The longest text a tell carries. */
export const MAX_TELL_CHARS = 4_096;

const HeldTellSchema = z.strictObject({ sendId: z.string().min(1), text: z.string().min(1) });

export const AgendaTellsSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  held: z.array(HeldTellSchema).max(MAX_HELD_TELLS),
  sent: z.array(z.string().min(1)).max(MAX_SENT_TELLS),
});
export type AgendaTells = z.infer<typeof AgendaTellsSchema>;

const emptyTells = (sessionId: string): AgendaTells => ({ v: 1, sessionId, held: [], sent: [] });

/** Where each ferret's tells are kept. */
export interface AgendaTellStore {
  read(sessionId: string): Promise<AgendaTells | null>;
  write(tells: AgendaTells): Promise<void>;
}

/** What a ferret's composer holds, read before anything is typed. */
export interface AgendaTellComposer {
  state(sessionId: string): Promise<AgendaComposerState>;
}

export class AgendaTeller {
  /** Ferrets with an attempt running, so a retry timer and a new tell do not both type the same one. */
  readonly #running = new Set<string>();

  constructor(
    private readonly store: AgendaTellStore,
    private readonly messenger: AgendaMessenger,
    private readonly composer: AgendaTellComposer,
    private readonly timers: AgendaReplyTimers,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly recheckMs: number = AGENDA_REPLY_RECHECK_MS,
  ) {}

  async tell(sessionId: string, text: string, sendId: string): Promise<'sent' | 'held'> {
    if (text.trim() === '' || text.length > MAX_TELL_CHARS)
      throw new Error('a tell carries between 1 and 4096 characters');
    if (sendId === '') throw new Error('a tell needs a send id');
    const known = await this.locked(sessionId, async current => {
      if (current.sent.includes(sendId)) return 'sent' as const;
      if (current.held.some(each => each.sendId === sendId)) return 'held' as const;
      await this.store.write({ ...current, held: [...current.held, { sendId, text }].slice(-MAX_HELD_TELLS) });
      return undefined;
    });
    if (known === 'sent') return 'sent';
    await this.attempt(sessionId);
    return (await this.store.read(sessionId))?.sent.includes(sendId) === true ? 'sent' : 'held';
  }

  /** At start: types what a restart interrupted, for each ferret on its own. */
  async resume(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await this.attempt(sessionId).catch(() => undefined);
  }

  /** Types what is held, oldest first, while the composer is empty and the send path takes it. */
  private async attempt(sessionId: string): Promise<void> {
    if (this.#running.has(sessionId)) return;
    this.#running.add(sessionId);
    try {
      for (;;) {
        const held = (await this.store.read(sessionId))?.held[0];
        if (held === undefined) return this.timers.cancel(tellTimer(sessionId));
        const composer = await this.composer.state(sessionId).catch(() => 'unreadable' as const);
        if (composer !== 'empty') return this.later(sessionId);
        try {
          await this.messenger.send(sessionId, held.text, held.sendId);
        } catch (error) {
          if (error instanceof AgendaNotTyped) return this.later(sessionId);
          // Refused outright: retrying the same words would be refused the same way, so it is let go.
          await this.settle(sessionId, held.sendId, false);
          continue;
        }
        await this.settle(sessionId, held.sendId, true);
      }
    } finally {
      this.#running.delete(sessionId);
    }
  }

  /** Takes a tell off the held list; a sent one is remembered so asking again types nothing. */
  private async settle(sessionId: string, sendId: string, sent: boolean): Promise<void> {
    await this.locked(sessionId, async current => {
      await this.store.write({
        ...current,
        held: current.held.filter(each => each.sendId !== sendId),
        sent: sent ? [...current.sent.filter(id => id !== sendId), sendId].slice(-MAX_SENT_TELLS) : current.sent,
      });
    });
  }

  private later(sessionId: string): void {
    this.timers.schedule(
      tellTimer(sessionId),
      this.recheckMs,
      () => void this.attempt(sessionId).catch(() => undefined),
    );
  }

  private async locked<T>(sessionId: string, work: (current: AgendaTells) => Promise<T>): Promise<T> {
    return await this.serial.run(`attention-tells:${sessionId}`, async () =>
      work((await this.store.read(sessionId)) ?? emptyTells(sessionId)),
    );
  }
}

/** The timer key a ferret's tell retry runs under, apart from its answers'. */
const tellTimer = (sessionId: string): string => `${sessionId}#tell`;

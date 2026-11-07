import {
  type AskId,
  AskIdSchema,
  type AsksApi,
  type EntryId,
  EntryIdSchema,
  type SourceKey,
} from '@ferretry/core-asks/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { InputAgendaPort, InputAgentNotifier, InputCard, InputCardResult } from '../../lib/inputs/ports.ts';
import { type AgendaId, INPUT_PROMPT_MARKER } from '../../lib/inputs/wire.ts';

/** The `ask.sources` key an input card is raised under (Vault takes `ask.sources:input`). */
export const INPUT_ASK_SOURCE = 'input' as SourceKey;

/**
 * A card's context: the daemon's own line first when it has one (why a task plan did not fill it), then the login it
 * follows, then the agent's prompt, always last, after {@link INPUT_PROMPT_MARKER} (today's `agenda-adapter.ts`).
 */
export const contextOf = (card: Pick<InputCard, 'prompt' | 'chain'>, line?: string): string =>
  [
    ...(line === undefined ? [] : [line]),
    ...(card.chain === undefined ? [] : [`This follows ${card.chain} in the same login.`]),
    `${INPUT_PROMPT_MARKER}${card.prompt}`,
  ].join('\n');

/** The item view shows the title and the subject apart, so the subject is the ask, on one line. */
const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** Reads back what a card was raised with, from the Vault's own request records (values are never there). */
export interface InputPromptSource {
  /** The prompt of the request a card presents, or nothing when Vault holds no such request. */
  promptOf(requestId: string): Promise<string | undefined>;
}

/**
 * The input request's card, as an ask of source `input` (§7.4; today's `InputAgendaAdapter` over the agenda). The
 * daemon words the subject and the reason; the agent's own `prompt` rides in the context under "The agent says", never
 * as the reason. `(source, entry)` is `('input', <request id>)`, so a raise is idempotent and a restart finds the card
 * again. The answer is the input form's, never an ask answer: Asks' port has no answer method.
 *
 * Not carried over (Asks' port has no place for them): the closing note, the daemon's later context line (`note`),
 * and the "Part of" link to the closest open agenda (an Agenda feature).
 */
export class InputAsksAdapter implements InputAgendaPort {
  constructor(
    private readonly asks: Pick<AsksApi, 'raise' | 'close' | 'get'>,
    private readonly records: InputPromptSource,
  ) {}

  async raise(sessionId: string, card: InputCard): Promise<InputCardResult> {
    try {
      const ask = await this.asks.raise({
        source: INPUT_ASK_SOURCE,
        ref: { request: card.requestId },
        entry: entryOf(card.requestId),
        kind: 'input',
        subject: oneLine(card.ask),
        why: card.ask,
        context: contextOf(card),
        howToResolve: 'Open the card and type the value in its form. Nothing is sent until you press Send.',
        raisedBy: { kind: 'daemon' },
        ferret: sessionId,
        ...(card.blocking ? { blocking: true } : {}),
      });
      return { ok: true, id: ask.id as string as AgendaId };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Asks kept no card for this request' };
    }
  }

  async close(sessionId: string, id: AgendaId, _note: string): Promise<void> {
    const ask = askOf(id);
    if (ask !== undefined) await this.asks.close({ ferret: sessionId, id: ask }, 'withdrawn').catch(() => undefined);
  }

  async promptOf(sessionId: string, id: AgendaId): Promise<string | undefined> {
    const ask = askOf(id);
    if (ask === undefined) return undefined;
    const summary = await this.asks.get({ ferret: sessionId, id: ask }).catch(() => undefined);
    if (summary === undefined || summary.source !== INPUT_ASK_SOURCE || summary.state !== 'open') return undefined;
    return await this.records.promptOf(summary.entry);
  }
}

/**
 * The send id of the message that tells a ferret its request ended: the ferret and the card (the request's, as a
 * request opened again on a new card is a new card), so a request is told about once however often it is asked.
 * Today's outbox key was the card id on that ferret's outbox.
 */
export const inputTellSendId = (ferret: string, card: AgendaId): string => `input-ended-${ferret}-${card}`;

/**
 * Tells the raising ferret how its request ended, through Asks (`AsksApi.tell`: the same delivery an owner's answer
 * uses, held and retried when the ferret's composer is busy). Total: a ferret that cannot be told is simply not told,
 * and a build whose Asks has no `tell` tells nobody. The words are the service's own and carry no value.
 */
export class InputAgentNotifierAdapter implements InputAgentNotifier {
  constructor(private readonly asks: Pick<AsksApi, 'tell'>) {}

  async tell(sessionId: string, agendaId: AgendaId, message: string): Promise<void> {
    await this.asks.tell?.(sessionId as FerretId, message, inputTellSendId(sessionId, agendaId)).catch(() => undefined);
  }
}

const entryOf = (requestId: string): EntryId => EntryIdSchema.parse(requestId);
const askOf = (id: AgendaId): AskId | undefined => {
  const parsed = AskIdSchema.safeParse(id);
  return parsed.success ? parsed.data : undefined;
};

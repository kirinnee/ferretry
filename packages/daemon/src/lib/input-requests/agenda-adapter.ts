import type { AgendaId } from '@ferretry/protocol';
import type { AgendaBoardChange, AgendaChangeObserver, AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { PhoneApprovalAgendaPort, PhoneApprovalCard } from './phone-approval.ts';
import type { InputAgendaPort, InputAgentNotifier, InputCard, InputCardResult } from './ports.ts';

const INPUT_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'input-request' };
const PHONE_APPROVAL_ACTOR: AgendaActor = { kind: 'daemon', cause: 'phone-approval' };

/** Where the agent's own sentence starts in a card's context; everything after it is the prompt. */
const PROMPT_MARKER = 'The agent says: ';

/**
 * The input request's card on the owner's agenda. The daemon words the heading and the reason; the
 * agent's own `prompt` rides in the context under "The agent says", never as the reason, so a ferret
 * cannot dress its sentence as the daemon's. The card has no ask and no answers: the input form answers
 * it, and the value is never part of the agenda.
 */
export class InputAgendaAdapter implements InputAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve' | 'list'>) {}

  async raise(sessionId: string, card: InputCard): Promise<InputCardResult> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.requestId,
        kind: 'input',
        title: card.title,
        subject: oneLine(card.ask),
        why: card.ask,
        context: [
          ...(card.chain === undefined ? [] : [`This follows ${card.chain} in the same login.`]),
          `${PROMPT_MARKER}${card.prompt}`,
        ].join('\n'),
        howToResolve: 'Open the card and type the value in its form. Nothing is sent until you press Send.',
        input: { requestId: card.requestId },
        neededBy: card.expiresAt,
        ...(card.blocking ? { blockingNow: true as const } : {}),
      },
      INPUT_CARD_ACTOR,
    );
    if (!outcome.ok) return { ok: false, message: outcome.error.message };
    return outcome.item === undefined
      ? { ok: false, message: 'the agenda kept no card for this request' }
      : { ok: true, id: outcome.item.id };
  }

  async close(sessionId: string, id: AgendaId, note: string): Promise<void> {
    await this.agenda.resolve(sessionId, id, INPUT_CARD_ACTOR, note).catch(() => undefined);
  }

  async promptOf(sessionId: string, id: AgendaId): Promise<string | undefined> {
    const listed = await this.agenda.list(sessionId);
    if (!listed.ok) return undefined;
    const context = listed.value.items.find(item => item.id === id)?.context;
    const at = context?.indexOf(PROMPT_MARKER) ?? -1;
    return context == null || at < 0 ? undefined : context.slice(at + PROMPT_MARKER.length);
  }
}

/**
 * An approve-on-phone card (docs/input-requests.md, "Approve on your phone"): an `info` item carrying the approval's
 * ref, every word the daemon's. Only the daemon raises one (the agenda's add route has no field for the ref), so the
 * app draws the approve card only from a ref no ferret could set; an app that does not know the ref shows the
 * daemon's subject as a plain note, with no number.
 */
export class PhoneApprovalAgendaAdapter implements PhoneApprovalAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve' | 'list'>) {}

  async raise(sessionId: string, card: PhoneApprovalCard): Promise<InputCardResult> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.approvalId,
        kind: 'info',
        title: card.title,
        subject: oneLine(card.subject),
        why: card.why,
        context: card.context,
        howToResolve: card.howToResolve,
        phoneApproval: { id: card.approvalId },
      },
      PHONE_APPROVAL_ACTOR,
    );
    if (!outcome.ok) return { ok: false, message: outcome.error.message };
    return outcome.item === undefined
      ? { ok: false, message: 'the agenda kept no card for this approval' }
      : { ok: true, id: outcome.item.id };
  }

  async close(sessionId: string, id: AgendaId, note: string): Promise<void> {
    await this.agenda.resolve(sessionId, id, PHONE_APPROVAL_ACTOR, note).catch(() => undefined);
  }

  async open(sessionId: string): Promise<readonly AgendaId[]> {
    const listed = await this.agenda.list(sessionId);
    if (!listed.ok) return [];
    return listed.value.items.filter(item => item.phoneApproval !== undefined).map(item => item.id);
  }
}

/** Tells the raising ferret how its request ended, through the same outbox an owner's answer uses. */
export class InputAgentNotifierAdapter implements InputAgentNotifier {
  constructor(private readonly add: (sessionId: string, key: string, message: string) => Promise<unknown>) {}

  async tell(sessionId: string, agendaId: AgendaId, message: string): Promise<void> {
    await this.add(sessionId, agendaId, message).catch(() => undefined);
  }
}

/**
 * Hears that the OWNER closed an input card without the form (a dismiss or a done) and cancels its request.
 * The daemon's own closing of a card is not heard: it is the request that ended, not the owner.
 */
export class InputCardClosedObserver implements AgendaChangeObserver {
  constructor(private readonly closed: (sessionId: string, id: AgendaId) => Promise<void>) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    const addressed = change.addressed;
    if (change.actor.kind !== 'human' || addressed?.input === undefined) return;
    if (change.change !== 'dismissed' && change.change !== 'resolved') return;
    await this.closed(sessionId, addressed.id);
  }
}

/** The item view shows the title and the subject apart, so the subject is the ask, on one line. */
const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

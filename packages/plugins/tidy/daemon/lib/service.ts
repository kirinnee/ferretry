/**
 * Reads the facts a tidy is decided on and hands them to `planTidy`. It writes nothing: the plan is applied by the
 * caller through the card drop and the ask close the ferret could have used itself. Copied from today's
 * `lib/tidy/service.ts`, reading Board (optional), Asks and Ferrets through their ports instead of the daemon's own.
 */
import { type AskSummary, type AsksApi, SourceKeySchema } from '@ferretry/core-asks/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { BoardApi } from '@ferretry/plugin-board/contract';
import type { TidyPlan } from '../../contract/index.ts';
import { planTidy, type TidyAskFact, type TidyCardFact } from './plan.ts';

/** What the service reads; `board` is `undefined` while the Board plugin is off. */
export interface TidyPorts {
  readonly ferrets: Pick<FerretsApi, 'get'>;
  readonly asks: Pick<AsksApi, 'open'>;
  readonly board: () => Pick<BoardApi, 'cards' | 'switchOf'> | undefined;
}

export type TidyPlanResult =
  | { readonly ok: true; readonly plan: TidyPlan }
  | { readonly ok: false; readonly message: string };

/** Board pages hold at most this many cards (`MAX_BOARD_PAGE`); one ferret's open cards are far fewer. */
const CARD_LIMIT = 500;
const CARD_SOURCE = SourceKeySchema.parse('card');

/** Whether a card-gate ask (its entry names the card) is about this card. */
const entryNames = (entry: string, cardId: string): boolean =>
  entry.split(/[:._-]/u).some(part => part === cardId) || entry === cardId;

const askFactOf = (ask: AskSummary): TidyAskFact | undefined =>
  ask.state === 'closed'
    ? undefined
    : {
        id: ask.id,
        subject: ask.subject,
        kind: ask.kind,
        source: ask.source,
        raisedBy: ask.raisedBy,
        state: ask.state,
      };

export class TidyService {
  constructor(private readonly ports: TidyPorts) {}

  async plan(ferret: FerretId): Promise<TidyPlanResult> {
    const board = this.ports.board();
    if (board === undefined) return { ok: false, message: 'the board is not running, so there is no card to read' };
    let own: readonly AskSummary[];
    let cards: Awaited<ReturnType<typeof board.cards>>;
    try {
      [own, cards] = await Promise.all([
        this.ports.asks.open({ ferret }),
        board.cards({ ferret, state: 'open', limit: CARD_LIMIT }),
      ]);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const self = await this.ports.ferrets.get(ferret);
    const facts: TidyCardFact[] = cards
      .filter(card => card.owner === ferret || card.assignee === ferret)
      .map(card => ({
        id: card.id,
        title: card.title,
        project: card.projectId,
        owner: card.owner,
        assignee: card.assignee,
        askedBy: card.askedBy ?? (card.origin === 'human' ? 'person' : 'agent'),
      }));
    const handlers = new Set(facts.map(card => card.assignee ?? card.owner).filter(id => id !== ferret));
    const live = new Set<string>();
    for (const id of handlers) {
      const handler = await this.ports.ferrets.get(id as FerretId);
      if (handler !== undefined && handler.state !== 'stopped') live.add(id);
    }
    const projects = [...new Set(facts.map(card => card.project))];
    const switches = await Promise.all(
      projects.map(async project => [project, await board.switchOf(project).catch(() => undefined)] as const),
    );
    const gates = await this.ports.asks.open({ source: CARD_SOURCE, state: 'open' });
    return {
      ok: true,
      plan: planTidy({
        ferret,
        helper: self?.role === 'helper',
        cards: facts,
        boardsOn: new Set(switches.filter(([, state]) => state?.on === true).map(([project]) => project)),
        liveFerrets: live,
        gateCards: new Set(facts.filter(card => gates.some(gate => entryNames(gate.entry, card.id))).map(c => c.id)),
        asks: own.flatMap(ask => askFactOf(ask) ?? []),
      }),
    };
  }
}

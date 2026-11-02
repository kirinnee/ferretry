import type { AgendaSnapshot, BoardTask, TidyPlan } from '@ferretry/protocol';
import type { AgendaQueryResult } from '../agenda/service.ts';
import { cardAskedBy, cardCategory, type LaneSets, presenceOf, type SessionLivenessSource } from '../board/index.ts';
import type { BoardSwitchReader } from '../board-projects/board-switch.ts';
import { isSubFerret, type SubFerretDirectory } from '../sub-ferret/index.ts';
import { planTidy, type TidyCardFact } from './plan.ts';

/** What the service reads; every port is one the daemon already has. */
export interface TidyPorts {
  readonly board: {
    snapshot(): Promise<{ readonly cards: readonly BoardTask[]; readonly laneSets: LaneSets }>;
  };
  readonly switches: BoardSwitchReader;
  readonly sessions: SessionLivenessSource;
  readonly agenda: { list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>> };
  readonly subFerrets: SubFerretDirectory;
  readonly machineId: () => string | undefined;
}

export type TidyPlanResult =
  | { readonly ok: true; readonly plan: TidyPlan }
  | { readonly ok: false; readonly message: string };

const factOf = (card: BoardTask, laneSets: LaneSets): TidyCardFact => ({
  id: card.id,
  title: card.title,
  projectId: card.projectId,
  owner: card.owner,
  assignee: card.assignee,
  askedBy: card.askedBy ?? cardAskedBy(card),
  finished: card.dropped !== null || cardCategory(card, laneSets) === 'closed',
});

/**
 * Reads the facts a tidy is decided on and hands them to {@link planTidy}. It writes nothing: the plan is
 * applied by the caller through the card drop and the agenda "done" the ferret could have used itself.
 */
export class TidyService {
  constructor(private readonly ports: TidyPorts) {}

  async plan(sessionId: string): Promise<TidyPlanResult> {
    const own = await this.ports.agenda.list(sessionId);
    if (!own.ok) return { ok: false, message: own.error.message };
    const subFerret = await isSubFerret(this.ports.subFerrets, sessionId);
    const { cards, laneSets } = await this.ports.board.snapshot();
    const facts = cards
      .filter(card => card.owner === sessionId || card.assignee === sessionId)
      .map(card => factOf(card, laneSets));
    const open = facts.filter(card => !card.finished);
    const roster = await this.ports.sessions.roster();
    const handlers = new Set(open.map(card => card.assignee ?? card.owner).filter(id => id !== sessionId));
    const boards = [...new Set(open.map(card => card.projectId))];
    const on = await Promise.all(boards.map(async board => [board, await this.ports.switches.isOn(board)] as const));
    return {
      ok: true,
      plan: planTidy({
        sessionId,
        subFerret,
        machineId: this.ports.machineId(),
        cards: facts,
        boardsOn: new Set(on.filter(([, isOn]) => isOn).map(([board]) => board)),
        liveSessions: new Set([...handlers].filter(id => presenceOf(roster, id) !== 'dead')),
        gateCards: await this.gateCards(sessionId, own.value, open),
        items: own.value.items,
        replying: new Set([...(own.value.replies?.pending ?? []), ...(own.value.delivery?.sending ?? [])]),
      }),
    };
  }

  /** The cards an open gate item waits on, looked for on the ferret's agenda and on its cards' other ferrets'. */
  private async gateCards(
    sessionId: string,
    own: AgendaSnapshot,
    open: readonly TidyCardFact[],
  ): Promise<ReadonlySet<string>> {
    const others = [...new Set(open.flatMap(card => [card.owner, card.assignee ?? card.owner]))].filter(
      id => id !== sessionId,
    );
    const snapshots = [own];
    for (const id of others) {
      const listed = await this.ports.agenda.list(id);
      if (listed.ok) snapshots.push(listed.value);
    }
    return new Set(snapshots.flatMap(snapshot => snapshot.items.flatMap(item => item.gate?.cardId ?? [])));
  }
}

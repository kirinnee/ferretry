/**
 * THE GATE'S CARD LIST, FROM ONE PASS. The gates read every card on the board; each card is built from ONE sweep
 * (`views`, `laneSets`) and ONE snapshot (`cards`), the way v4's `board-gate-cards` did. Nothing here derives the board
 * again per card: a board of N cards costs one derivation, not N.
 */
import type { Card, CardView } from '../../../contract/index.ts';
import type { CardAudience } from './authority.ts';
import type { GateCard } from './gate-policy.ts';
import { BoardIndex, type LaneSets, stillBuilding } from './graph.ts';

export interface GateCardsPass {
  /** The one sweep: every card's derived view. */
  readonly views: readonly CardView[];
  /** The one snapshot of the stored cards and their lane sets. */
  readonly cards: readonly Card[];
  readonly laneSets: LaneSets;
  readonly machineId: string;
  /** A project's name, asked once per project. */
  readonly projectName: (project: Card['projectId']) => Promise<string | undefined>;
  readonly audienceOf: (card: Card) => Promise<CardAudience>;
  /** The rare card the sweep has no view for (written between the sweep and the snapshot): derived on its own. */
  readonly blockedByOf: (card: Card) => Promise<NonNullable<GateCard['blockedBy']>>;
}

export async function gateCardsOf(pass: GateCardsPass): Promise<GateCard[]> {
  const byId = new Map(pass.views.map(view => [view.id, view] as const));
  const index = new BoardIndex(pass.cards, pass.machineId);
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (project: Card['projectId']): Promise<string | undefined> => {
    const known = names.get(project);
    if (known !== undefined) return known;
    const asked = pass.projectName(project);
    names.set(project, asked);
    return asked;
  };
  const out: GateCard[] = [];
  for (const stored of pass.cards) {
    const name = await nameOf(stored.projectId);
    const view = byId.get(stored.id);
    out.push({
      task: stored,
      laneSet: pass.laneSets.get(stored.projectId) ?? null,
      audience: await pass.audienceOf(stored),
      blockedBy: view === undefined ? await pass.blockedByOf(stored) : view.blockedBy,
      building: stillBuilding(stored, index, pass.laneSets),
      ...(name === undefined ? {} : { projectName: name }),
    });
  }
  return out;
}

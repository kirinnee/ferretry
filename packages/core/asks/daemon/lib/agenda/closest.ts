import { type AgendaId, type AgendaItem, type AgendaLink, MAX_AGENDA_LINK_LABEL_LENGTH } from '../protocol/agenda.ts';

/**
 * THE CLOSEST AGENDA of something the daemon raises for a ferret (docs/agenda.md § One channel per topic): an agenda is
 * one channel of the owner's attention, so a hands-on card the daemon raises on a ferret's behalf — an input form for a
 * password or a code — names the open agenda it belongs with instead of reading as a fresh topic. The card itself stays
 * its own item, because its form is what the owner answers; the link is what ties it to the topic.
 *
 * Pure: the caller hands it the daemon's related matches and the session's open items.
 */
/**
 * The part of the daemon's related-work answer (`WorkRelatedResponse`, owned by the work search) this reads: each
 * match's strength and, for an agenda hit, its session and id. Structural, so Asks names no other subsystem's type.
 */
export interface RelatedMatches {
  readonly matches: readonly {
    readonly strength: 'strong' | 'weak';
    readonly hit: { readonly kind: string; readonly id: string; readonly sessionId?: string };
  }[];
}

export interface ClosestAgenda {
  readonly id: AgendaId;
  readonly title: string;
}

/** Whether an open item is a topic a card can belong with: one a ferret raised, open, and not a card of its own kind. */
const isTopic = (item: AgendaItem): boolean =>
  item.raisedBy === 'agent' && item.notice !== true && item.input === undefined && item.confirms === undefined;

/**
 * The open agenda on `sessionId` that the daemon's related check matched STRONGLY, or nothing: a weak match is not
 * enough to tie a card to a topic the owner would not recognise it under. The daemon's order picks among several.
 */
export function closestAgenda(
  related: RelatedMatches,
  sessionId: string,
  open: readonly AgendaItem[],
): ClosestAgenda | undefined {
  const topics = new Map(open.filter(isTopic).map(item => [item.id, item]));
  for (const match of related.matches) {
    if (match.strength !== 'strong' || match.hit.kind !== 'agenda' || match.hit.sessionId !== sessionId) continue;
    const item = topics.get(match.hit.id as AgendaId);
    if (item !== undefined) return { id: item.id, title: item.title ?? item.subject };
  }
  return undefined;
}

/** The link a card carries to its closest agenda: "Part of: <title>" → `!A3`, through the one reference renderer. */
export function closestAgendaLink(closest: ClosestAgenda): AgendaLink {
  const label = `Part of: ${closest.title}`;
  return {
    label:
      label.length <= MAX_AGENDA_LINK_LABEL_LENGTH ? label : `${label.slice(0, MAX_AGENDA_LINK_LABEL_LENGTH - 1)}…`,
    target: `!${closest.id}`,
    meaning: 'The open agenda this belongs with: the same topic, so the answer lands in one place.',
  };
}

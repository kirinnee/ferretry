import type { AgendaLedger } from '../agenda/state-machine.ts';
import type { AskLink, UnlinkedAsk } from './ports.ts';

/** The open, non-notice items of a ledger that name no card yet. A notice is a message, not work. */
export const unlinkedAsksOf = (ledger: AgendaLedger | null): readonly UnlinkedAsk[] =>
  ledger === null
    ? []
    : ledger.entries.flatMap(entry =>
        entry.lifecycle === 'active' && entry.item.notice !== true && (entry.item.task ?? null) === null
          ? [{ id: entry.item.id }]
          : [],
      );

/**
 * The ledger with each named open item pointed at its card (and marked blocking where told). An item that is
 * gone, closed or already carries a card is left as it is, so a second pass changes nothing.
 */
export const linkAsksIn = (
  ledger: AgendaLedger,
  links: readonly AskLink[],
  at: string,
): { readonly ledger: AgendaLedger; readonly linked: number } => {
  const byId = new Map(links.map(link => [link.id, link]));
  let linked = 0;
  const entries = ledger.entries.map(entry => {
    if (entry.lifecycle !== 'active' || entry.item.notice === true || (entry.item.task ?? null) !== null) return entry;
    const link = byId.get(entry.item.id);
    if (link === undefined) return entry;
    linked += 1;
    return {
      ...entry,
      item: { ...entry.item, task: link.task, ...(link.blocking ? { blockingNow: true as const } : {}) },
    };
  });
  return linked === 0 ? { ledger, linked } : { ledger: { ...ledger, entries, updatedAt: at }, linked };
};

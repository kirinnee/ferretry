/**
 * WHAT KEEPS A FINISHED SESSION LIVE, besides its own age and kind (docs/session-archive.md § What is kept).
 *
 * Three facts, each owned by another subsystem and read here through a port: a pin the owner put on the ferret, a
 * board card still in flight that names it, and an agenda item still open on its board. Whatever cannot be read is
 * answered as KEPT — when unsure, keep it — so a broken board or a damaged agenda file can only make the archive
 * leave sessions alone, never take one that mattered.
 */

export interface ArchiveKeepSources {
  /** The ferrets the owner pinned. */
  pinned(): Promise<ReadonlySet<string>>;
  /** The sessions that own or are assigned a card that is not closed or shipped. */
  onOpenCards(): Promise<ReadonlySet<string>>;
  /** Whether the session's own agenda board holds an item that is still open. */
  hasOpenAgendaItem(sessionId: string): Promise<boolean>;
}

/** How many agenda boards are read at once: they are files, and a first pass may ask about a thousand. */
const AGENDA_READS_AT_ONCE = 8;

/** The sessions among `ids` that must stay live, each with why. */
export async function sessionKeeps(
  sources: ArchiveKeepSources,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const kept = new Map<string, string>();
  const [pinned, onCards] = await Promise.all([
    sources.pinned().then(
      set => ({ set }),
      () => undefined,
    ),
    sources.onOpenCards().then(
      set => ({ set }),
      () => undefined,
    ),
  ]);
  const pending: string[] = [];
  for (const id of ids) {
    if (pinned === undefined) kept.set(id, 'pins unreadable');
    else if (pinned.set.has(id)) kept.set(id, 'pinned');
    else if (onCards === undefined) kept.set(id, 'board unreadable');
    else if (onCards.set.has(id)) kept.set(id, 'on a card still in flight');
    else pending.push(id);
  }
  for (let at = 0; at < pending.length; at += AGENDA_READS_AT_ONCE) {
    const batch = pending.slice(at, at + AGENDA_READS_AT_ONCE);
    const answers = await Promise.all(
      batch.map(
        async id =>
          await sources.hasOpenAgendaItem(id).then(
            open => open,
            () => 'unreadable' as const,
          ),
      ),
    );
    batch.forEach((id, index) => {
      const answer = answers[index];
      if (answer === 'unreadable') kept.set(id, 'agenda unreadable');
      else if (answer === true) kept.set(id, 'open agenda item');
    });
  }
  return kept;
}

import type { LimitsView } from '@ferretry/protocol';

/** What to tell a person about this ferret's memory, or `null` when there is nothing to tell. */
export interface MemoryNote {
  readonly kind: 'slowed' | 'killed';
  readonly text: string;
}

/**
 * This ferret's memory, in plain words, from the daemon's limits view. A kill is the more important thing to
 * say, so it wins over being slowed; both are about THIS ferret only. A ferret the daemon is not talking about
 * gets no row at all: silence here means nothing happened, and the panel does not invent a clean bill.
 */
export function memoryNote(view: LimitsView, sessionId: string): MemoryNote | null {
  const kill = view.killed.findLast(entry => entry.sessionId === sessionId);
  if (kill !== undefined)
    return {
      kind: 'killed',
      text: `Something in this ferret was killed for memory${kill.what === undefined ? '' : ` (${kill.what})`}. Ferrets are kept below a memory limit so the machine stays responsive.`,
    };
  if (view.throttled.some(entry => entry.sessionId === sessionId))
    return {
      kind: 'slowed',
      text: 'Slowed for memory right now: this ferret is near its memory limit, so the machine is making it wait.',
    };
  if (view.overBudget.some(entry => entry.sessionId === sessionId))
    return {
      kind: 'slowed',
      text: 'Using more memory than its share right now. This machine only watches memory; it does not cap it.',
    };
  return null;
}

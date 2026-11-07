import type { AgendaClearAgentsResult, AgendaOpenPage } from '../../contract/index.ts';

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "3 open asks on 2 agent ferrets", in the number it is. */
export function describeClear(result: AgendaClearAgentsResult): string {
  return `${plural(result.cleared, 'open ask', 'open asks')} on ${plural(result.ferrets, 'agent ferret', 'agent ferrets')}`;
}

/** The open agenda as a human reads it: each ferret, then its asks, newest facts first as Asks gave them. */
export function renderOpen(page: AgendaOpenPage): string {
  if (page.ferrets.length === 0) return 'Nothing is waiting on you.';
  const lines: string[] = [];
  for (const group of page.ferrets) {
    lines.push(`${group.ferret} (${plural(group.asks.length, 'ask', 'asks')})`);
    for (const ask of group.asks) lines.push(`  !${ask.id} [${ask.kind}] ${ask.subject}`);
  }
  if (page.next !== undefined) lines.push('', `More: pass --after ${page.next}`);
  return lines.join('\n');
}

import type { CloseFinishedTerminalsResponse, TerminalHolder, TerminalHoldersView } from '@ferretry/protocol';

const terminals = (count: number): string => `${count} terminal${count === 1 ? '' : 's'}`;
const holder = (entry: TerminalHolder): string => `  ${entry.label} (${entry.status}): ${terminals(entry.count)}`;

/** Who holds the open terminals, finished ferrets first, as lines a person reads. */
export function renderTerminalHolders(view: TerminalHoldersView): readonly string[] {
  if (view.holders.length === 0) return [`No terminals are open (limit ${view.limit}).`];
  const finished = view.holders.filter(entry => entry.standing !== 'live');
  return [
    `${terminals(view.open)} open of ${view.limit}.`,
    ...view.holders.map(holder),
    ...(finished.length === 0
      ? []
      : ['Run `fy terminal close --all-finished` to close the finished ferrets’ terminals.']),
  ];
}

/** What closing the finished ferrets' terminals did, then who still holds the rest. */
export function renderCloseFinished(result: CloseFinishedTerminalsResponse): readonly string[] {
  return [
    result.closed === 0 && result.failed === 0
      ? 'No finished ferret holds a terminal.'
      : `Closed ${terminals(result.closed)}.`,
    ...(result.failed === 0 ? [] : [`Could not close ${terminals(result.failed)}; try again.`]),
    ...(result.holders.length === 0 ? [] : ['Still open:', ...result.holders.map(holder)]),
  ];
}

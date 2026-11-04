/**
 * THE ITEM'S TABS AS THE VIEW DRAWS THEM (&F923; docs/agenda.md § The tabs) — pure decisions; the order and the words
 * each tab holds are the protocol's (`agendaTabs`), never rebuilt here:
 *
 * - which tabs the view draws: a notice draws its body in "What I need from you" and a card gate's body is its How to
 *   test, so for those the full picture is not a tab;
 * - which tab is open: the one this device remembered while it still exists, else the first (the main tab);
 * - which tabs the last edit changed — the dot and the word "Changed" on the tab;
 * - the phone switcher's words: "Where we are now · 1 of 3 · 2 changed".
 */

import { type AgendaItem, type AgendaViewTab, agendaTabs } from '@ferretry/protocol';
import { lastRevision } from './agenda-revisions.ts';

/** The tabs the item view draws, in order. */
export const viewTabs = (item: AgendaItem, bodyElsewhere: boolean): readonly AgendaViewTab[] =>
  agendaTabs(item).filter(tab => !(bodyElsewhere && tab.kind === 'body'));

/** The open tab: the remembered one while the item still has it, else the first. */
export const openTab = (tabs: readonly AgendaViewTab[], remembered: string | null): string =>
  tabs.find(tab => tab.id === remembered)?.id ?? tabs[0]?.id ?? '';

/** The fields the main tab is drawn from: an edit of any of them changes it. */
const MAIN_FIELDS: ReadonlySet<string> = new Set(['questionAnswer', 'decided', 'stillOpen', 'whereWeAre']);

/** The ids of the tabs the item's last edit changed: what the tab row marks "Changed". */
export const changedTabs = (item: AgendaItem): ReadonlySet<string> => {
  const revision = lastRevision(item);
  if (revision === null) return new Set();
  const changed = new Set<string>();
  if (revision.changed.some(field => MAIN_FIELDS.has(field))) changed.add('main');
  if (revision.changed.includes('body')) changed.add('body');
  if (revision.changed.includes('tabs')) {
    const before = new Map((revision.previous.tabs ?? []).map(tab => [tab.id, tab]));
    for (const tab of item.tabs ?? []) {
      const was = before.get(tab.id);
      if (was === undefined || was.body !== tab.body || was.name !== tab.name) changed.add(tab.id);
    }
  }
  return changed;
};

/** The phone switcher's words: the open tab's name, where it is among the tabs, and how many changed. */
export const switcherWords = (
  tabs: readonly AgendaViewTab[],
  open: string,
  changed: ReadonlySet<string>,
): { readonly name: string; readonly meta: string } => {
  const index = Math.max(
    0,
    tabs.findIndex(tab => tab.id === open),
  );
  const marked = tabs.filter(tab => changed.has(tab.id)).length;
  const parts = [
    `${String(index + 1)} of ${String(tabs.length)}`,
    ...(marked === 0 ? [] : [`${String(marked)} changed`]),
  ];
  return { name: tabs[index]?.name ?? '', meta: parts.join(' · ') };
};

/** The tab after `open`, for the "Next: … ›" link at a tab's foot; `undefined` on the last. */
export const nextTab = (tabs: readonly AgendaViewTab[], open: string): AgendaViewTab | undefined => {
  const index = tabs.findIndex(tab => tab.id === open);
  return index < 0 ? undefined : tabs[index + 1];
};

/**
 * THE ITEM'S TABS AS THE VIEW DRAWS THEM (&F923; docs/agenda.md § The tabs) — pure decisions; the order and the words
 * each tab holds are the protocol's (`agendaTabs`), never rebuilt here:
 *
 * - which tabs the view draws: a notice draws its body in "What I need from you" and a card gate's body is its How to
 *   test, so for those the full picture is not a tab;
 * - which tab is open: the one this device remembered while it still exists, else the first (the main tab);
 * - which tabs changed since this device last looked (else in the last edit) — the dot and the word "Changed".
 */

import { type AgendaItem, type AgendaViewTab, agendaTabs } from '../wire/index.ts';
import { lastRevision } from './agenda-revisions.ts';

/** The tabs the item view draws, in order. */
export const viewTabs = (item: AgendaItem, bodyElsewhere: boolean): readonly AgendaViewTab[] =>
  agendaTabs(item).filter(tab => !(bodyElsewhere && tab.kind === 'body'));

/** The open tab: the remembered one while the item still has it, else the first. */
export const openTab = (tabs: readonly AgendaViewTab[], remembered: string | null): string =>
  tabs.find(tab => tab.id === remembered)?.id ?? tabs[0]?.id ?? '';

/** The fields the main tab is drawn from: an edit of any of them changes it. */
const MAIN_FIELDS: ReadonlySet<string> = new Set(['questionAnswer', 'decided', 'stillOpen', 'whereWeAre']);

/** The ferret's own tabs `after` has that differ from (or are not in) `before`: by id, a rename counts. */
const ownChanged = (before: AgendaItem['tabs'], after: AgendaItem['tabs']): readonly string[] => {
  const was = new Map((before ?? []).map(tab => [tab.id, tab]));
  return (after ?? [])
    .filter(tab => {
      const old = was.get(tab.id);
      return old === undefined || old.body !== tab.body || old.name !== tab.name;
    })
    .map(tab => tab.id);
};

/** The ids of the tabs the item's last edit changed: the "Changed" marks when nothing better is known. */
export const changedTabs = (item: AgendaItem): ReadonlySet<string> => {
  const revision = lastRevision(item);
  if (revision === null) return new Set();
  const changed = new Set<string>();
  if (revision.changed.some(field => MAIN_FIELDS.has(field))) changed.add('main');
  if (revision.changed.includes('body')) changed.add('body');
  if (revision.changed.includes('tabs'))
    for (const id of ownChanged(revision.previous.tabs, item.tabs)) changed.add(id);
  return changed;
};

/**
 * The ids of the tabs that differ between the version this device last saw (`seen`) and `now`: the "Changed" marks
 * "since you last looked", so a tab edit stays marked when a later edit only touched the title.
 */
export const tabsChangedSince = (seen: AgendaItem, now: AgendaItem): ReadonlySet<string> => {
  const changed = new Set<string>();
  const text = (item: AgendaItem, field: string): string => {
    const value = (item as unknown as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  };
  if ([...MAIN_FIELDS].some(field => text(seen, field) !== text(now, field))) changed.add('main');
  if (text(seen, 'body') !== text(now, 'body')) changed.add('body');
  for (const id of ownChanged(seen.tabs, now.tabs)) changed.add(id);
  return changed;
};

/**
 * The drawn tab a section of the Changes panel belongs to, so the panel can open it: the main tab's parts, the full
 * picture, one of the ferret's own tabs (`tab:<id>`). `undefined` for any other section, or a tab not drawn.
 */
export const sectionTab = (key: string, tabs: readonly AgendaViewTab[]): AgendaViewTab | undefined => {
  const id = MAIN_FIELDS.has(key)
    ? 'main'
    : key === 'body'
      ? 'body'
      : key.startsWith('tab:')
        ? key.slice('tab:'.length)
        : undefined;
  // A fixed tab is matched by kind, never by an own tab that happens to share its id.
  return tabs.find(tab => tab.id === id && (tab.kind === 'own') === key.startsWith('tab:'));
};

/** The tab after `open`, for the "Next: … ›" link at a tab's foot; `undefined` on the last. */
export const nextTab = (tabs: readonly AgendaViewTab[], open: string): AgendaViewTab | undefined => {
  const index = tabs.findIndex(tab => tab.id === open);
  return index < 0 ? undefined : tabs[index + 1];
};

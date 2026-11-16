/**
 * THE ITEM'S TABS, IN ORDER — the one owner of which tabs an item has and what each holds (&F923; docs/agenda.md
 * § The tabs). The app, the CLI and the Changes diff read the tabs through `agendaTabs`, and none of them rebuilds the
 * order:
 *
 *   1. "Where we are now" — the MAIN tab, always first: the ferret's answer to the owner's question, what is decided,
 *      what is still open, then `whereWeAre`.
 *   2. "The full picture" (or "Reasoning" on a review) — `body`.
 *   3. The ferret's own tabs, in their order (`tabs`).
 *
 * A tab with nothing in it is left out, so an item with only a body has one tab — and one tab draws no tab row.
 *
 * `applyAgendaTabEdits` turns an edit's tab operations into the new `tabs`, so the daemon stores the whole list
 * through its ordinary edit path: one edit is one version and one revision.
 */

import {
  AGENDA_BODY_TAB_ID,
  AGENDA_BODY_TAB_NAME,
  AGENDA_MAIN_TAB_ID,
  AGENDA_MAIN_TAB_NAME,
  AGENDA_REVIEW_BODY_TAB_NAME,
  type AgendaItem,
  type AgendaTab,
  type AgendaTabEdit,
  agendaTabNameProblem,
  agendaTabProblems,
} from './agenda.ts';
import { agendaCardKind } from './agenda-card.ts';

/** One tab as a reader sees it. The main tab's parts are separate, so each draws in its own block. */
export type AgendaViewTab =
  | {
      readonly kind: 'main';
      readonly id: string;
      readonly name: string;
      readonly questionAnswer?: string;
      readonly decided?: string;
      readonly stillOpen?: string;
      readonly whereWeAre?: string;
    }
  | { readonly kind: 'body'; readonly id: string; readonly name: string; readonly body: string }
  | { readonly kind: 'own'; readonly id: string; readonly name: string; readonly body: string };

type TabSource = Pick<
  AgendaItem,
  'questionAnswer' | 'decided' | 'stillOpen' | 'whereWeAre' | 'body' | 'tabs' | 'kind' | 'ask'
>;

const filled = (text: string | undefined): text is string => text !== undefined && text.trim() !== '';

/** The item's tabs in order, the empty ones left out. */
export const agendaTabs = (item: TabSource): readonly AgendaViewTab[] => {
  const main = {
    ...(filled(item.questionAnswer) ? { questionAnswer: item.questionAnswer } : {}),
    ...(filled(item.decided) ? { decided: item.decided } : {}),
    ...(filled(item.stillOpen) ? { stillOpen: item.stillOpen } : {}),
    ...(filled(item.whereWeAre) ? { whereWeAre: item.whereWeAre } : {}),
  };
  const bodyName = agendaCardKind(item) === 'review' ? AGENDA_REVIEW_BODY_TAB_NAME : AGENDA_BODY_TAB_NAME;
  return [
    ...(Object.keys(main).length === 0
      ? []
      : [{ kind: 'main' as const, id: AGENDA_MAIN_TAB_ID, name: AGENDA_MAIN_TAB_NAME, ...main }]),
    ...(filled(item.body) ? [{ kind: 'body' as const, id: AGENDA_BODY_TAB_ID, name: bodyName, body: item.body }] : []),
    ...(item.tabs ?? []).map(tab => ({ kind: 'own' as const, id: tab.id, name: tab.name, body: tab.body })),
  ];
};

/** A tab's id: its name's slug, made unique among `taken` with `-2`, `-3`… — never one of the fixed tabs' ids. */
export const agendaTabId = (name: string, taken: ReadonlySet<string>): string => {
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 28)
      .replace(/-+$/u, '') || 'tab';
  const used = new Set([...taken, AGENDA_MAIN_TAB_ID, AGENDA_BODY_TAB_ID]);
  if (!used.has(slug)) return slug;
  let next = 2;
  while (used.has(`${slug}-${String(next)}`)) next += 1;
  return `${slug}-${String(next)}`;
};

/**
 * The tab `ref` names: by name in any case, else by id. A name is never another tab's id (`agendaTabProblems`), so the
 * two never point at different tabs: renaming Status to Progress keeps the id "status", and then no other tab may be
 * called Status.
 */
export const findAgendaTab = (tabs: readonly Pick<AgendaTab, 'id' | 'name'>[], ref: string): number => {
  const byName = tabs.findIndex(tab => tab.name.toLowerCase() === ref.trim().toLowerCase());
  return byName >= 0 ? byName : tabs.findIndex(tab => tab.id === ref.trim().toLowerCase());
};

export type AgendaTabEditResult =
  | { readonly ok: true; readonly tabs: readonly AgendaTab[] }
  | { readonly ok: false; readonly problem: string };

/**
 * The ferret's own tabs after `edits`, applied in order: a body makes the tab (when no tab has that name yet) or
 * rewrites it; `rename` keeps its id; `position` moves it (1 = first of the ferret's own tabs); `remove` takes it
 * away. The first operation that cannot apply is the refusal, in plain words; the fixed tabs are never touched here.
 */
export const applyAgendaTabEdits = (
  current: readonly AgendaTab[] | undefined,
  edits: readonly AgendaTabEdit[],
): AgendaTabEditResult => {
  let tabs: AgendaTab[] = [...(current ?? [])];
  for (const edit of edits) {
    if (/^(?:main|body)$/iu.test(edit.tab) || agendaTabNameProblem(edit.tab)?.includes('fixed tab') === true)
      return { ok: false, problem: 'the main tab is --where-file and the full picture is --body-file, not a tab edit' };
    const at = findAgendaTab(tabs, edit.tab);
    if (edit.remove === true) {
      if (at < 0) return { ok: false, problem: `there is no tab "${edit.tab}" to remove` };
      tabs = tabs.filter((_, index) => index !== at);
      continue;
    }
    let index = at;
    if (index < 0) {
      if (edit.body === undefined)
        return { ok: false, problem: `there is no tab "${edit.tab}": a new tab needs its words (--tab-file)` };
      const nameProblem = agendaTabNameProblem(edit.tab);
      if (nameProblem !== undefined) return { ok: false, problem: nameProblem };
      tabs = [
        ...tabs,
        {
          // Never another tab's id NOR another tab's name: a reference always means one tab.
          id: agendaTabId(edit.tab, new Set(tabs.flatMap(tab => [tab.id, tab.name.toLowerCase()]))),
          name: edit.tab,
          body: edit.body,
        },
      ];
      index = tabs.length - 1;
    } else if (edit.body !== undefined) {
      tabs = tabs.map((tab, each) => (each === index ? { ...tab, body: edit.body as string } : tab));
    }
    if (edit.rename !== undefined) {
      const nameProblem = agendaTabNameProblem(edit.rename);
      if (nameProblem !== undefined) return { ok: false, problem: nameProblem };
      const rename = edit.rename;
      tabs = tabs.map((tab, each) => (each === index ? { ...tab, name: rename } : tab));
    }
    if (edit.position !== undefined) {
      const moved = tabs[index] as AgendaTab;
      const rest = tabs.filter((_, each) => each !== index);
      const to = Math.min(edit.position, rest.length + 1) - 1;
      tabs = [...rest.slice(0, to), moved, ...rest.slice(to)];
    }
  }
  const problem = agendaTabProblems(tabs)[0];
  return problem === undefined ? { ok: true, tabs } : { ok: false, problem };
};

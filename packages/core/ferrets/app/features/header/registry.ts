/**
 * THE FERRET ACTIONS REGISTRY — what Actions ▾ offers for one ferret, as data. Pure.
 *
 * The header has one rule: INFO is for looking, ACTIONS is for doing. Everything a person can do to a ferret from its
 * header — rename it, fork it, move it, restart or stop it — is an entry here, and the menu draws whatever the
 * registry answers. The menu knows nothing about any action; an action knows nothing about the menu.
 *
 * CONTRIBUTIONS, NOT A GLOBAL LIST. A feature adds itself by handing the panel one more {@link FerretActionContribution}.
 * There is no module-level registry to mutate: the panel composes the core contributions with whatever its host passes,
 * so two panels — or a test — can never see each other's actions, and an unmounted feature leaves nothing behind.
 *
 * FOUR SHAPES OF ENTRY, because a menu row behaves one of four ways:
 *   run      does it at once (Copy ferret id)
 *   confirm  asks INSIDE the menu first — no modal, no `confirm()` — then does it (Restart, Stop)
 *   toggle   a menuitemcheckbox that flips a setting
 *   form     a "…" item that opens a small form: a popover on a desktop, a sheet on a phone
 * and one more state any of them can be in: `unavailable`, drawn dimmed with the reason, for an action that exists but
 * cannot be done here yet (Move to another machine).
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The menu's sections, in the order they are drawn. */
export type FerretActionGroup = 'ferret' | 'move' | 'danger';

export const FERRET_ACTION_GROUPS: readonly FerretActionGroup[] = ['ferret', 'move', 'danger'];

export const FERRET_ACTION_GROUP_LABEL: Readonly<Record<FerretActionGroup, string>> = {
  ferret: 'Ferret',
  move: 'Move',
  danger: 'Danger',
};

/** What every entry says about itself. */
interface EntryBase {
  /** Stable within one menu; also the `data-ferret-action-item` hook. */
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A short fact at the row's end: the current login, "On", "later". */
  readonly detail?: string;
  /** Destructive tone. The words say it too; colour only reinforces. */
  readonly danger?: boolean;
  /** Why this cannot be done here yet. Present means the row is drawn dimmed and does nothing. */
  readonly unavailable?: string;
}

/** Closes the form and, when it settled something, says what. */
export interface FerretActionFormHost {
  readonly close: () => void;
  /** Re-opens another action's form in place of this one. */
  readonly open: (actionId: string) => void;
  /** Says, in one short toast, what a form settled that the reader will not see happen here. */
  readonly notify: (sentence: string) => void;
  /** Phone layout: the form is in a sheet, rows are 44px. */
  readonly compact: boolean;
}

export type FerretActionEntry =
  | (EntryBase & { readonly kind: 'run'; readonly run: () => Promise<void> | void })
  | (EntryBase & {
      readonly kind: 'confirm';
      /** The question, in the menu: "Stop Hadi?" */
      readonly question: string;
      /** What happens, one line under the question. */
      readonly consequence: string;
      /** The button that does it: "Stop ferret". */
      readonly confirmLabel: string;
      readonly run: () => Promise<void> | void;
    })
  | (EntryBase & {
      readonly kind: 'toggle';
      readonly checked: boolean;
      readonly onToggle: (next: boolean) => Promise<void> | void;
    })
  | (EntryBase & {
      readonly kind: 'form';
      /** The form's title, as its popover or sheet heading. */
      readonly title: string;
      readonly render: (host: FerretActionFormHost) => ReactNode;
    });

/** One action a feature contributes: where it sits, and — for this ferret, right now — what it is. */
export interface FerretActionContribution<Context> {
  readonly group: FerretActionGroup;
  /** Within its group, lower first. Core actions use multiples of 10 so a contribution can slot between. */
  readonly order: number;
  /** The entry, or null when the action does not apply to this ferret at all (hidden, not dimmed). */
  readonly build: (context: Context) => FerretActionEntry | null;
}

export interface FerretActionSection {
  readonly group: FerretActionGroup;
  readonly label: string;
  readonly entries: readonly FerretActionEntry[];
}

/**
 * The menu's sections for one ferret: every contribution built, the nulls dropped, each group in order, and an empty
 * group left out entirely so the menu never draws a heading over nothing. Two entries with the same id keep the first,
 * so a duplicate contribution cannot draw two rows.
 */
export const ferretActionSections = <Context>(
  contributions: readonly FerretActionContribution<Context>[],
  context: Context,
): FerretActionSection[] => {
  const seen = new Set<string>();
  const built = contributions
    .map((contribution, index) => ({ contribution, index, entry: contribution.build(context) }))
    .filter((item): item is typeof item & { entry: FerretActionEntry } => item.entry !== null)
    .filter(item => {
      if (seen.has(item.entry.id)) return false;
      seen.add(item.entry.id);
      return true;
    });
  return FERRET_ACTION_GROUPS.map(group => ({
    group,
    label: FERRET_ACTION_GROUP_LABEL[group],
    entries: built
      .filter(item => item.contribution.group === group)
      .sort((left, right) => left.contribution.order - right.contribution.order || left.index - right.index)
      .map(item => item.entry),
  })).filter(section => section.entries.length > 0);
};

/** The entry with this id, wherever it sits — how a form opens another action's form. */
export const findFerretAction = (sections: readonly FerretActionSection[], id: string): FerretActionEntry | undefined =>
  sections.flatMap(section => section.entries).find(entry => entry.id === id);

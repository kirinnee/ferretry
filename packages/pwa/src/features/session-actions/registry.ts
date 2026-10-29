/**
 * THE SESSION ACTIONS REGISTRY — what Actions ▾ offers for one ferret, as data. Pure.
 *
 * The session header has one rule (docs: the Info / Actions spec, §1): INFO is for looking, ACTIONS is
 * for doing. Everything a person can do to a ferret from its header — rename it, fork it, move it,
 * add an MCP server, restart or stop it — is an entry here, and the menu draws whatever the registry
 * answers. The menu knows nothing about any action; an action knows nothing about the menu.
 *
 * CONTRIBUTIONS, NOT A GLOBAL LIST. A later feature (the Warden's "Ask the Warden to investigate",
 * Learning's "Passive learning" and "Scan this ferret") adds itself by handing the page one more
 * {@link SessionActionContribution}. There is no module-level registry to mutate: the page composes
 * the core contributions with whatever its host passes, so two pages — or a test — can never see each
 * other's actions, and an unmounted feature leaves nothing behind.
 *
 * FOUR SHAPES OF ENTRY, because a menu row behaves one of four ways:
 *   run      does it at once (Copy session id)
 *   confirm  asks INSIDE the menu first — no modal, no `confirm()` — then does it (Restart CLI, Stop)
 *   toggle   a menuitemcheckbox that flips a setting (Passive learning: On/Off)
 *   form     a "…" item that opens a small form: a popover on a desktop, a sheet on a phone
 * and one more state any of them can be in: `unavailable`, drawn dimmed with the reason, for an action
 * that exists but cannot be done here yet (Move to another machine).
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The menu's sections, in the order they are drawn. */
export type SessionActionGroup = 'session' | 'move' | 'tools' | 'learning' | 'warden' | 'danger';

export const SESSION_ACTION_GROUPS: readonly SessionActionGroup[] = [
  'session',
  'move',
  'tools',
  'learning',
  'warden',
  'danger',
];

export const SESSION_ACTION_GROUP_LABEL: Readonly<Record<SessionActionGroup, string>> = {
  session: 'Session',
  move: 'Move',
  tools: 'Tools',
  learning: 'Learning',
  warden: 'Warden',
  danger: 'Danger',
};

/** What every entry says about itself. */
interface EntryBase {
  /** Stable within one menu; also the `data-session-action-item` hook. */
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
export interface SessionActionFormHost {
  readonly close: () => void;
  /** Re-opens another action's form in place of this one ("Add MCP server" → "Reload this ferret"). */
  readonly open: (actionId: string) => void;
  /**
   * Says, in one short toast, what a form settled that the reader will not see happen here: "queued —
   * the report lands in Info › Signals". The form closes itself; the toast outlives it.
   */
  readonly notify: (sentence: string) => void;
  /** Phone layout: the form is in a sheet, rows are 44px. */
  readonly compact: boolean;
}

export type SessionActionEntry =
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
      /**
       * `drawer` is for a LIST, not a form: a right-hand drawer under a dimmed backdrop on a desktop, a
       * full-screen sheet on a phone, with a header and ✕ the frame draws. Absent, the form hangs in a
       * popover (desktop) or a bottom sheet (phone) under its own `title` heading.
       */
      readonly presentation?: 'drawer';
      /** A drawer's visible heading when it should say more than `title` does: "Resolved · 7". */
      readonly heading?: string;
      readonly render: (host: SessionActionFormHost) => ReactNode;
    });

/** One action a feature contributes: where it sits, and — for this ferret, right now — what it is. */
export interface SessionActionContribution<Context> {
  readonly group: SessionActionGroup;
  /** Within its group, lower first. Core actions use multiples of 10 so a contribution can slot between. */
  readonly order: number;
  /** The entry, or null when the action does not apply to this ferret at all (hidden, not dimmed). */
  readonly build: (context: Context) => SessionActionEntry | null;
}

export interface SessionActionSection {
  readonly group: SessionActionGroup;
  readonly label: string;
  readonly entries: readonly SessionActionEntry[];
}

/**
 * The menu's sections for one ferret: every contribution built, the nulls dropped, each group in
 * order, and an empty group left out entirely so the menu never draws a heading over nothing.
 * Two entries with the same id keep the first, so a duplicate contribution cannot draw two rows.
 */
export const sessionActionSections = <Context>(
  contributions: readonly SessionActionContribution<Context>[],
  context: Context,
): SessionActionSection[] => {
  const seen = new Set<string>();
  const built = contributions
    .map((contribution, index) => ({ contribution, index, entry: contribution.build(context) }))
    .filter((item): item is typeof item & { entry: SessionActionEntry } => item.entry !== null)
    .filter(item => {
      if (seen.has(item.entry.id)) return false;
      seen.add(item.entry.id);
      return true;
    });
  return SESSION_ACTION_GROUPS.map(group => ({
    group,
    label: SESSION_ACTION_GROUP_LABEL[group],
    entries: built
      .filter(item => item.contribution.group === group)
      .sort((left, right) => left.contribution.order - right.contribution.order || left.index - right.index)
      .map(item => item.entry),
  })).filter(section => section.entries.length > 0);
};

/** The entry with this id, wherever it sits — how a form opens another action's form. */
export const findSessionAction = (
  sections: readonly SessionActionSection[],
  id: string,
): SessionActionEntry | undefined => sections.flatMap(section => section.entries).find(entry => entry.id === id);

/** Every row the keyboard can land on, in drawn order. */
export const focusableEntries = (sections: readonly SessionActionSection[]): SessionActionEntry[] =>
  sections.flatMap(section => section.entries).filter(entry => entry.unavailable === undefined);

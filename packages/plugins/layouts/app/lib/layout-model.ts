/**
 * THE LAYOUT SETTINGS, as data (§5.3): which keys of a layout the tab edits, what each is called, and what a person
 * may choose. Pure — the tab draws it and the two places that save a change (the owner's `config/layout.yaml` through
 * Layouts' own routes, this device's choice in the app's saved data) both take the same dotted path and word the
 * `fy layout set` verb takes, so one row means the same thing in either scope.
 */
import type { Layout } from '../../contract/index.ts';

interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  /** The tooltip: what this choice does. */
  readonly title: string;
}

/**
 * ONLY WHAT THE SHELL DRAWS. The menu is always the left side bar (`drawer.tsx`); a side of `right` or `top` and a style of
 * `bar` draw exactly what `left` and `list` draw, so they are not offered. A layout that still names one (the built-in
 * default says `top` and `bar`; `fy layout set` accepts them) reads as the choice it draws, `unlisted`, with no migration.
 */
const NAV_SIDE_OPTIONS: readonly ChoiceOption[] = [
  { id: 'left', label: 'Left', title: 'The menu is a side bar down the left edge.' },
  { id: 'bottom', label: 'Bottom', title: 'The side bar stays, and a bar of places runs along the bottom.' },
];
const NAV_STYLE_OPTIONS: readonly ChoiceOption[] = [
  { id: 'rail', label: 'Rail', title: 'The side bar starts as a slim strip of icons.' },
  { id: 'list', label: 'List', title: 'The side bar starts open, each place with its icon and name.' },
];
const SIDE_SHOW_OPTIONS: readonly ChoiceOption[] = [
  { id: 'never', label: 'Never', title: 'No ferret list.' },
  { id: 'wide-only', label: 'Wide screens', title: 'The ferret list on a wide screen; on a phone it is in the menu.' },
  { id: 'always', label: 'Always', title: 'The ferret list on every screen.' },
];
const PHONE_SIDE_SHOW_OPTIONS: readonly ChoiceOption[] = [
  { id: 'never', label: 'Never', title: 'The menu holds the places only, with no ferret list.' },
  { id: 'wide-only', label: 'Wide screens', title: 'The ferret list is in the menu, not beside the page.' },
  {
    id: 'always',
    label: 'Always',
    title: 'The ferret list is in the menu, and beside the page when the layout puts it on the right.',
  },
];

/** A key that takes one word out of a short list. */
export interface ChoiceSetting {
  readonly kind: 'choice';
  readonly path:
    | 'nav.side'
    | 'nav.style'
    | 'side.show'
    | 'density'
    | 'phone.nav.side'
    | 'phone.nav.style'
    | 'phone.side.show'
    | 'phone.density';
  readonly name: string;
  readonly hint: string;
  readonly options: readonly ChoiceOption[];
  /** The choice a word that is not offered reads as: the one the shell draws it as. */
  readonly unlisted?: string;
}

/** A key that takes a list of view names, drawn as rows you drag and switch (`list-places.ts`), never as typed text. */
export interface ListSetting {
  readonly kind: 'list';
  readonly path: 'nav.items' | 'top' | 'panels.ferret.side' | 'phone.nav.items' | 'phone.top';
  readonly name: string;
  readonly hint: string;
}

export type LayoutSetting = ChoiceSetting | ListSetting;

export const LAYOUT_SETTINGS: readonly LayoutSetting[] = [
  {
    kind: 'choice',
    path: 'nav.side',
    name: 'Navigation side',
    hint: 'Where the navigation sits',
    options: NAV_SIDE_OPTIONS,
    unlisted: 'left',
  },
  {
    kind: 'choice',
    path: 'nav.style',
    name: 'Navigation style',
    hint: 'How the navigation is drawn',
    options: NAV_STYLE_OPTIONS,
    unlisted: 'list',
  },
  {
    kind: 'choice',
    path: 'side.show',
    name: 'Second column',
    hint: 'The column beside the page',
    options: SIDE_SHOW_OPTIONS,
  },
  {
    kind: 'choice',
    path: 'density',
    name: 'Density',
    hint: 'How much room each row takes',
    options: [
      { id: 'comfortable', label: 'Comfortable', title: 'Room between rows.' },
      { id: 'compact', label: 'Compact', title: 'Keep rows close, to see more at once.' },
    ],
  },
  {
    kind: 'list',
    path: 'nav.items',
    name: 'Navigation items',
    hint: 'Drag to reorder; the eye hides a screen from the navigation',
  },
  {
    kind: 'list',
    path: 'top',
    name: 'Top bar',
    hint: 'Drag to reorder; the eye hides an item from the top bar',
  },
  {
    kind: 'list',
    path: 'panels.ferret.side',
    name: 'Ferret side panels',
    hint: 'Drag to reorder; the eye hides a panel beside a ferret',
  },
  {
    kind: 'choice',
    path: 'phone.nav.side',
    name: 'Phone navigation side',
    hint: 'Where the navigation sits on a narrow screen',
    options: NAV_SIDE_OPTIONS,
    unlisted: 'left',
  },
  {
    kind: 'choice',
    path: 'phone.nav.style',
    name: 'Phone navigation style',
    hint: 'How the navigation is drawn on a narrow screen',
    options: NAV_STYLE_OPTIONS,
    unlisted: 'list',
  },
  {
    kind: 'choice',
    path: 'phone.side.show',
    name: 'Phone second column',
    hint: 'The column beside the page on a narrow screen',
    options: PHONE_SIDE_SHOW_OPTIONS,
  },
  {
    kind: 'choice',
    path: 'phone.density',
    name: 'Phone density',
    hint: 'How much room each row takes on a narrow screen',
    options: [
      { id: 'comfortable', label: 'Comfortable', title: 'Room between rows.' },
      { id: 'compact', label: 'Compact', title: 'Keep rows close, to see more at once.' },
    ],
  },
  {
    kind: 'list',
    path: 'phone.nav.items',
    name: 'Phone navigation items',
    hint: 'Drag to reorder; the eye hides a screen from the navigation on a narrow screen',
  },
  {
    kind: 'list',
    path: 'phone.top',
    name: 'Phone top bar',
    hint: 'Drag to reorder; the eye hides an item from the top bar on a narrow screen',
  },
];

/**
 * The word a choice key currently holds. A phone key the layout does not set follows the wide one, the way the shell
 * lays `phone` over the layout.
 */
export function choiceOf(layout: Layout, path: ChoiceSetting['path']): string {
  const word = wordOf(layout, path);
  const setting = LAYOUT_SETTINGS.find(entry => entry.kind === 'choice' && entry.path === path);
  if (setting?.kind !== 'choice' || setting.unlisted === undefined) return word;
  return setting.options.some(option => option.id === word) ? word : setting.unlisted;
}

function wordOf(layout: Layout, path: ChoiceSetting['path']): string {
  switch (path) {
    case 'nav.side':
      return layout.nav.side;
    case 'nav.style':
      return layout.nav.style;
    case 'side.show':
      return layout.side.show;
    case 'density':
      return layout.density;
    case 'phone.nav.side':
      return layout.phone?.nav?.side ?? layout.nav.side;
    case 'phone.nav.style':
      return layout.phone?.nav?.style ?? layout.nav.style;
    case 'phone.side.show':
      return layout.phone?.side?.show ?? layout.side.show;
    case 'phone.density':
      return layout.phone?.density ?? layout.density;
  }
}

/** The names a list key currently holds; a phone list the layout does not set follows the wide one. */
export function listOf(layout: Layout, path: ListSetting['path']): readonly string[] {
  switch (path) {
    case 'nav.items':
      return layout.nav.items;
    case 'top':
      return layout.top;
    case 'panels.ferret.side':
      return layout.panels['ferret.side'] ?? [];
    case 'phone.nav.items':
      return layout.phone?.nav?.items ?? layout.nav.items;
    case 'phone.top':
      return layout.phone?.top ?? layout.top;
  }
}

/** A saved layout's id may only be what Layouts accepts: lowercase words joined by dashes. */
export const LAYOUT_ID = /^[a-z][a-z0-9-]*$/u;

/**
 * Why a refusal is worded as it is: the daemon names the cause in a sentence and, for a layout it cannot use, one line
 * per name it did not find (`{ path, message }`). The tab shows the sentence and the first line, never a status code.
 */
export function refusalSentence(error: unknown): string {
  if (!(error instanceof Error)) return 'The change did not go through.';
  const body = (error as { body?: unknown }).body;
  const issues =
    typeof body === 'object' && body !== null && Array.isArray((body as { issues?: unknown }).issues)
      ? ((body as { issues: unknown[] }).issues as unknown[])
      : [];
  const first = issues[0];
  const detail =
    typeof first === 'object' && first !== null && typeof (first as { message?: unknown }).message === 'string'
      ? (first as { message: string }).message
      : undefined;
  return detail === undefined ? error.message : `${error.message}: ${detail}`;
}

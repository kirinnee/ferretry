/**
 * THE LAYOUT SETTINGS, as data (§5.3): which keys of a layout the tab edits, what each is called, and what a person
 * may choose. Pure — the tab draws it and the two places that save a change (the owner's `config/layout.yaml` through
 * Layouts' own routes, this device's choice in the app's saved data) both take the same dotted path and word the
 * `fy layout set` verb takes, so one row means the same thing in either scope.
 */
import type { Layout } from '../../contract/index.ts';
import type { Change } from './list-places.ts';

interface ChoiceOption {
  readonly id: string;
  readonly label: string;
  /** The tooltip: what this choice does. */
  readonly title: string;
}

/**
 * ONLY WHAT THE SHELL DRAWS. The menu is always the side bar (`drawer.tsx`); the one question is where its places go:
 * docked at its foot as icons or as words (the default, r11 S1), as a list at its top, or in a bar along the bottom. That is ONE
 * choice (`nav.form`) written to up to three layout keys (`nav.side`, `nav.style`, `nav.labels`), so a person never has to know
 * the keys. A stored side of `right` or `top` and a style of `bar` or `rail` read as the form the shell draws them as, with no
 * migration. A phone's drawer is the same drawer: its one switch is whether a bottom bar is drawn as well (owner, C2).
 */
const NAV_FORM_OPTIONS: readonly ChoiceOption[] = [
  {
    id: 'dock-icons',
    label: 'Sidebar foot (icons)',
    title: 'The places are a row of icons at the foot of the side bar. Hover one for its name.',
  },
  {
    id: 'dock-words',
    label: 'Sidebar foot (words)',
    title: 'The places are icon and name cells at the foot of the side bar.',
  },
  { id: 'list', label: 'Side list', title: 'The places are a list at the top of the side bar.' },
  {
    id: 'bottom',
    label: 'Bottom bar',
    title: 'A bar of places runs along the bottom of the page, and the side bar holds none.',
  },
];
const PHONE_NAV_SIDE_OPTIONS: readonly ChoiceOption[] = [
  {
    id: 'left',
    label: 'In the menu',
    title: 'The places are at the foot of the menu: one tap to open it, and the page has the whole screen.',
  },
  {
    id: 'bottom',
    label: 'Bottom bar',
    title: 'A bar of places runs along the bottom of the screen, always one tap away.',
  },
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
  readonly path: 'nav.form' | 'side.show' | 'density' | 'phone.nav.side' | 'phone.side.show' | 'phone.density';
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
    path: 'nav.form',
    name: 'Navigation',
    hint: 'Where the places are: at the foot of the side bar as icons or words, a list at its top, or a bar along the bottom',
    options: NAV_FORM_OPTIONS,
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
    name: 'Phone navigation',
    hint: 'On a narrow screen the places follow the Navigation choice, in the menu; this adds a bottom bar',
    options: PHONE_NAV_SIDE_OPTIONS,
    unlisted: 'left',
  },
  {
    kind: 'choice',
    path: 'phone.side.show',
    name: 'Phone second column',
    hint: 'Never: no ferret list. Wide screens: the list is in the menu. Always: also beside the page when the layout puts it on the right',
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
    case 'nav.form':
      return navFormOf(layout.nav);
    case 'side.show':
      return layout.side.show;
    case 'density':
      return layout.density;
    case 'phone.nav.side':
      return layout.phone?.nav?.side ?? layout.nav.side;
    case 'phone.side.show':
      return layout.phone?.side?.show ?? layout.side.show;
    case 'phone.density':
      return layout.phone?.density ?? layout.density;
  }
}

/** The one navigation word a layout's `nav` reads as; a stored word the shell draws as another reads as that one. */
function navFormOf(nav: Layout['nav']): string {
  if (nav.side === 'bottom') return 'bottom';
  if (nav.style === 'list' || nav.style === 'rail') return 'list';
  return nav.labels === 'words' ? 'dock-words' : 'dock-icons';
}

/**
 * What a layout or theme is called in a chooser: a built-in preset by its name in plain words ("Default", "Sidebar left"),
 * a saved one by the name the owner gave it, marked as theirs.
 */
export function presetLabel(id: string, origin: 'built-in' | 'saved'): string {
  if (origin === 'saved') return `${id} (saved)`;
  const words = id.replaceAll('-', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The keys one word of a choice is saved to (`nav.form` is three keys); any other choice is its one key. */
export function changesFor(path: ChoiceSetting['path'], word: string): readonly Change[] {
  if (path !== 'nav.form') return [{ path, value: word }];
  if (word === 'bottom') return [{ path: 'nav.side', value: 'bottom' }];
  if (word === 'list')
    return [
      { path: 'nav.side', value: 'left' },
      { path: 'nav.style', value: 'list' },
    ];
  return [
    { path: 'nav.side', value: 'left' },
    { path: 'nav.style', value: 'dock' },
    { path: 'nav.labels', value: word === 'dock-words' ? 'words' : 'icons' },
  ];
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

/** The headed groups of the page, and the keys each holds, in the order they are drawn. */
export const LAYOUT_SECTIONS: readonly {
  readonly id: 'navigation' | 'page' | 'phone';
  readonly name: string;
  readonly paths: readonly LayoutSetting['path'][];
}[] = [
  { id: 'navigation', name: 'Navigation', paths: ['nav.form', 'nav.items'] },
  { id: 'page', name: 'The page', paths: ['side.show', 'density', 'top', 'panels.ferret.side'] },
  {
    id: 'phone',
    name: 'On a phone',
    paths: ['phone.nav.side', 'phone.side.show', 'phone.density', 'phone.nav.items', 'phone.top'],
  },
];

/** The words the page uses for the two places a change can be saved. Owner words, verbatim. */
export const SCOPE_WORDS = { all: 'Same on all my devices', device: 'Just this device' } as const;
export type Scope = keyof typeof SCOPE_WORDS;

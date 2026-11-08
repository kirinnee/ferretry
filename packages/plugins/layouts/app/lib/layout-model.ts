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

/** A key that takes one word out of a short list. */
export interface ChoiceSetting {
  readonly kind: 'choice';
  readonly path: 'nav.side' | 'nav.style' | 'side.show' | 'density';
  readonly name: string;
  readonly hint: string;
  readonly options: readonly ChoiceOption[];
}

/** A key that takes a list of view names (`agenda, board`). */
export interface ListSetting {
  readonly kind: 'list';
  readonly path: 'nav.items' | 'top' | 'panels.ferret.side';
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
    options: [
      { id: 'left', label: 'Left', title: 'A column down the left edge.' },
      { id: 'right', label: 'Right', title: 'A column down the right edge.' },
      { id: 'top', label: 'Top', title: 'A row along the top.' },
      { id: 'bottom', label: 'Bottom', title: 'A row along the bottom.' },
    ],
  },
  {
    kind: 'choice',
    path: 'nav.style',
    name: 'Navigation style',
    hint: 'How the navigation is drawn',
    options: [
      { id: 'rail', label: 'Rail', title: 'Icons in a slim strip.' },
      { id: 'bar', label: 'Bar', title: 'Icons with names in a bar.' },
      { id: 'list', label: 'List', title: 'Names in a list.' },
    ],
  },
  {
    kind: 'choice',
    path: 'side.show',
    name: 'Second column',
    hint: 'The column beside the page',
    options: [
      { id: 'never', label: 'Never', title: 'No second column.' },
      { id: 'wide-only', label: 'Wide screens', title: 'Only when the screen is wide.' },
      { id: 'always', label: 'Always', title: 'On every screen.' },
    ],
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
    hint: 'The screens in the navigation, in order, separated by commas',
  },
  {
    kind: 'list',
    path: 'top',
    name: 'Top bar',
    hint: 'What the top bar shows, in order, separated by commas',
  },
  {
    kind: 'list',
    path: 'panels.ferret.side',
    name: 'Ferret side panels',
    hint: 'The panels beside a ferret, in order, separated by commas',
  },
];

/** The word a choice key currently holds. */
export function choiceOf(layout: Layout, path: ChoiceSetting['path']): string {
  switch (path) {
    case 'nav.side':
      return layout.nav.side;
    case 'nav.style':
      return layout.nav.style;
    case 'side.show':
      return layout.side.show;
    case 'density':
      return layout.density;
  }
}

/** The names a list key currently holds. */
export function listOf(layout: Layout, path: ListSetting['path']): readonly string[] {
  switch (path) {
    case 'nav.items':
      return layout.nav.items;
    case 'top':
      return layout.top;
    case 'panels.ferret.side':
      return layout.panels['ferret.side'] ?? [];
  }
}

/** A list as the text box shows it. */
export const listText = (names: readonly string[]): string => names.join(', ');

/** A list as the text box was typed: names split at commas, blanks dropped (the same split the daemon makes). */
export function parseListText(text: string): readonly string[] {
  return text
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
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

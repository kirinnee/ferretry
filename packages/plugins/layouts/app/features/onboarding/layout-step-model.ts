/**
 * THE LAYOUT STEP, as data (O14): the two questions the first run asks about THIS device, what each answer is called,
 * which keys of the layout it writes, and how today's layout reads as an answer. Pure: no React, no storage.
 *
 * The answers go to this device only (`fy:app:layout`, through the shell's `DeviceLayout.set`): the owner's layout for
 * every device is Settings › Layout's to change. A phone-only key is written too when the layout in force sets one,
 * because that key would otherwise hide the answer on a phone.
 */
import type { Layout } from '../../../contract/index.ts';

type LayoutQuestionId = 'nav' | 'density';

interface LayoutAnswer {
  readonly id: string;
  readonly title: string;
  readonly line: string;
}

export interface LayoutQuestion {
  readonly id: LayoutQuestionId;
  /** The group's accessible name and the row's heading. */
  readonly name: string;
  /** The layout key this answer is written to. */
  readonly path: 'nav.side' | 'density';
  readonly answers: readonly LayoutAnswer[];
}

export const LAYOUT_QUESTIONS: readonly LayoutQuestion[] = [
  {
    id: 'nav',
    name: 'Navigation',
    path: 'nav.side',
    answers: [
      { id: 'left', title: 'Left', line: 'The menu is a side bar down the left edge.' },
      { id: 'bottom', title: 'Bottom', line: 'The side bar stays, and a bar of places runs along the bottom.' },
    ],
  },
  {
    id: 'density',
    name: 'Density',
    path: 'density',
    answers: [
      { id: 'comfortable', title: 'Comfortable', line: 'Room between rows.' },
      { id: 'compact', title: 'Compact', line: 'Rows close together, to see more at once.' },
    ],
  },
];

/** What the layout in force says for one question. A word the step does not offer (`right`, `top`) reads as `left`. */
export function answerOf(layout: Layout, question: LayoutQuestion): string {
  const word = question.path === 'nav.side' ? layout.nav.side : layout.density;
  if (question.answers.some(answer => answer.id === word)) return word;
  return question.answers[0]?.id ?? word;
}

/** Every key one answer is written to: the wide key, and the phone key when the layout in force sets one. */
export function keysFor(layout: Layout, question: LayoutQuestion): readonly string[] {
  const phone =
    question.path === 'nav.side' ? layout.phone?.nav?.side !== undefined : layout.phone?.density !== undefined;
  return phone ? [question.path, `phone.${question.path}`] : [question.path];
}

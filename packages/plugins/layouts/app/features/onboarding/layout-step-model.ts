/**
 * THE LAYOUT STEP, as data (O14): the two questions the first run asks about THIS device, what each answer is called,
 * which keys of the layout it writes, and how today's layout reads as an answer. Pure: no React, no storage.
 *
 * The first question is how the places at the foot of the side bar are drawn (icons or words). The bottom bar is NOT an
 * answer here: owner answer C2 keeps it a switch in Settings › Layout only, so no first-run card enables it.
 *
 * The answers go to this device only (`fy:app:layout`, through the shell's `DeviceLayout.set`): the owner's layout for
 * every device is Settings › Layout's to change. A phone-only key is written too when the layout in force sets one,
 * because that key would otherwise hide the answer on a phone.
 */
import { resolveLayout, type Viewport } from '@ferretry/app';
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
  readonly path: 'nav.labels' | 'density';
  readonly answers: readonly LayoutAnswer[];
}

export const LAYOUT_QUESTIONS: readonly LayoutQuestion[] = [
  {
    id: 'nav',
    name: 'Navigation',
    path: 'nav.labels',
    answers: [
      { id: 'icons', title: 'Icons', line: 'Small icons at the side bar’s foot.' },
      { id: 'words', title: 'Words', line: 'Each place named, at the foot.' },
    ],
  },
  {
    id: 'density',
    name: 'Density',
    path: 'density',
    answers: [
      { id: 'comfortable', title: 'Comfortable', line: 'Room between rows.' },
      { id: 'compact', title: 'Compact', line: 'More rows on screen.' },
    ],
  },
];

/**
 * What THIS device shows for one question: the layout in force with its phone keys laid over it for this viewport, the
 * way the shell draws it. A word the step does not offer is returned as it is, so no card reads as already chosen and
 * the first press of any card saves it.
 */
export function answerOf(layout: Layout, question: LayoutQuestion, viewport: Viewport): string {
  const effective = resolveLayout(layout, viewport);
  return question.path === 'nav.labels' ? effective.nav.labels : effective.density;
}

/**
 * Every key one answer is written to: the wide key, and the phone key when the layout in force sets one (the phone key
 * wins on a phone, so leaving it would hide the answer there).
 */
export function keysFor(layout: Layout, question: LayoutQuestion): readonly string[] {
  const phoneSet =
    question.path === 'nav.labels' ? layout.phone?.nav?.labels !== undefined : layout.phone?.density !== undefined;
  return phoneSet ? [question.path, `phone.${question.path}`] : [question.path];
}

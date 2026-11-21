/**
 * Driving the app's `SelectBox` in a DOM unit test: it is a combobox button whose list opens in the document body, so the
 * options are read from the document (not from the control), and a pick is a click on an option.
 */
import { interact, must } from '@ferretry/app/testing';

/** The combobox button named `label` (its accessible name) in `root`. */
export const boxLabelled = (root: ParentNode, label: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`), `the select box “${label}”`);

/** The options of the open list, as `[value-less label]` text. */
export const optionLabels = (): readonly string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    option => option.querySelector('[data-label]')?.textContent ?? '',
  );

/** What the button shows: the chosen option's label. */
export const shownBy = (box: HTMLElement): string => box.textContent?.trim() ?? '';

/** Opens the box (a box already open stays open: the trigger toggles). */
export const openBox = async (box: HTMLElement): Promise<void> => {
  if (box.getAttribute('aria-expanded') !== 'true') await interact(() => box.click());
};

/** Opens the box and clicks the option that says `label`. */
export const choose = async (box: HTMLElement, label: string): Promise<void> => {
  await openBox(box);
  const option = must(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      candidate => candidate.querySelector('[data-label]')?.textContent === label,
    ),
    `the option “${label}”`,
  );
  await interact(() => option.click());
};

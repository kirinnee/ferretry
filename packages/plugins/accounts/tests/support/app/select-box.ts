/**
 * Driving the app's `SelectBox` (a combobox button; its list opens in the document body) from a unit test: the box is found by
 * its accessible name (the words its `label` prop carries), its options are read by the words they show, and a pick is a click.
 */
import { interact, must } from './dom.ts';

const optionRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const wordsOf = (option: HTMLElement): string => option.querySelector('[data-label]')?.textContent ?? '';

/** The select box named `name` in `container`, or null when it is not drawn. */
export const boxNamed = (container: ParentNode, name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[role="combobox"][aria-label="${name}"]`);

/** The words the box shows as chosen. */
export const chosenWords = (box: HTMLElement | null): string =>
  must(box, 'a select box').querySelector('.fy-sb__value')?.textContent ?? '';

/** Opens the box, reads the words of every option it lists, in order, and closes it again. */
export const optionWords = async (box: HTMLElement | null): Promise<string[]> => {
  const trigger = must(box, 'a select box');
  await interact(() => trigger.click());
  const words = optionRows().map(wordsOf);
  await interact(() => trigger.click());
  return words;
};

/** Opens the box named `name` and clicks the option that shows `words`. */
export const pickOption = async (container: ParentNode, name: string, words: string): Promise<void> => {
  await interact(() => must(boxNamed(container, name), `the select box "${name}"`).click());
  const option = must(
    optionRows().find(each => wordsOf(each) === words),
    `the option "${words}"`,
  );
  await interact(() => option.click());
};

/**
 * Driving the app's `SelectBox` in a unit test: it is a combobox button whose list opens in the document body, so the
 * options are read from the document (not from the control), and a pick is a click on an option.
 */
import { interact, must } from '@ferretry/app/testing';

/** The combobox button: the element itself, or the one inside it (a wrapper that carries a data hook). */
const triggerOf = (host: Element): HTMLElement =>
  host.getAttribute('role') === 'combobox'
    ? (host as HTMLElement)
    : must(host.querySelector<HTMLElement>('[role="combobox"]'), 'the select box');

export const labelOf = (option: Element): string => option.querySelector('[data-label]')?.textContent ?? '';

/** The options of the open list. */
export const optionsOpen = (): readonly HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

/** Opens it (a box already open stays open: the trigger toggles). */
export const openBox = async (host: Element): Promise<void> => {
  const trigger = triggerOf(host);
  if (trigger.getAttribute('aria-expanded') !== 'true') await interact(() => trigger.click());
};

/** Opens the box and clicks the first option whose label starts with `prefix` (labels that carry a time, "v1 of 2 · 3m ago"). */
export const chooseStarting = async (host: Element, prefix: string): Promise<void> => {
  await openBox(host);
  const option = must(
    optionsOpen().find(candidate => labelOf(candidate).startsWith(prefix)),
    `an option starting “${prefix}”`,
  );
  await interact(() => option.click());
};

/**
 * Driving the app's `SelectBox` in a unit test: it is a combobox button whose list opens in the document body, so the
 * options are read from the document (not from the control), and a pick is a click on an option.
 */
import { interact, must } from './dom.ts';

/** The combobox button: the element itself, or the one inside it (a wrapper that carries a data hook). */
const triggerOf = (host: Element): HTMLElement =>
  host.getAttribute('role') === 'combobox'
    ? (host as HTMLElement)
    : must(host.querySelector<HTMLElement>('[role="combobox"]'), 'the select box');

export const labelOf = (option: Element): string => option.querySelector('[data-label]')?.textContent ?? '';

/** The options of the open list. */
export const optionsOpen = (): readonly HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

/** What the button shows: the chosen option's label. */
export const shownBy = (host: Element): string => triggerOf(host).textContent?.trim() ?? '';

/** Opens it (a box already open stays open: the trigger toggles). */
export const openBox = async (host: Element): Promise<void> => {
  const trigger = triggerOf(host);
  if (trigger.getAttribute('aria-expanded') !== 'true') await interact(() => trigger.click());
};

/** Opens the box and clicks the option that says `label`. */
export const choose = async (host: Element, label: string): Promise<void> => {
  await openBox(host);
  const option = must(
    optionsOpen().find(candidate => labelOf(candidate) === label),
    `the option “${label}”`,
  );
  await interact(() => option.click());
};

/** Opens the box and clicks the option whose label starts with `start` (a row named "<name> · <harness>" is picked by its name). */
export const chooseStarting = async (host: Element, start: string): Promise<void> => {
  await openBox(host);
  const option = must(
    optionsOpen().find(candidate => labelOf(candidate).startsWith(start)),
    `an option starting “${start}”`,
  );
  await interact(() => option.click());
};

/** Shuts an open box (the trigger toggles). */
export const closeBox = async (host: Element): Promise<void> => {
  const trigger = triggerOf(host);
  if (trigger.getAttribute('aria-expanded') === 'true') await interact(() => trigger.click());
};

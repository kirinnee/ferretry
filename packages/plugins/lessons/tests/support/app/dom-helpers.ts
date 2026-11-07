/** DOM helpers the Learning suites share: find by visible text, click, type, choose. */

import { interact, must } from './dom.ts';
import { settleUntil } from './settle.ts';

export const textOf = (root: ParentNode): string => (root as HTMLElement).textContent ?? '';

/** The first element of `selector` whose text includes `text`. */
export const byText = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string, text: string): T =>
  must(
    [...root.querySelectorAll<T>(selector)].find(element => (element.textContent ?? '').includes(text)),
    `${selector} with text "${text}"`,
  );

export const maybeByText = (root: ParentNode, selector: string, text: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>(selector)].find(element => (element.textContent ?? '').includes(text));

export const click = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

export const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await interact(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

/** Waits until the root's text includes `text`. */
export const waitForText = async (root: ParentNode, text: string): Promise<void> => {
  await settleUntil(() => textOf(root).includes(text), `"${text}" on screen`, interact);
};

/** Waits until `ready` holds. */
export const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  await settleUntil(ready, what, interact);
};

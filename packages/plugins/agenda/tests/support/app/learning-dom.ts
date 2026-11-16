/** DOM helpers the Learning suites share: find by visible text, click, type, choose. */

import { interact, settleUntil } from '@ferretry/app/testing';

export const textOf = (root: ParentNode): string => (root as HTMLElement).textContent ?? '';

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

/** Waits until the root's text includes `text`. */
export const waitForText = async (root: ParentNode, text: string): Promise<void> => {
  await settleUntil(() => textOf(root).includes(text), `"${text}" on screen`, interact);
};

/** Waits until `ready` holds. */
export const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  await settleUntil(ready, what, interact);
};

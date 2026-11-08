/** DOM helpers the Learning suites share: find by visible text, click, type, choose. */

import { interact } from './dom.ts';

export const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await interact(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

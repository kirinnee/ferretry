/** Form helpers the Inbox suites share: set a field's value the way typing does. */

import { interact } from '@ferretry/app/testing';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export const fill = async (field: Field, value: string): Promise<void> => {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  const type = field instanceof HTMLSelectElement ? 'change' : 'input';
  await interact(() => field.dispatchEvent(new Event(type, { bubbles: true })));
};

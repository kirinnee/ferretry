import { interact } from '../../support/dom.ts';

/** Types into a controlled React input: the native setter, then the `input` event React listens for. */
export const typeInto = async (field: HTMLInputElement, text: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

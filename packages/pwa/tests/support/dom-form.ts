import { interact, must } from './dom.ts';

/** Types into a controlled React input the way a keyboard does: through the native setter, then `input`. */
export const typeInto = async (element: Element | null, value: string): Promise<void> => {
  const input = must(element, 'an input') as HTMLInputElement;
  await interact(() => {
    const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'a value setter');
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const click = async (element: Element | null): Promise<void> => {
  const target = must(element, 'a clickable') as HTMLElement;
  await interact(() => target.click());
};

export const byText = (root: ParentNode, selector: string, text: string): HTMLElement =>
  must(
    [...root.querySelectorAll<HTMLElement>(selector)].find(node => node.textContent?.includes(text)),
    `${selector} containing "${text}"`,
  );

/** Lets a settled promise chain (a fake client's answer, then state updates) run inside `act`. */
export const settle = async (): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

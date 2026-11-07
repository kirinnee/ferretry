/** Helpers for the DOM suites: mount, let every read and write finish inside one `act`, click, type, read text. */
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ReactElement } from 'react';

// happy-dom is registered here, in the support file every DOM suite imports, before any of them touches `document`;
// `react-dom/client` is imported dynamically by `mount`, after it.
ensureDom();

const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

/** Runs an action and lets every read and write it started finish, all inside one `act`. */
const settled = async (action: () => unknown): Promise<void> => {
  await interact(async () => {
    await action();
    await drain();
  });
};

export const settle = async (): Promise<void> => settled(() => undefined);

export const click = async (root: ParentNode, selector: string): Promise<void> => {
  const target = must(root.querySelector<HTMLElement>(selector), selector);
  await settled(() => target.click());
};

/** Types into an input or a text area the way React hears it. */
export const type = async (root: ParentNode, selector: string, value: string): Promise<void> => {
  const field = must(root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector), selector);
  await settled(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const text = (root: ParentNode, selector: string): string =>
  must(root.querySelector(selector), selector).textContent ?? '';

/** Mounts and lets the first read land, inside one `act`. */
export const mountSettled = async (element: ReactElement): Promise<Mounted> => {
  let mounted: Mounted | undefined;
  await settled(async () => {
    mounted = await mount(element);
  });
  return must(mounted, 'the mounted view');
};

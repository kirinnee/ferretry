/** Helpers for the DOM suites: mount, let every read and write finish inside one `act`, click, read text. */
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ReactElement } from 'react';

// happy-dom is registered here, in the support file every DOM suite imports, before any of them touches `document`.
ensureDom();

const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const settled = async (action: () => unknown): Promise<void> => {
  await interact(async () => {
    await action();
    await drain();
  });
};

export const click = async (root: ParentNode, selector: string): Promise<void> => {
  const target = must(root.querySelector<HTMLElement>(selector), selector);
  await settled(() => target.click());
};

export const text = (root: ParentNode, selector: string): string =>
  must(root.querySelector(selector), selector).textContent ?? '';

export const mountSettled = async (element: ReactElement): Promise<Mounted> => {
  let mounted: Mounted | undefined;
  await settled(async () => {
    mounted = await mount(element);
  });
  return must(mounted, 'the mounted view');
};

/** Lets real time pass inside one `act`, for a view that reads again on its own timer. */
export const wait = async (ms: number): Promise<void> => {
  await interact(async () => {
    await new Promise(done => setTimeout(done, ms));
    await drain();
  });
};

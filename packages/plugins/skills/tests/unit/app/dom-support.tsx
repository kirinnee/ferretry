/** Shared DOM helpers for Skills' view tests: mount, settle, click, type. */
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import type { AppComponent } from '@ferretry/kernel/manifest';
import type { FunctionComponent, ReactElement } from 'react';

let open: Mounted | null = null;

export const show = async (element: ReactElement): Promise<Mounted> => {
  open = await mount(element);
  return open;
};

export const closeAll = async (): Promise<void> => {
  await open?.unmount();
  open = null;
};

export const settle = async (ready: () => boolean, what: string): Promise<void> => {
  await settleUntil(ready, what, interact);
};

/** The text of the whole document, sheets included (a sheet portals out of the mounted container). */
export const pageText = (): string => document.body.textContent ?? '';

export const q = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(selector);

export const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element, what);
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};

/** A surface the half built (`AppComponent`, which answers `unknown`) as the React component the shell mounts it as. */
export const asView = <Props,>(component: AppComponent<Props>): FunctionComponent<Props> =>
  component as unknown as FunctionComponent<Props>;

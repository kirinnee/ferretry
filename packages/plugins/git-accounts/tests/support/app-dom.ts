/** The shell's DOM harness (`@ferretry/app/testing`) with a document registered, plus the few gestures these tests use. */
import { ensureDom, interact, mount, must } from '@ferretry/app/testing';

ensureDom();

export { interact, mount };

export const click = async (element: Element | null): Promise<void> => {
  const target = must(element, 'a clickable') as HTMLElement;
  await interact(() => target.click());
};

/** Lets a settled promise chain (a fake client's answer, then state updates) run inside `act`. */
export const settle = async (ms = 0): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

export const q = <T extends Element>(root: ParentNode, selector: string): T =>
  must(root.querySelector<T>(selector), selector);

export const buttonNamed = (root: ParentNode, text: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(
      each => each.textContent?.trim() === text || each.getAttribute('aria-label') === text,
    ),
    `button ${text}`,
  );

/** Settles in small steps until `done()` holds: each timer-driven state change needs its own `act` to flush. */
export const settleUntil = async (done: () => boolean, steps = 60): Promise<void> => {
  for (let step = 0; step < steps && !done(); step += 1) await settle(8);
};

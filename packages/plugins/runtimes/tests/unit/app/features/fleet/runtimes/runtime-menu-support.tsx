import { interact, must } from '../../../../support/dom.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

export type RuntimeAction = 'make-default' | 'rename' | 'remove';

/** A runtime card's ⋯ button, by runtime name. */
export const menuButton = (container: ParentNode, name: string): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>(`[data-runtime-card="${name}"] [data-runtime-actions]`),
    `the ⋯ button on ${name}`,
  );

/** Opens a runtime card's ⋯ menu and returns its menu items by key. */
export const openRuntimeMenu = async (
  container: ParentNode,
  name: string,
): Promise<ReadonlyMap<string, HTMLButtonElement>> => {
  await interact(() => menuButton(container, name).click());
  await settle();
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
  return new Map(items.map(item => [item.getAttribute('data-menu-key') ?? '', item]));
};

/** Opens the card's ⋯ menu and chooses `action`, as a person would. */
export const chooseRuntimeAction = async (
  container: ParentNode,
  name: string,
  action: RuntimeAction,
): Promise<void> => {
  const items = await openRuntimeMenu(container, name);
  const item = must(items.get(action), `${action} in ${name}'s menu`);
  await interact(() => item.click());
  await settle();
};

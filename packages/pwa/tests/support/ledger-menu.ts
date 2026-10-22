import './dom.ts';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { runAsync } from './react.ts';

/** The "⋯" button on a message's status line. */
export const actionsButton = (renderer: ReactTestRenderer): ReactTestInstance =>
  renderer.root.find(node => node.type === 'button' && node.props['data-ledger-more'] !== undefined);

export const hasActionsButton = (renderer: ReactTestRenderer): boolean =>
  renderer.root.findAll(node => node.type === 'button' && node.props['data-ledger-more'] !== undefined).length > 0;

/** Taps the "⋯" button, which opens the menu. */
export const openActions = async (renderer: ReactTestRenderer): Promise<void> => {
  await runAsync(async () => {
    actionsButton(renderer).props.onClick();
  });
};

const menuItems = (renderer: ReactTestRenderer): ReactTestInstance[] =>
  renderer.root.findAll(node => node.type === 'button' && node.props.role === 'menuitem');

/** The keys of the actions the open menu lists, in order. Opens the menu first when it is shut. */
export const actionKeys = async (renderer: ReactTestRenderer): Promise<string[]> => {
  if (!hasActionsButton(renderer)) return [];
  if (menuItems(renderer).length === 0) await openActions(renderer);
  return menuItems(renderer).map(node => String(node.props['data-menu-key']));
};

/** Opens the menu and picks one action, the way a reader does. */
export const chooseAction = async (renderer: ReactTestRenderer, key: string): Promise<void> => {
  if (menuItems(renderer).length === 0) await openActions(renderer);
  const item = menuItems(renderer).find(node => node.props['data-menu-key'] === key);
  if (item === undefined) throw new Error(`the menu has no "${key}" action`);
  await runAsync(async () => {
    item.props.onClick();
  });
};

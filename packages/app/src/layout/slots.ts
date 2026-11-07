import type { FrameSlot } from '@ferretry/kernel/manifest';

/**
 * THE SHELL'S FRAME SLOTS (§5.2). A slot is a named place; the shell offers these, plugin screens offer their own
 * (`<plugin>.<name>`). The list is the leaf's `FrameSlot` union, spelled once more as a value so a layout can be
 * checked against it at run time; `satisfies` keeps the two from drifting.
 */
export const FRAME_SLOTS = [
  'nav',
  'top',
  'main',
  'side',
  'bottom',
  'composer.tools',
  'ferret.side',
  'ferret.toolbar',
  'card.detail',
  'daemon.status',
  'settings',
  'device.settings',
] as const satisfies readonly FrameSlot[];

type Missing = Exclude<FrameSlot, (typeof FRAME_SLOTS)[number]>;
/** Fails to compile when the leaf adds a frame slot this list lacks. */
export const FRAME_SLOTS_COMPLETE: [Missing] extends [never] ? true : Missing = true;

/** Slots whose contents are panels (as opposed to the router's screen in `main`, or nav entries). */
export const PANEL_SLOTS = ['composer.tools', 'ferret.side', 'ferret.toolbar', 'card.detail', 'daemon.status'] as const;

/** A slot name a plugin screen offers: `<plugin>.<name>`, kebab-case on both sides. */
const PLUGIN_SLOT = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;

export function isFrameSlot(name: string): name is FrameSlot {
  return (FRAME_SLOTS as readonly string[]).includes(name);
}

export function isSlotName(name: string): boolean {
  return isFrameSlot(name) || PLUGIN_SLOT.test(name);
}

/**
 * The shell's own items: what a layout may name in `top` and in `nav.items` that is not a plugin's screen. Each is
 * drawn by the shell; none is a feature.
 */
export const SHELL_ITEMS = {
  top: ['daemon-picker', 'search', 'status'] as const,
  nav: ['settings', 'daemons'] as const,
};

import { useSyncExternalStore } from 'react';
import { DEFAULT_LAYOUT, type Layout, type LayoutIssue, type LayoutOverrides } from '../layout/layout.ts';
import { useOptionalShell } from './context.tsx';

/**
 * THIS DEVICE'S OWN LAYOUT CHOICE, for a plugin's Settings tab (§5.3): the keys this browser changed on top of the
 * owner's layout (`--device`), the layout in force once they are laid over, and the two edits the command bar also
 * makes. A device's choice is the app's saved data (`fy:app:layout`, §9.4) and never a daemon route, so the one place
 * a half can reach it is here.
 */
export interface DeviceLayout {
  /** What this device changed, field by field (`{}` while it follows the owner). */
  readonly overrides: LayoutOverrides;
  /** The owner's layout from the selected daemon, or the built-in default without one: what the overrides lie on. */
  readonly base: Layout;
  /** The layout the shell draws with: this device's changes over the owner's layout. */
  readonly inForce: Layout;
  /** Set when a layout was refused, so `inForce` is the next candidate that passed (the built-in default at last). */
  readonly refused?: { readonly layout: string; readonly issues: readonly LayoutIssue[] };
  /** `layout set --device <path> <value>`: answers the reason it was refused, or `undefined` once saved. */
  set(path: string, value: string): string | undefined;
  /** `layout reset --device`: this device follows the owner's layout again. */
  reset(): void;
}

/** The device's layout choice, or `undefined` outside a shell (a harness, a test). Re-renders on a change. */
export function useDeviceLayout(): DeviceLayout | undefined {
  const shell = useOptionalShell();
  const overrides = useSyncExternalStore(
    shell?.layouts.subscribe ?? noSubscription,
    shell?.layouts.snapshot ?? noOverrides,
    noOverrides,
  );
  if (shell === null) return undefined;
  const base = shell.owner ?? DEFAULT_LAYOUT;
  return {
    overrides,
    base,
    inForce: shell.layout.layout,
    ...(shell.layout.kind === 'refused'
      ? { refused: { layout: shell.layout.refused, issues: shell.layout.issues } }
      : {}),
    set: (path, value) => shell.layouts.set(base, path, value),
    reset: () => shell.layouts.reset(),
  };
}

const NONE: LayoutOverrides = Object.freeze({});
const noOverrides = (): LayoutOverrides => NONE;
const noSubscription = (): (() => void) => () => {};

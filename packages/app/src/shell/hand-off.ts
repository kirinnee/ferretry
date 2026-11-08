import { useEffect, useMemo, useState } from 'react';
import type { ScreenRef } from '../layout/engine.ts';
import { HELD_FOR_MS, type HoldClock } from '../router/address.ts';
import { routeTable } from '../router/routes.ts';
import { useOptionalDevice } from './device-context.tsx';
import { usePluginIdentity } from './plugin-identity.tsx';

/**
 * A TYPED, IN-MEMORY HAND-OFF (shell contract S3, m4): a value carried to another of THIS plugin's screens without the
 * URL, history state or storage — the way 'Subscribe with a link' carries a share code to `/join`.
 *
 * - Keyed by (plugin, screen). A ref is minted for the CALLING plugin only (`useOwnScreen`), and a take from another
 *   plugin's view answers `undefined`.
 * - Taken once (on the taking view's first commit), dropped on a navigation to any other address, and after 2 min.
 * - Never logged, never in `history.state`.
 */

/** One of the calling plugin's own screens, as a hand-off target. `T` is what is carried; it exists only in types. */
export interface OwnScreenRef<T> {
  readonly plugin: string;
  readonly screen: string;
  /** Phantom: ties the value's type to the screen. */
  readonly carries?: (value: T) => void;
}

interface Waiting {
  readonly target: ScreenRef;
  readonly value: unknown;
  readonly at: number;
}

/** The refs this holder minted: a ref copied or built by hand is not one, so it can carry nothing. */
const MINTED = new WeakMap<object, HandOffs>();

export class HandOffs {
  readonly #clock: HoldClock;
  readonly #screenOf: (plugin: string, screen: string) => ScreenRef | undefined;
  readonly #refs = new Map<string, OwnScreenRef<unknown>>();
  readonly #waiting = new Map<string, Waiting>();

  constructor(screenOf: (plugin: string, screen: string) => ScreenRef | undefined, clock: HoldClock) {
    this.#screenOf = screenOf;
    this.#clock = clock;
  }

  /** The ref of one of `plugin`'s screens, the same object each time; `undefined` for a screen it does not declare. */
  ref<T>(plugin: string, screen: string): OwnScreenRef<T> | undefined {
    const key = `${plugin}.${screen}`;
    const known = this.#refs.get(key);
    if (known !== undefined) return known as OwnScreenRef<T>;
    if (this.#screenOf(plugin, screen) === undefined) return undefined;
    const ref: OwnScreenRef<unknown> = Object.freeze({ plugin, screen });
    MINTED.set(ref, this);
    this.#refs.set(key, ref);
    return ref as OwnScreenRef<T>;
  }

  give<T>(to: OwnScreenRef<T>, value: T): void {
    const target = this.#screenOf(to.plugin, to.screen);
    if (MINTED.get(to) !== this || target === undefined) return;
    const key = `${to.plugin}.${to.screen}`;
    const waiting: Waiting = { target, value, at: this.#clock.now() };
    this.#waiting.set(key, waiting);
    this.#clock.after(HELD_FOR_MS, () => {
      if (this.#waiting.get(key) === waiting) this.#waiting.delete(key);
    });
  }

  /** What waits for `to`, for a view of `plugin`; nothing for another plugin's view, or once it expired. */
  peek<T>(to: OwnScreenRef<T>, plugin: string): T | undefined {
    if (MINTED.get(to) !== this || to.plugin !== plugin) return undefined;
    const waiting = this.#waiting.get(`${to.plugin}.${to.screen}`);
    if (waiting === undefined || this.#clock.now() - waiting.at >= HELD_FOR_MS) return undefined;
    return waiting.value as T;
  }

  /** The view took it: it is gone. */
  consume<T>(to: OwnScreenRef<T>, plugin: string): void {
    if (to.plugin === plugin) this.#waiting.delete(`${to.plugin}.${to.screen}`);
  }

  /** The address moved: whatever waits for a screen not drawn at `pathname` is dropped. */
  navigated(pathname: string): void {
    for (const [key, waiting] of [...this.#waiting]) {
      if (routeTable([waiting.target]).parse(pathname).kind !== 'screen') this.#waiting.delete(key);
    }
  }
}

/**
 * Carries `value` to one of the calling plugin's own screens (`to`, from {@link useOwnScreen}); navigate there next.
 * A ref the shell did not mint carries nothing.
 */
export function handOff<T>(to: OwnScreenRef<T>, value: T): void {
  MINTED.get(to)?.give(to, value);
}

/** The calling plugin's own screen `screen` as a hand-off target; `undefined` outside a shell or for a screen it lacks. */
export function useOwnScreen<T>(screen: string): OwnScreenRef<T> | undefined {
  const plugin = usePluginIdentity()?.plugin;
  const holder = useOptionalDevice()?.handOffs;
  return useMemo(
    () => (plugin === undefined || holder === undefined ? undefined : holder.ref<T>(plugin, screen)),
    [holder, plugin, screen],
  );
}

/** What was handed to `screen`, taken on this view's first commit; another plugin's view gets `undefined`. */
export function useHandOff<T>(screen: OwnScreenRef<T> | undefined): T | undefined {
  const plugin = usePluginIdentity()?.plugin;
  const holder = useOptionalDevice()?.handOffs;
  const [value] = useState(() =>
    screen === undefined || plugin === undefined ? undefined : holder?.peek(screen, plugin),
  );
  useEffect(() => {
    if (screen !== undefined && plugin !== undefined && value !== undefined) holder?.consume(screen, plugin);
  }, [holder, plugin, screen, value]);
  return value;
}

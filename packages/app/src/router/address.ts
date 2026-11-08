import type { ScreenRef } from '../layout/engine.ts';
import { addressPlace } from './routes.ts';

/**
 * DECLARED FRAGMENTS, TAKEN BY ONE NAMED TAKER (shell contract S3). A plugin declares the fragments it owns
 * (`shell.fragments`); the shell reads the address at boot and on every same-document arrival, takes ONLY the declared,
 * stripping parts out of the address bar and the history entry (`history.replaceState`, keeping the entry's own state)
 * before anything renders, and holds the latest per key in memory with an arrival count.
 *
 * - **Keyed** (`#<key>/<rest>` or `#<key>=<rest>`, one part, `<rest>` to the END with `?` and `&`): taken only by the
 *   declaring plugin's device view. `strip: false` claims the key and leaves it in the address (Runtimes' own router).
 * - **Path** (the whole fragment on one of the plugin's daemon-less screens), matched by the router's own parse
 *   (`addressPlace`): `at` → stripped and held for that screen; `beneath` → stripped and DROPPED.
 * - Anything else is not the shell's: never read, never stripped.
 * - A held value no one takes is dropped after two minutes: a pairing or share code is a live credential. It is never
 *   written to the URL, history state or storage, and never logged.
 */

export type FragmentDecl =
  | { readonly form: 'keyed'; readonly key: string; readonly strip?: false }
  | { readonly form: 'path'; readonly screen: string };

/** The keyed grammar's key: the text before the first `/` or `=`. */
export const FRAGMENT_KEY = /^[a-z][a-z0-9-]{0,31}$/u;
/** How long a held fragment (or hand-off) waits for its taker. */
export const HELD_FOR_MS = 120_000;

/** The slice of `window` the taker reads and rewrites. */
export interface AddressBrowser {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'state' | 'replaceState'>;
  readonly addEventListener?: (type: 'hashchange', listener: () => void) => void;
}

/** The clock the hold expires on; a test hands a fake one. */
export interface HoldClock {
  readonly now: () => number;
  readonly after: (delayMs: number, run: () => void) => void;
}

/** Every plugin's declarations, with the screens a path declaration names. */
export interface DeclaredFragment {
  readonly plugin: string;
  readonly decl: FragmentDecl;
  /** The daemon-less screen a `path` declaration names; absent for keyed ones. */
  readonly screen?: ScreenRef;
}

/** Where a reader of a fragment is drawn: a device view, or one daemon-less screen. */
export interface FragmentReader {
  readonly plugin: string;
  readonly place: string;
  readonly screen?: string;
}

/** The key of a keyed fragment (`#agenda/A3?…` → `agenda`), or `undefined` when it is not in the keyed form. */
export function fragmentKey(hash: string): string | undefined {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const cut = body.search(/[/=]/u);
  if (cut <= 0) return undefined;
  const key = body.slice(0, cut);
  return FRAGMENT_KEY.test(key) ? key : undefined;
}

interface Held {
  readonly value: string;
  readonly at: number;
}

/** The wall clock and the platform timer. */
export const REAL_CLOCK: HoldClock = {
  now: () => Date.now(),
  after: (delayMs, run) => void setTimeout(run, delayMs),
};

export class AddressTaker {
  readonly #browser: AddressBrowser | undefined;
  readonly #clock: HoldClock;
  readonly #keyed = new Map<string, { readonly plugin: string; readonly strip: boolean }>();
  readonly #paths: { readonly plugin: string; readonly screen: ScreenRef }[] = [];
  readonly #held = new Map<string, Held>();
  readonly #arrivals = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  /**
   * Reads the address at once (so a declared part leaves the bar before the first render) and on every `hashchange`.
   * Without a browser (the generator, a test that draws no address) nothing is ever read or held. Of two plugins that
   * declare one key, only the first keeps it (the `shell-provides` check fails the build before that can ship).
   */
  constructor(declared: readonly DeclaredFragment[], browser?: AddressBrowser, clock: HoldClock = REAL_CLOCK) {
    this.#browser = browser;
    this.#clock = clock;
    for (const { plugin, decl, screen } of declared) {
      if (decl.form === 'keyed') {
        if (FRAGMENT_KEY.test(decl.key) && !this.#keyed.has(decl.key))
          this.#keyed.set(decl.key, { plugin, strip: decl.strip !== false });
      } else if (screen !== undefined && screen.plugin === plugin && screen.path.startsWith('/')) {
        this.#paths.push({ plugin, screen });
      }
    }
    browser?.addEventListener?.('hashchange', () => this.read());
    this.read();
  }

  /** Reads the address now: a declared, stripping part leaves it and is held (or, beneath a path screen, dropped). */
  read = (): void => {
    const browser = this.#browser;
    if (browser === undefined) return;
    const { pathname, hash } = browser.location;
    for (const { plugin, screen } of this.#paths) {
      const place = addressPlace(screen, pathname);
      if (place === 'elsewhere') continue;
      if (hash === '' || hash === '#') return;
      this.#strip(browser);
      if (place === 'at') this.#hold(`path:${plugin}.${screen.id}`, hash);
      return;
    }
    const key = fragmentKey(hash);
    const claim = key === undefined ? undefined : this.#keyed.get(key);
    if (claim === undefined || !claim.strip) return;
    this.#strip(browser);
    this.#hold(`keyed:${key}`, hash);
  };

  /** The slot a reader may take from, or `undefined`: keyed in its plugin's device view, path on its own screen. */
  slotFor(reader: FragmentReader, key: string): string | undefined {
    if (reader.place === 'device') {
      const claim = this.#keyed.get(key);
      return claim?.strip === true && claim.plugin === reader.plugin ? `keyed:${key}` : undefined;
    }
    if (reader.place === 'daemonless' && reader.screen === key) {
      const declared = this.#paths.some(path => path.plugin === reader.plugin && path.screen.id === key);
      return declared ? `path:${reader.plugin}.${key}` : undefined;
    }
    return undefined;
  }

  /** How many times a fragment arrived for this slot (0 = none yet). */
  arrival(slot: string): number {
    return this.#arrivals.get(slot) ?? 0;
  }

  /** The held fragment, exactly as it arrived (`#` included), ONCE; `undefined` when none waits or it expired. */
  take(slot: string): string | undefined {
    const held = this.#held.get(slot);
    this.#held.delete(slot);
    if (held === undefined || this.#clock.now() - held.at >= HELD_FOR_MS) return undefined;
    return held.value;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #strip(browser: AddressBrowser): void {
    const { pathname, search } = browser.location;
    browser.history.replaceState(browser.history.state, '', `${pathname}${search}`);
  }

  #hold(slot: string, value: string): void {
    const held: Held = { value, at: this.#clock.now() };
    this.#held.set(slot, held);
    this.#arrivals.set(slot, this.arrival(slot) + 1);
    this.#clock.after(HELD_FOR_MS, () => {
      if (this.#held.get(slot) === held) this.#held.delete(slot);
    });
    for (const listener of [...this.#listeners]) listener();
  }
}

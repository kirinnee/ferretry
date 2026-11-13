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
 * - A pairing-shaped fragment (`CREDENTIAL_FRAGMENT`) on any OTHER path is stripped and DROPPED: a live code that landed
 *   on the wrong page has no taker, and must not sit in the address.
 * - Anything else is not the shell's: never read, never stripped.
 * - A path fragment normally leaves the address before the module graph is even fetched: `public/arrival.js` strips it
 *   while the document parses and keeps it in its own closure, behind one `window` function that the taker calls once at
 *   construction (`takeEarlyArrival`). That hand-off is take-once and carries what is left of the two minutes counted
 *   from the ARRIVAL: a boot that comes late does not restart the hold.
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

/** The one non-enumerable function `public/arrival.js` leaves on `window` for the taker to call once. */
export const EARLY_ARRIVAL_KEY = '__fyArrival';

/** A pairing or share link's fragment shape (the access contract's `PAIRING_FRAGMENT_PATTERN`; a unit test pins the two). */
export const CREDENTIAL_FRAGMENT = /^#?v1(?:;|$)/u;

/**
 * A fragment `public/arrival.js` already took off the address (before the module graph was fetched): the path it
 * arrived on, the whole fragment (`#` included) and how much of its two minutes is left. The taker decides, by the
 * plugins' own declarations, whether it is held for a screen or dropped.
 */
export interface EarlyArrival {
  readonly pathname: string;
  readonly hash: string;
  readonly remainingMs: number;
}

/**
 * Takes the early arrival, ONCE: calls the script's hand-off (which removes itself and its value) and drops anything
 * that is not exactly what it promises. `undefined` when none is there, it is odd, or its deadline has passed.
 */
function takeEarlyArrival(browser: object): EarlyArrival | undefined {
  const handoff: unknown = Reflect.get(browser, EARLY_ARRIVAL_KEY);
  Reflect.deleteProperty(browser, EARLY_ARRIVAL_KEY);
  if (typeof handoff !== 'function') return undefined;
  let found: unknown;
  try {
    found = Reflect.apply(handoff, undefined, []);
  } catch {
    return undefined; // a hand-off that throws gave nothing
  }
  if (typeof found !== 'object' || found === null) return undefined;
  const { pathname, hash, remainingMs } = found as Partial<EarlyArrival>;
  return typeof pathname === 'string' &&
    typeof hash === 'string' &&
    hash.length > 1 &&
    typeof remainingMs === 'number' &&
    remainingMs > 0 &&
    remainingMs <= HELD_FOR_MS
    ? { pathname, hash, remainingMs }
    : undefined;
}

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
    const early = browser === undefined ? undefined : takeEarlyArrival(browser);
    if (early !== undefined) this.#adopt(early);
    this.read();
  }

  /**
   * A fragment the early script already took off the address: held for its declared screen (`at`), or dropped
   * (`beneath`, or a path nobody declared). It is the same decision `read` makes, only the strip is already done.
   */
  #adopt({ pathname, hash, remainingMs }: EarlyArrival): void {
    for (const { plugin, screen } of this.#paths) {
      const place = addressPlace(screen, pathname);
      if (place === 'elsewhere') continue;
      if (place === 'at') this.#hold(`path:${plugin}.${screen.id}`, hash, remainingMs);
      return;
    }
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
    if (claim === undefined) {
      // A pairing-shaped fragment on a path no one declared has no taker: it leaves the address and is dropped.
      if (CREDENTIAL_FRAGMENT.test(hash)) this.#strip(browser);
      return;
    }
    if (!claim.strip) return;
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

  /** Holds `value` for its taker until its deadline: two minutes from now, or what is left of them for an early one. */
  #hold(slot: string, value: string, remainingMs: number = HELD_FOR_MS): void {
    const held: Held = { value, at: this.#clock.now() - (HELD_FOR_MS - remainingMs) };
    this.#held.set(slot, held);
    this.#arrivals.set(slot, this.arrival(slot) + 1);
    this.#clock.after(remainingMs, () => {
      if (this.#held.get(slot) === held) this.#held.delete(slot);
    });
    for (const listener of [...this.#listeners]) listener();
  }
}

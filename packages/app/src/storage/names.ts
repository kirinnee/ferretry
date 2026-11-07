/**
 * EVERY BROWSER-SIDE NAME THE APP USES, in one place (§9.4).
 *
 * All names changed once for 5.0, so the new app never reads an old entry. There is no version in a name: a stored
 * value carries `format: 1` inside instead, and a value of another format is read as absent (clean slate, A452).
 * Old entries (`fy-theme-v1`, `ferretry-device-keys`, `fy-router-trail:v1`, …) are NOT deleted by code: deleting them
 * would mean knowing their names, which is compatibility code. They are harmless and unread.
 *
 * | Storage        | Name                                                       |
 * | -------------- | ---------------------------------------------------------- |
 * | localStorage   | `fy:<id>:<name>` (`<id>` a subsystem id, or `app`)          |
 * | sessionStorage | `fy:app:trail`, `fy:app:scroll`                            |
 * | IndexedDB      | `fy-<id>` (one database per subsystem that needs one)      |
 * | Cache Storage  | release caches unchanged; speech models `fy:voice:<model>` |
 */

/** A subsystem id or the shell's own `app`: kebab-case, like a plugin id (§3.2). */
const OWNER = /^[a-z][a-z0-9-]{0,39}$/u;
/** A name inside one owner: kebab-case words, optionally dotted (`devices-seen.<daemon>` is not allowed: use the key). */
const NAME = /^[a-z][a-z0-9-]{0,63}$/u;

/** The shell's own owner id. Not a plugin id; no plugin may be called `app`. */
const APP_OWNER = 'app';

function checked(kind: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`not a valid ${kind}: ${JSON.stringify(value)}`);
  return value;
}

/**
 * A localStorage key: `fy:<id>:<name>`, or `fy:<id>:<name>:<key>` for one entry of a keyed family (one per daemon,
 * say). `key` is opaque (a daemon id); it may hold any character but `:` is kept as the separator only before it.
 */
export function localKey(owner: string, name: string, key?: string): string {
  const base = `fy:${checked('storage owner', owner, OWNER)}:${checked('storage name', name, NAME)}`;
  return key === undefined ? base : `${base}:${key}`;
}

/** An IndexedDB database name: `fy-<id>`. */
export function databaseName(owner: string): string {
  return `fy-${checked('storage owner', owner, OWNER)}`;
}

/** A speech model's Cache Storage name: `fy:voice:<model>`. */
export function speechModelCache(model: string): string {
  return `fy:voice:${checked('speech model', model, NAME)}`;
}

/** The shell's own names. sessionStorage for the trail and scroll memory; localStorage for device settings. */
export const APP_STORAGE = {
  /** sessionStorage: the router's trail of history entries in this tab. */
  trail: 'fy:app:trail',
  /** sessionStorage: remembered scroll positions per history entry. */
  scroll: 'fy:app:scroll',
  /** localStorage: this device's theme (a device setting, §5.2). */
  theme: localKey(APP_OWNER, 'theme'),
  /** localStorage: this device's layout override (`--device`, §5.3). */
  layout: localKey(APP_OWNER, 'layout'),
  /** localStorage: the paired daemons this browser knows, grouped by machine. */
  daemons: localKey(APP_OWNER, 'daemons'),
  /** localStorage: the density chosen on this device. */
  density: localKey(APP_OWNER, 'density'),
} as const;

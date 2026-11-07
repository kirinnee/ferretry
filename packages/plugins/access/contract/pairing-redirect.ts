/**
 * The redirect page `fy pair --open` leaves in the state home for a few seconds, and how anything that
 * finds one afterwards recognises it as ours.
 *
 * ONE FACT, TWO PROGRAMS. The CLI creates the page and the daemon sweeps up after a CLI that was killed
 * mid-window; they share no package, so each would otherwise hold its own spelling of the directory name
 * and one of them would one day delete a directory the other never made, or miss one it did. The names
 * and the age live here, and `docs/pairing.md` is the prose that owns the reason.
 *
 * A DIRECTORY NAME IS MATCHED EXACTLY, NEVER BY PREFIX. A sweep that removed `pair-open-*` would delete
 * whatever an operator happened to call a folder like that. `mkdtemp` appends six characters from the
 * alphanumerics, and nothing else matches.
 */

/** The prefix of the private directory the page lives in; `mkdtemp` appends its six random characters. */
export const PAIRING_REDIRECT_DIRECTORY_PREFIX = 'pair-open-' as const;

/** The one file inside that directory. */
export const PAIRING_REDIRECT_FILE_NAME = 'pairing.html' as const;

/**
 * How long the page outlives the launcher that was handed its path — the whole of its intended life.
 *
 * Long enough for a browser that is not running yet to start and read a local file, short enough that
 * the code is on disk for a fraction of its own two-minute life.
 */
export const PAIRING_REDIRECT_LIFETIME_MS = 10_000 as const;

/**
 * How old a page must be before it counts as a leftover.
 *
 * Three lifetimes, not one: a sweep is run by ANOTHER process, and a page younger than this may belong
 * to a `fy pair` that is running right now and has not yet had its browser read it. Anything older was
 * due for deletion by its owner twenty seconds ago, so it is a leftover whether or not the owner is
 * still alive — and its code is dead either way, being older than the two minutes a code lives.
 */
export const PAIRING_REDIRECT_STALE_AFTER_MS = 3 * PAIRING_REDIRECT_LIFETIME_MS;

const DIRECTORY_PATTERN = new RegExp(`^${PAIRING_REDIRECT_DIRECTORY_PREFIX}[A-Za-z0-9]{6}$`, 'u');

/** Whether `name` is exactly the shape of directory `fy pair --open` makes. */
export const isPairingRedirectDirectoryName = (name: string): boolean => DIRECTORY_PATTERN.test(name);

/** Whether a page last written at `writtenAtMs` is a leftover at `nowMs`. A future time is never stale. */
export const isPairingRedirectStale = (writtenAtMs: number, nowMs: number): boolean =>
  nowMs - writtenAtMs > PAIRING_REDIRECT_STALE_AFTER_MS;

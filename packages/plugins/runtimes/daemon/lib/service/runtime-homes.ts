/**
 * The harness homes a published fleet manifest names (`fleet/manifest.json`), as {@link RuntimeHome}s.
 *
 * Pure: a manifest and the fleet folder's absolute path in, the homes out. A home at exactly `<fleet>/homes/<id>` is a
 * fleet home and its id is that folder's name. A home an operator placed elsewhere (a `~/.claude-work` opt-out) is
 * listed too, under its account's id, so the reader can serve it read-only through the `harness-home` root scoped to
 * that absolute folder; a home that is not a plain absolute folder, or that sits at or inside the fleet folder itself,
 * is not listed (the fleet's own files are never a harness home).
 */
import { type RuntimeHome, RuntimeIdSchema, type RuntimeId } from '../../../contract/index.ts';
import { type FleetManifest, harnessKeyOfKind, wrapperNameOf } from '../manifest.ts';

/** A plain folder name: one segment, no dot-only name, nothing a path could climb with. */
const HOME_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** An absolute path of plain segments: no `.`, `..`, empty segment, backslash or NUL, no trailing slash. */
const plainAbsolute = (path: string): boolean =>
  path.startsWith('/') &&
  !/[\\\0]/u.test(path) &&
  path
    .slice(1)
    .split('/')
    .every(segment => segment !== '' && segment !== '.' && segment !== '..');

/** The home id of an absolute path that is exactly `<fleetDirectory>/homes/<id>`, else `undefined`. */
function fleetHomeIdOf(home: string, fleetDirectory: string): string | undefined {
  const prefix = `${fleetDirectory}/homes/`;
  if (!home.startsWith(prefix)) return undefined;
  const id = home.slice(prefix.length);
  return HOME_ID.test(id) ? id : undefined;
}

/** True when `path` is the fleet folder or sits inside it. */
const inFleet = (path: string, fleetDirectory: string): boolean =>
  path === fleetDirectory || path.startsWith(`${fleetDirectory}/`);

/** The homes of a manifest in manifest order; the runtimes of a home deduped in manifest order (an account's wrapper, then its runtimes'). */
export function homesOf(manifest: FleetManifest | undefined, fleetDirectory: string): readonly RuntimeHome[] {
  if (manifest === undefined) return [];
  const homes = new Map<string, { harness: RuntimeHome['harness']; home: string; wrapper: string; names: string[] }>();
  for (const account of manifest.accounts) {
    const inside = fleetHomeIdOf(account.home, fleetDirectory);
    // An account's id is a UUID (the manifest schema), so it is always a plain name.
    const id = inside ?? account.id;
    if (inside === undefined && !(plainAbsolute(account.home) && !inFleet(account.home, fleetDirectory))) continue;
    const found = homes.get(id);
    // An id two different folders claim belongs to the first; the second is not served.
    if (found !== undefined && found.home !== account.home) continue;
    const entry = found ?? {
      harness: harnessKeyOfKind(account.kind),
      home: account.home,
      wrapper: account.wrapper,
      names: [],
    };
    homes.set(id, entry);
    entry.names.push(
      wrapperNameOf(account.wrapper),
      ...manifest.runtimes.filter(runtime => runtime.id === account.id).map(runtime => wrapperNameOf(runtime.wrapper)),
    );
  }
  return [...homes].map(([id, entry]) => ({
    id,
    harness: entry.harness,
    runtimes: [...new Set(entry.names)].flatMap(name => {
      const parsed = RuntimeIdSchema.safeParse(name);
      return parsed.success ? [parsed.data as RuntimeId] : [];
    }),
    home: entry.home,
    wrapper: entry.wrapper,
  }));
}

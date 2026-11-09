/**
 * The harness homes a published fleet manifest names (`fleet/manifest.json`), as {@link RuntimeHome}s.
 *
 * Pure: a manifest and the fleet folder's absolute path in, the homes out. A home is served only when it is exactly
 * `<fleet>/homes/<id>` with `<id>` one plain segment; a home an operator placed elsewhere (a `~/.claude-work` opt-out) is
 * not a fleet home and is not listed, because the reader has no root that reaches it.
 */
import { type RuntimeHome, RuntimeIdSchema, type RuntimeId } from '../../../contract/index.ts';
import { type FleetManifest, harnessKeyOfKind, wrapperNameOf } from '../manifest.ts';

/** A plain folder name: one segment, no dot-only name, nothing a path could climb with. */
const HOME_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The home id of an absolute path that is exactly `<fleetDirectory>/homes/<id>`, else `undefined`. */
function homeIdOf(home: string, fleetDirectory: string): string | undefined {
  const prefix = `${fleetDirectory}/homes/`;
  if (!home.startsWith(prefix)) return undefined;
  const id = home.slice(prefix.length);
  return HOME_ID.test(id) ? id : undefined;
}

/** The homes of a manifest in manifest order; the runtimes of a home deduped in manifest order (an account's wrapper, then its runtimes'). */
export function homesOf(manifest: FleetManifest | undefined, fleetDirectory: string): readonly RuntimeHome[] {
  if (manifest === undefined) return [];
  const homes = new Map<string, { harness: RuntimeHome['harness']; home: string; wrapper: string; names: string[] }>();
  for (const account of manifest.accounts) {
    const id = homeIdOf(account.home, fleetDirectory);
    if (id === undefined) continue;
    const entry = homes.get(id) ?? {
      harness: harnessKeyOfKind(account.kind),
      home: `${fleetDirectory}/homes/${id}`,
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

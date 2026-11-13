/**
 * A v4 home is moved or copied before it is converted (the prompt does `mv H B`, then `--from B --to H`), but v4 wrote
 * ABSOLUTE paths of its own home into that home: the harness-home entries of `fleet/manifest.json`, the homes of
 * `fleet/ids.json`, each ferret's transcript home and file, a conversion's `fromFile`, a session's wrapper path, a
 * warden record's `reportPath`.
 * Read where the home now is, those say it lives elsewhere.
 *
 * {@link rebaseV4Path} is the ONE place that fixes it. A path v4 recorded INSIDE its own home is recognised by its
 * v4-home-relative tail (`<anything>/fleet/homes/<id>/...`, `fleet/shared/...`, `fleet/bin/...`,
 * `state/warden/reports/...`) and re-based onto the
 * home being read (`--from`), so identity stays by id and every comparison is made between paths that exist there. The
 * old home is never named, looked at or relied on to be `--to`. A path with no such tail (a project folder, a worktree,
 * the user's own `~/.claude`) is outside the v4 home and is returned as written.
 *
 * It is pure string work: no `stat`, no `lstat`, no read, so the re-based path is only ever WALKED later by the steps
 * that already walk `--from` lstat-only, and the old absolute path is never touched.
 */
import { isAbsolute, join, posix, resolve, sep } from 'node:path';

/** The folders of a v4 home (relative to it) whose absolute spelling v4 recorded inside the home. */
const AREAS: readonly (readonly string[])[] = [
  ['fleet', 'homes'],
  ['fleet', 'shared'],
  ['fleet', 'bin'],
  ['state', 'warden', 'reports'],
];

/** `path` re-based onto the v4 home `home` when it names one of the home's own folders by that tail, else unchanged. */
export function rebaseV4Path(home: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const segments = resolve(path).split(sep).join(posix.sep).split(posix.sep).filter(Boolean);
  for (let at = 0; at < segments.length; at++)
    for (const area of AREAS)
      if (area.every((name, offset) => segments[at + offset] === name)) return join(home, ...segments.slice(at));
  return path;
}

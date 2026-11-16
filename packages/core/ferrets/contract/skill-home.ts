import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { LaunchPart } from './kinds.ts';

/** Where a harness keeps the skills it loads, inside the ferret's home (both Claude Code and Codex: `skills/`). */
export const SKILLS_FOLDER = 'skills';

/** What {@link materializeSkills} did, by skill name. */
export interface MaterializedSkills {
  /** Made as a link to the shared folder (today's behaviour: one link per selected skill). */
  readonly linked: readonly string[];
  /** Made as a copy, where the kernel's one link rule did not allow a link. */
  readonly copied: readonly string[];
  /** Skill parts that carry no shared folder, or a name that cannot be one folder: nothing was made for them. */
  readonly skipped: readonly string[];
  /** Folders removed from `skills/` because no selected skill names them (a deselected skill leaves the home). */
  readonly pruned: readonly string[];
}

/** One folder name: a single plain path component, never `.`, `..`, a hidden name or one the harness owns. */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const fenced = (home: RootHandle, relative: string): FencedPath => {
  const at = home.resolve(relative);
  if (!at.ok) throw new Error(`the skills folder could not be placed in the ferret's home: ${at.error}`);
  return at.value;
};

/**
 * Removes one name of the home: a link by `unlink` (never followed: a skill link points outside the home, which
 * `remove` refuses), anything else by `remove`.
 */
async function removeName(home: RootHandle, path: FencedPath): Promise<void> {
  if ((await home.lstat(path))?.kind === 'symlink') await home.unlink(path);
  else await home.remove(path);
}

/**
 * Brings the skills a launch selected into the ferret's home, `skills/<name>` (§7.7 shared trees, ruling #52): each
 * `skill` part's shared folder (`LaunchPart.tree`, minted by Skills from its own installed skills) is linked in with
 * `RootHandle.copyShared` (the kernel makes a copy where its one link rule says no), and every other folder of
 * `skills/` is removed, so a skill the profile no longer selects is no longer there to run. A part with no tree (a
 * project skill: not shared, not copied) is skipped. `harnessOwned` names the folders the HARNESS writes there (Codex's
 * `.system`): never replaced, never removed, never claimed as a skill.
 *
 * `home` is the ferret's own `agent-homes` handle: `copyShared` refuses any other destination.
 *
 * GAP (declared): the kernel offers no held folder handle that lists and removes (`RootHandle.pin` holds a folder but
 * is read-only), so this looks and then acts. Today's `pruneDirectory` sweeps through one handle it opened; here a
 * `skills/` folder swapped for an in-home link at any point after the `lstat` sends the rest of that sweep through the
 * link: the list, every removal and the links made. Every entry of the folder it names except the harness's own is
 * removed, and each selected skill is linked there; a leaf swapped between its `lstat` and its `remove` makes that
 * `remove` delete the folder it names. The
 * scope fence still holds (a link out of the ferret's home is refused `link_escape`), and the next launch looks again.
 */
export async function materializeSkills(
  home: RootHandle,
  parts: readonly LaunchPart[],
  harnessOwned: readonly string[],
): Promise<MaterializedSkills> {
  const chosen = new Map<string, NonNullable<Extract<LaunchPart, { kind: 'skill' }>['tree']>>();
  const skipped: string[] = [];
  for (const part of parts) {
    if (part.kind !== 'skill') continue;
    if (part.tree === undefined || !FOLDER_NAME.test(part.name) || harnessOwned.includes(part.name)) {
      skipped.push(part.name);
      continue;
    }
    if (!chosen.has(part.name)) chosen.set(part.name, part.tree);
  }

  const container = fenced(home, SKILLS_FOLDER);
  // A container the harness child swapped for a link (into its own state, say) is never listed, swept or written
  // through: only the link itself goes (`unlink` never follows it), and a real folder takes its place.
  if ((await home.lstat(container))?.kind === 'symlink') await home.unlink(container);
  await home.makeDirectory(container, { mode: 0o700 });
  const pruned: string[] = [];
  for (const entry of await home.list(container)) {
    if (chosen.has(entry) || harnessOwned.includes(entry)) continue;
    await removeName(home, fenced(home, `${SKILLS_FOLDER}/${entry}`));
    pruned.push(entry);
  }

  const linked: string[] = [];
  const copied: string[] = [];
  for (const [name, tree] of chosen) {
    const to = fenced(home, `${SKILLS_FOLDER}/${name}`);
    // A relaunch finds last time's link or copy: it is removed by its own name, never followed, then made anew.
    await removeName(home, to);
    const made = await home.copyShared(tree, to, { link: true });
    (made === 'linked' ? linked : copied).push(name);
  }
  return { linked, copied, skipped, pruned };
}

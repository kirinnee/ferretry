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
  /** Selected skills whose link from an earlier launch is still there and was left as it is (see {@link removeName}). */
  readonly kept: readonly string[];
  /** Links no selected skill names that stay, because the root cannot unlink a link whose target is outside it. */
  readonly stuck: readonly string[];
}

/** One folder name: a single plain path component, never `.`, `..`, a hidden name or one the harness owns. */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const fenced = (home: RootHandle, relative: string): FencedPath => {
  const at = home.resolve(relative);
  if (!at.ok) throw new Error(`the skills folder could not be placed in the ferret's home: ${at.error}`);
  return at.value;
};

/**
 * Removes one name of the home. A LINK to a folder outside the home (a skill link from an earlier launch) is not
 * followed by the root and is refused `link_escape`: that is answered `false` with the link left in place, never
 * followed and never worked around. DECLARED GAP (kernel): `RootHandle.remove` cannot unlink such a link, so a
 * deselected skill's link stays until the root can.
 */
async function removeName(home: RootHandle, path: FencedPath): Promise<boolean> {
  try {
    await home.remove(path);
    return true;
  } catch (error) {
    if ((error as { refusal?: string }).refusal === 'link_escape' && (await home.lstat(path))?.kind === 'symlink')
      return false;
    throw error;
  }
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
  await home.makeDirectory(container, { mode: 0o700 });
  const pruned: string[] = [];
  const stuck: string[] = [];
  for (const entry of await home.list(container)) {
    if (chosen.has(entry) || harnessOwned.includes(entry)) continue;
    ((await removeName(home, fenced(home, `${SKILLS_FOLDER}/${entry}`))) ? pruned : stuck).push(entry);
  }

  const linked: string[] = [];
  const copied: string[] = [];
  const kept: string[] = [];
  for (const [name, tree] of chosen) {
    const to = fenced(home, `${SKILLS_FOLDER}/${name}`);
    // A relaunch finds last time's copy (removed, then made anew) or link (it already reaches the installed folder).
    if (!(await removeName(home, to))) {
      kept.push(name);
      continue;
    }
    const made = await home.copyShared(tree, to, { link: true });
    (made === 'linked' ? linked : copied).push(name);
  }
  return { linked, copied, skipped, pruned, kept, stuck };
}

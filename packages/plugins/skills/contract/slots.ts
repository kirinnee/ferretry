/**
 * THE SLOT SKILLS OFFERS (§5.2: plugin panels offer their own, named `<plugin>.<name>`).
 *
 * The Skills tab of a ferret's context has a header line ("16 active in this ferret"). Where a skill comes from beyond
 * this machine is not Skills' to know, so the panel OFFERS this slot there and mounts whatever panel an installed
 * plugin contributes: Catalogs contributes "+ Add skills", the way in to the skills of the catalogs this device
 * subscribes to. Neither half imports the other — the slot name and the props below are the whole agreement, so a
 * daemon without Catalogs shows the tab with no button.
 *
 * The props are plain data (no framework type: this is a contract). A contributing panel reads them from its props.
 */

/** In the Skills tab's header, beside the "active in this ferret" line. */
export const SKILLS_ADD_SLOT = 'skills.add' as const;

/**
 * On each skill's row in the Skills tab, at the end of the row's first line (after Open). A plugin that knows more about
 * where a skill came from or can go puts its own controls there: Catalogs draws "from Ines · v2", Publish and Uninstall.
 */
export const SKILLS_ROW_SLOT = 'skills.row' as const;

/** Every slot Skills' panel offers, in one list a test can pair against the panels other plugins contribute. */
export const SKILLS_SLOTS = [SKILLS_ADD_SLOT, SKILLS_ROW_SLOT] as const;
export type SkillsSlot = (typeof SKILLS_SLOTS)[number];

/** What the slot hands its panels, besides the shell's `subject` (the ferret). */
export interface SkillsAddSlotProps {
  /** The ferret whose skills these are. */
  readonly ferret: string;
  /** The folder the ferret works in: the project an install goes into by default. */
  readonly folder: string;
  /** Which harness reads the skills: it decides where an install is active. */
  readonly harness: 'claude-code' | 'codex';
  /** The runtime's wrapper name, as the inventory names it. */
  readonly runtime?: string;
  /** Where the skills the ferret sees come from ('project', 'user', 'ferretry'), once each: whether an install makes a new skills folder. */
  readonly scopes: readonly string[];
}

/** What the row slot hands its panels, besides the shell's `subject` (the ferret): the one skill the row draws. */
export interface SkillsRowSlotProps {
  /** The ferret whose Skills tab this is. */
  readonly ferret: string;
  /** The skill's name. */
  readonly name: string;
  /** What the row shows and inserts: `/name` for Claude, `$name` for Codex. */
  readonly invocation: string;
  /** Absolute path of its SKILL.md: the one thing that names this skill among same-named ones. */
  readonly path: string;
  /** Where it comes from ('project', 'user', 'ferretry'). */
  readonly scope: string;
  /** The runtimes that read this copy: with `path` and `scope`, which installed copy of the name this row is. */
  readonly runtimes: readonly string[];
}

/** A narrowing for the row slot's panels, as {@link isSkillsAddSlotProps} is for the header's. */
export function isSkillsRowSlotProps(props: unknown): props is SkillsRowSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.ferret === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.invocation === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.scope === 'string' &&
    Array.isArray(candidate.runtimes) &&
    candidate.runtimes.every(runtime => typeof runtime === 'string')
  );
}

/** A narrowing for a contributing panel: the props are untyped at the shell, so the panel checks what it reads. */
export function isSkillsAddSlotProps(props: unknown): props is SkillsAddSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.ferret === 'string' &&
    typeof candidate.folder === 'string' &&
    (candidate.harness === 'claude-code' || candidate.harness === 'codex') &&
    (candidate.runtime === undefined || typeof candidate.runtime === 'string') &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every(scope => typeof scope === 'string')
  );
}

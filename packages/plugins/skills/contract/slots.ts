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

/** Every slot Skills' panel offers, in one list a test can pair against the panels other plugins contribute. */
export const SKILLS_SLOTS = [SKILLS_ADD_SLOT] as const;
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

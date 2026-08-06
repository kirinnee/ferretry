/**
 * The skills catalog model — grouping, search, and THE INSERTION CONTRACT.
 *
 * Ported from kteam `ui/src/components/SkillsSurface.tsx` (the pure half) and
 * the skill section of `ui/src/components/composer-autocomplete-providers.ts`.
 * Discovery lives on the daemon (`GET /v1/sessions/:id/skills`, landed by
 * PR #135); this module owns only what a reader sees and what lands in a draft.
 *
 * WHAT CHANGED FOR FERRETRY.
 *
 *   - `harnessHomeResolved` is gone. The original resolved a per-wrapper
 *     account home out of its fleet config, so "no skills" and "we could not
 *     find the account" were genuinely different answers and the zero-state
 *     said so. Ferretry's
 *     `NodeCatalog` derives the roots from the daemon's own home and the
 *     session cwd, and `SessionSkillsSchema` carries no such field — there is
 *     no unresolved case left to report, so the two extra copy branches would
 *     be unreachable rather than cautious.
 *   - `skillBadge()` is gone for the same reason: `origin` is a required
 *     protocol enum that already includes `unknown`, so a normalizer over it
 *     could never take its fallback. Its one real job — turning an origin into
 *     a screen-readable sentence — survives as `skillBadgeLabel`.
 *
 * Nothing here caches. A catalog belongs to one `(daemonId, sessionId)` pair
 * and the surface refetches when either changes, which is the only shape that
 * cannot serve one daemon's skills under another daemon's session id.
 */

import type { AvailableSkill, Harness, SessionSkills } from '@ferretry/protocol';

/** A session's catalog, name-sorted. Identical to the wire shape by design. */
export type SkillsCatalog = SessionSkills;

/**
 * THE INSERTION CONTRACT, and it is not the same on both harnesses.
 *
 * Claude invokes a skill as `/name`. Codex uses `/skills` to BROWSE and `$name`
 * to actually invoke one, so inserting `/name` there would type a command Codex
 * does not have. The human trigger is `/` either way — what lands in the draft
 * is whatever that harness understands.
 */
export const skillInsertText = (harness: Harness, name: string): string =>
  harness === 'codex' ? `$${name}` : `/${name}`;

/** The one-line reminder of which harness the reader is inserting for. */
export const skillHarnessLabel = (harness: Harness): string =>
  harness === 'codex' ? 'Codex · inserts $name' : 'Claude · inserts /name';

/** Append one invocation as a new draft token while preserving real content. */
export const appendSkillInvocation = (draft: string, invocation: string): string => {
  if (draft.trim().length === 0) return `${invocation} `;
  return `${draft}${/\s$/u.test(draft) ? '' : ' '}${invocation} `;
};

/** Substring search over name and description, case- and locale-insensitive. */
export const filterSkills = (skills: readonly AvailableSkill[], query: string): AvailableSkill[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...skills];
  return skills.filter(skill => `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(needle));
};

/**
 * The one reader-facing name for a scope.
 *
 * A group heading and a skill's own detail are the same fact stated twice, so
 * they are stated once here. The alternative — a heading built from this map and
 * a detail line CSS-capitalising the raw wire value — reads identically until a
 * scope arrives whose display name is not its identifier capitalised.
 */
export const skillScopeLabel = (scope: AvailableSkill['scope']): 'Global' | 'Project' =>
  scope === 'global' ? 'Global' : 'Project';

export interface SkillGroup {
  readonly scope: AvailableSkill['scope'];
  readonly label: 'Global' | 'Project';
  readonly skills: readonly AvailableSkill[];
}

/**
 * Global first, project second — a fixed order, never a data-driven one, so a
 * reader's eye lands in the same place on every session.
 */
export const groupSkills = (skills: readonly AvailableSkill[], query: string): SkillGroup[] => {
  const matching = filterSkills(skills, query);
  return (['global', 'project'] as const).map(scope => ({
    scope,
    label: skillScopeLabel(scope),
    skills: matching.filter(skill => skill.scope === scope),
  }));
};

/** What the origin chip means, spelled out for a screen reader. */
export const skillBadgeLabel = (origin: AvailableSkill['origin']): string => {
  if (origin === 'claude') return 'Available for Claude';
  if (origin === 'codex') return 'Available for Codex';
  if (origin === 'both') return 'Available for Claude and Codex';
  return 'Skill origin is unknown';
};

/** Honest zero-state copy: a filtered-out catalog is not an empty one. */
export const skillsEmptyCopy = (query: string, catalogSize: number): string => {
  const needle = query.trim();
  if (needle && catalogSize > 0) return `No skills match “${needle}”.`;
  return 'No skills are installed for this session.';
};

/** How many of a catalog's skills survive the active search. */
export const visibleSkillCount = (catalog: SkillsCatalog, query: string): number =>
  filterSkills(catalog.skills, query).length;

/**
 * The row action, exported so the insert-only boundary has a direct test.
 * There is deliberately no submit path: a tap edits the draft and nothing else.
 */
export const insertSkillIntoDraft = (
  onInsert: (invocation: string) => void,
  harness: Harness,
  name: string,
): string => {
  const invocation = skillInsertText(harness, name);
  onInsert(invocation);
  return invocation;
};

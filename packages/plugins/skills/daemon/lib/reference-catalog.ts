import type { ReferenceCatalogEntry, ReferenceCatalogProvider } from '@ferretry/plugin-conversation/contract';
import type { FerretSkills } from '../../contract/index.ts';

/** The most a menu row's detail holds (the catalog's own bound); a longer description is cut, never refused. */
const MAX_DETAIL = 512;

/**
 * The composer's `/` and `$` menu entries for one ferret (reference.catalog, lead ruling 2026-11-07): the skill names it can
 * invoke, with each description, exactly the list `GET /v1/ferrets/:ferretId/skills` answers (a project skill replacing a
 * home skill of the same name, sorted by name). The composer writes the harness's own invocation from the name.
 *
 * Nothing here is asked of the operator beyond what that read route already asks (names and descriptions; no capability,
 * no pane text), so the provider declares no `demand`. A ferret this daemon does not know has no skills to offer.
 */
export function skillEntries(skills: FerretSkills | undefined): readonly ReferenceCatalogEntry[] {
  return (skills?.skills ?? []).map(skill => ({
    token: skill.name,
    label: skill.name,
    detail: skill.description.slice(0, MAX_DETAIL),
  }));
}

/** The one provider both prefixes (`/` and `$`) answer with: a skill is one thing, however it is spelled. */
export const skillReferenceProvider = (
  forComposer: (ferret: string) => Promise<FerretSkills | undefined>,
): ReferenceCatalogProvider => ({
  entries: async input => skillEntries(await forComposer(input.ferret)),
});

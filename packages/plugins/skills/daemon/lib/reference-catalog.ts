import type { ReferenceCatalogEntry, ReferenceCatalogProvider } from '@ferretry/plugin-conversation/contract';
import type { FerretSkills } from '../../contract/index.ts';

/** The most a menu row's detail holds (the catalog's own bound); a longer description is cut, never refused. */
const MAX_DETAIL = 512;

/** The catalog's own bounds for the inserted token and the printed label. */
const MAX_TOKEN = 512;
const MAX_LABEL = 256;

/**
 * The composer's `/` and `$` menu entries for one ferret (reference.catalog, lead ruling 2026-11-07): the skill names it can
 * invoke, with each description, exactly the list `GET /v1/ferrets/:ferretId/skills` answers (a project skill replacing a
 * home skill of the same name, sorted by name). The composer writes the harness's own invocation from the name.
 *
 * Nothing here is asked of the operator beyond what that read route already asks (names and descriptions; no capability,
 * no pane text), so the provider declares no `demand`. A ferret this daemon does not know has no skills to offer.
 *
 * A name comes from a SKILL.md, so it has no bound of its own: one past the token bound is left out (a cut name would
 * insert a skill that does not exist), and the label is cut to its bound, so one odd skill never fails the whole menu.
 * A query narrows by the name or the description, case ignored.
 */
export function skillEntries(skills: FerretSkills | undefined, query?: string): readonly ReferenceCatalogEntry[] {
  const wanted = query?.trim().toLowerCase() ?? '';
  return (skills?.skills ?? [])
    .filter(skill => skill.name.length <= MAX_TOKEN)
    .filter(skill => wanted === '' || `${skill.name}\n${skill.description}`.toLowerCase().includes(wanted))
    .map(skill => ({
      token: skill.name,
      label: skill.name.slice(0, MAX_LABEL),
      detail: skill.description.slice(0, MAX_DETAIL),
    }));
}

/** The one provider both prefixes (`/` and `$`) answer with: a skill is one thing, however it is spelled. */
export const skillReferenceProvider = (
  forComposer: (ferret: string) => Promise<FerretSkills | undefined>,
): ReferenceCatalogProvider => ({
  entries: async input => skillEntries(await forComposer(input.ferret), input.query),
});

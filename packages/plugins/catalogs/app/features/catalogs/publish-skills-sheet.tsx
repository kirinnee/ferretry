/**
 * My catalogs › a catalog › **+ Publish skills** (&B131 A3): the skills on this machine, and Publish on each.
 *
 * Publishing is the owner's act, so it starts where the owner looks after a catalog, not on the side panel's list of
 * what a session can use. Every skill on the machine is listed once by its SKILL.md path, with where it lives; one the
 * catalog already holds says so and its version. **Publish** opens the Add to catalog sheet aimed at THIS catalog, so
 * the review, the warnings and the freezing are exactly the ones every publish goes through; while that sheet is open
 * the picker steps aside, and comes back when it closes.
 */

import type { OwnedCatalog } from '../../../contract/wire/index.ts';
import { revealHidden } from '../../../contract/wire/index.ts';
import { PackagePlus } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/machine.ts';
import { Button } from '@ferretry/app/ui';
import { type MachineSkillEntriesLoader, noMachineSkills } from '../../lib/machine-skills.ts';
import { AddToCatalogSheet } from './add-to-catalog-sheet.tsx';
import { CatalogSheet, FailureLine } from './catalog-parts.tsx';
import type { CatalogClientFactory } from './catalogs-api.ts';
import { type PublishableSkill, publishableSkills } from './publish-skills-model.ts';

const PUBLISH_SKILLS_NOTE =
  'Publishing freezes a copy that people who subscribe can install. Your own copy keeps working as it is.';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly entries: Parameters<typeof publishableSkills>[0] }
  | { readonly kind: 'failed'; readonly sentence: string };

export interface PublishSkillsSheetProps {
  readonly connection: DaemonConnection;
  readonly catalog: OwnedCatalog;
  readonly onClose: () => void;
  /** After a publish landed, so the catalog (and this list's "In this catalog") reads again. */
  readonly onChanged: () => void;
  /** Seams for tests and the harness; the app reads the machine through its own routes. */
  readonly load?: MachineSkillEntriesLoader;
  readonly createClient?: CatalogClientFactory;
}

export function PublishSkillsSheet({
  connection,
  catalog,
  onClose,
  onChanged,
  load,
  createClient,
}: PublishSkillsSheetProps) {
  const searchId = useId();
  const reader = useMemo<MachineSkillEntriesLoader>(() => load ?? noMachineSkills, [load]);
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PublishableSkill | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void reader(controller.signal).then(
      entries => {
        if (!controller.signal.aborted) setState({ kind: 'ready', entries });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error && error.message !== '' ? ` ${error.message}` : '';
        setState({ kind: 'failed', sentence: `This machine’s skills could not be read.${reason}` });
      },
    );
    return () => controller.abort();
  }, [reader]);

  if (picked !== null)
    return (
      <AddToCatalogSheet
        connection={connection}
        source={{ kind: 'skill', skill: picked.path }}
        label={picked.name}
        preferCatalogId={catalog.id}
        onClose={() => setPicked(null)}
        onDone={onChanged}
        {...(createClient === undefined ? {} : { createClient })}
      />
    );

  const rows = state.kind === 'ready' ? publishableSkills(state.entries, catalog, query) : [];
  return (
    <CatalogSheet
      name="publish-skills"
      title={`Publish skills in ${catalog.name}`}
      subtitle={PUBLISH_SKILLS_NOTE}
      closeLabel="Close Publish skills"
      onClose={onClose}
    >
      {state.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading this machine’s skills…
        </p>
      ) : state.kind === 'failed' ? (
        <FailureLine sentence={state.sentence} />
      ) : (
        <>
          <label htmlFor={searchId} className="sr-only">
            Search skills
          </label>
          <input
            id={searchId}
            className="kt-input"
            type="search"
            placeholder="Search skills…"
            value={query}
            onChange={event => setQuery(event.target.value)}
            data-publish-search=""
          />
          {rows.length === 0 ? (
            <p className="m-0 text-cell text-muted" data-publish-empty="">
              {query.trim() === '' ? 'There are no skills on this machine yet.' : `No skill matches “${query.trim()}”.`}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Skills on this machine">
              {rows.map(skill => (
                <li
                  key={skill.path}
                  className="flex min-w-0 flex-wrap items-center gap-x-xs gap-y-0.5 rounded-control px-xs py-xs"
                  data-publish-skill={skill.name}
                >
                  <span className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-xs">
                      <span className="min-w-0 truncate font-mono text-cell text-fg">/{revealHidden(skill.name)}</span>
                      <span className="fy-info-chip" data-tone="muted" data-publish-where="">
                        {skill.where}
                      </span>
                    </span>
                    <span className="block max-w-full truncate text-meta text-muted" title={skill.description}>
                      {revealHidden(skill.description)}
                    </span>
                  </span>
                  {skill.held === null ? (
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-[44px] shrink-0"
                      onClick={() => setPicked(skill)}
                      aria-label={`Publish ${skill.name} in ${catalog.name}`}
                      data-publish-pick={skill.name}
                    >
                      <PackagePlus size={14} aria-hidden="true" />
                      Publish
                    </Button>
                  ) : (
                    <span className="fy-info-chip shrink-0" data-tone="accent" data-publish-held="">
                      {skill.held}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </CatalogSheet>
  );
}

/**
 * SKILLS — the session-scoped catalog surface hosted by the side pane.
 *
 * Ported from kteam `ui/src/components/SkillsSurface.tsx`.
 *
 * Discovery and invocation are deliberately NOT implemented here. The daemon
 * supplies the exact session's catalog, and `skills-catalog.ts` owns Claude's
 * `/name` versus Codex's `$name` convention. This component only gives those
 * facts room to be read and searched.
 *
 * A row tap inserts text into the existing draft through a callback. It never
 * submits, closes the pane, or focuses the composer/search field. The reader
 * can keep browsing and review the draft before choosing to send it.
 *
 * TWO THINGS DIFFER FROM THE ORIGINAL, both because the frame around it did.
 *
 *   - No `SurfaceHeader`. Ferretry's `SidePaneWorkspace` renders `SidePaneTabs`
 *     above every surface and owns the title and the close control, so a second
 *     header here would be a duplicate row the original never had.
 *   - The origin chip's `aria-label` moved onto the row button. A `<span>` with
 *     `aria-label` and no role fails `a11y/useAriaPropsSupportedByRole`, and it
 *     was unreachable anyway: the button already carries an `aria-label`, which
 *     overrides its subtree for a screen reader. The sentence is now part of
 *     that label, and the chip keeps it on hover as a `title`.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';

import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from '../../lib/daemon-scope.ts';
import type { SkillsCatalogLoader } from './skills-api.ts';
import {
  groupSkills,
  insertSkillIntoDraft,
  skillBadgeLabel,
  skillHarnessLabel,
  skillInsertText,
  type SkillsCatalog,
  skillsEmptyCopy,
  visibleSkillCount,
} from './skills-catalog.ts';

type LoadState = 'loading' | 'ready' | 'error';

const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export interface SkillsCatalogListProps {
  readonly catalog: SkillsCatalog;
  readonly query: string;
  /** Draft-only boundary. There is intentionally no submit callback. */
  readonly onInsert: (invocation: string) => void;
}

/** The grouped rows, hostless so the harness and tests render exactly this. */
export function SkillsCatalogList({ catalog, query, onInsert }: SkillsCatalogListProps) {
  const groups = groupSkills(catalog.skills, query);
  const skillCount = groups.reduce((count, group) => count + group.skills.length, 0);
  if (skillCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Sparkles size={22} aria-hidden="true" className="text-faint" />
        <p className="m-0 max-w-[38ch] text-cell leading-base text-muted">
          {skillsEmptyCopy(query, catalog.skills.length)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups
        .filter(group => group.skills.length > 0)
        .map(group => (
          <section key={group.scope} aria-labelledby={`skills-${group.scope}-heading`} className="min-w-0">
            <h3
              id={`skills-${group.scope}-heading`}
              className="m-0 mb-1 px-1 text-meta font-semibold uppercase tracking-wide text-muted"
            >
              {group.label}
            </h3>
            <ul className="m-0 list-none divide-y divide-border-soft rounded-md border border-border-soft bg-surface p-0">
              {group.skills.map(skill => {
                const invocation = skillInsertText(catalog.harness, skill.name);
                const origin = skillBadgeLabel(skill.origin);
                return (
                  <li key={skill.name}>
                    <button
                      type="button"
                      className="flex min-h-[64px] w-full flex-col items-stretch gap-1 px-3 py-2 text-left hover:bg-surface-2"
                      onClick={() => insertSkillIntoDraft(onInsert, catalog.harness, skill.name)}
                      aria-label={`Insert ${invocation} into composer draft. ${skill.description} ${origin}.`}
                    >
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <code className="min-w-0 truncate font-mono text-cell font-semibold text-accent">
                          {invocation}
                        </code>
                        <span className="flex shrink-0 items-center gap-2 text-meta text-muted">
                          <span
                            className="rounded border border-border-soft bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted"
                            title={origin}
                          >
                            {skill.origin}
                          </span>
                          <span>Insert into draft</span>
                        </span>
                      </span>
                      <span className="text-cell leading-base text-muted">{skill.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}

export interface SkillsSurfaceProps {
  /** Required daemon/session identity. There is intentionally no session-only overload. */
  readonly scope: DaemonSessionScope;
  /** Draft-only boundary. There is intentionally no submit callback. */
  readonly onInsert: (invocation: string) => void;
  readonly loadCatalog: SkillsCatalogLoader;
}

interface SkillsSurfaceBodyProps extends SkillsSurfaceProps {
  readonly onRefresh: () => void;
}

function SkillsSurfaceBody({ scope, onInsert, loadCatalog, onRefresh }: SkillsSurfaceBodyProps) {
  const searchId = useId();
  const [state, setState] = useState<LoadState>('loading');
  const [catalog, setCatalog] = useState<SkillsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inserted, setInserted] = useState<string | null>(null);
  // The identity is read as two primitives so the effect re-runs on a real
  // daemon or session change and not merely because the parent re-rendered
  // with a fresh scope object.
  const { daemonId, sessionId } = scope;

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void loadCatalog(daemonSessionScope({ daemonId }, sessionId), controller.signal)
      .then(next => {
        if (!live) return;
        setCatalog(next);
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (!live || controller.signal.aborted) return;
        setError(errorMessage(reason));
        setState('error');
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [daemonId, loadCatalog, sessionId]);

  const visible = catalog === null ? 0 : visibleSkillCount(catalog, query);
  const insert = useCallback(
    (invocation: string) => {
      onInsert(invocation);
      setInserted(invocation);
    },
    [onInsert],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-end gap-2 px-panel py-2">
        <label className="min-w-0 flex-1" htmlFor={searchId}>
          <span className="sr-only">Search skills</span>
          <span className="relative block">
            <Search
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
              placeholder="Search skills"
              autoComplete="off"
              spellCheck={false}
              disabled={state !== 'ready' || catalog === null || catalog.skills.length === 0}
              // `!pl-9`: `.kt-input`'s padding shorthand is defined after
              // `@tailwind utilities`, so a plain `pl-9` loses and the leading
              // magnifier sits on top of the placeholder. Same fix as
              // `shell/side-pane-search.tsx`.
              className="kt-input min-h-[44px] w-full !pl-9 !pr-3"
            />
          </span>
        </label>
        <button
          type="button"
          className="kt-btn min-h-[44px] shrink-0"
          onClick={onRefresh}
          disabled={state === 'loading'}
          aria-label="Refresh skills"
        >
          {state === 'loading' ? (
            <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          Refresh
        </button>
      </div>

      {catalog !== null && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-panel pb-2 text-meta text-muted">
          <span>{skillHarnessLabel(catalog.harness)}</span>
          <span>
            {query.trim() ? `${visible} of ${catalog.skills.length}` : catalog.skills.length}{' '}
            {catalog.skills.length === 1 ? 'skill' : 'skills'}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-3">
        {state === 'loading' && (
          <p role="status" className="py-6 text-center text-cell text-muted">
            Loading skills…
          </p>
        )}
        {state === 'error' && (
          <div className="flex flex-col items-center gap-2 py-8 text-center" role="alert">
            <Sparkles size={22} aria-hidden="true" className="text-faint" />
            <p className="m-0 max-w-[38ch] text-cell leading-base text-err">Couldn&apos;t load skills: {error}</p>
          </div>
        )}
        {state === 'ready' && catalog !== null && (
          <SkillsCatalogList catalog={catalog} query={query} onInsert={insert} />
        )}
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {inserted === null ? '' : `Inserted ${inserted} into the composer draft. Review it before sending.`}
      </div>
    </div>
  );
}

/**
 * The live surface: one catalog read per `(daemonId, sessionId)`, refetched
 * whenever either changes. Nothing is cached across that boundary, so a daemon
 * switch can never leave the previous daemon's skills on screen.
 *
 * Refresh remounts the body by key rather than bumping a nonce the read effect
 * pretends to depend on. A reload is a fresh read of a catalog that may have
 * gained, lost or renamed skills, so resetting the search and the last-inserted
 * announcement with it is the honest behaviour as well as the simpler one.
 */
export function SkillsSurface({ scope, onInsert, loadCatalog }: SkillsSurfaceProps) {
  const [reload, setReload] = useState(0);
  return (
    <SkillsSurfaceBody
      key={`${daemonSessionKey(scope)}#${reload}`}
      scope={scope}
      onInsert={onInsert}
      loadCatalog={loadCatalog}
      onRefresh={() => setReload(value => value + 1)}
    />
  );
}

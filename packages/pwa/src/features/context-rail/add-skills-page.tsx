/**
 * "+ Add skills", a page: the skills of every catalog this browser subscribes to, to install into one session.
 *
 * The skills are grouped under the catalog they come from, and a chip row narrows the list to one catalog. Refresh
 * reads every subscription again, so a skill a publisher added since the page opened shows up without leaving it.
 *
 * Install is the EXISTING item review and hand-off (`SharedItemSheet` → `InstallFromFileSheet`): the review,
 * the warnings and the passkey are the ones a catalog install always has. The only new thing is the first
 * choice of place, handed in as `preferredTarget` (this project, else this account). Nothing is kept
 * offline: a publisher that cannot be reached says so in one line.
 */

import type { CatalogInstall, SessionSkillsInventory } from '@ferretry/protocol';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useKnownProjects } from '../../hooks/use-projects.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { daemonSessionPath, daemonSharingPath } from '../../lib/pages/routes.ts';
import { useAppStore, useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import { listCatalogInstalls } from '../catalogs/catalog-installs-api.ts';
import { FailureLine } from '../catalogs/catalog-parts.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { readFleetRuntimes } from '../fleet/catalog-api.ts';
import { readSessionSkillsInventory } from '../mcp/mcp-api.ts';
import type { SharedController } from '../shared/shared-controller.ts';
import { installedNames } from '../shared/shared-installs.ts';
import { type OpenedSharedItem, SharedItemSheet } from '../shared/shared-item-sheet.tsx';
import { ONLINE_ONLY, publisherLine, UNLOCK_BUTTON } from '../shared/shared-model.ts';
import { type CardState, cardState, isRefused, TRY_AGAIN, WORKING } from '../shared/shared-screens-model.ts';
import {
  ADD_SKILLS_BACK,
  ADD_SKILLS_SEARCH_LABEL,
  ADD_SKILLS_TITLE,
  ALL_CHIP,
  CATALOG_FILTER_LABEL,
  catalogChips,
  filterRows,
  groupByCatalog,
  INSTALL_BUTTON,
  INSTALLED_LABEL,
  installPlan,
  landedSentence,
  NO_SKILLS_FOUND,
  NO_SUBSCRIPTIONS,
  newInstalls,
  READING_SUBSCRIPTIONS,
  REFRESH_BUTTON,
  REFRESHED,
  REFRESHING,
  type RuntimeChoice,
  type SessionPlace,
  type SkillRow,
  SUBSCRIBE_WITH_LINK,
  scopeLine,
  skillRows,
} from './add-skills-model.ts';
import { ContextFilterChips } from './context-rail-parts.tsx';

type SharedPort = Pick<SharedController, 'list' | 'browse' | 'unlock' | 'openItem'>;

const GUTTER_CLASS = 'px-4 sm:px-5';
const COLUMN_CLASS = 'w-full max-w-[680px]';

export interface AddSkillsPageProps {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  /** The session the skills are for. */
  readonly sessionId: string;
  /** The session's working folder. */
  readonly cwd?: string;
  readonly onNavigate: (to: string) => void;
  /** Replaces the daemon-bound client, the browser's crypto and the known projects. A test and harness seam. */
  readonly install?: InstallHost;
  /** Replaces the store's member side. A test and harness seam. */
  readonly members?: SharedPort;
  /** Replaces the read of the session's skills. A test and harness seam. */
  readonly loadInventory?: () => Promise<SessionSkillsInventory>;
}

export function AddSkillsPage(props: AddSkillsPageProps) {
  const { members, install } = props;
  return members !== undefined && install?.projects !== undefined ? (
    <AddSkillsBody {...props} members={members} projects={install.projects} />
  ) : (
    <StoreBackedPage {...props} />
  );
}

function StoreBackedPage(props: AddSkillsPageProps) {
  const store = useAppStore();
  const known = useKnownProjects(store.projects, props.connection.daemonId);
  return (
    <AddSkillsBody {...props} members={props.members ?? store.members} projects={props.install?.projects ?? known} />
  );
}

const sessionPlace = (cwd: string | undefined, inventory: SessionSkillsInventory | null): SessionPlace => ({
  cwd,
  harness: inventory?.harness ?? 'claude',
  runtime: inventory?.runtime,
});

interface Shown {
  readonly sub: MemberSubscription;
  readonly item: OpenedSharedItem;
}

function AddSkillsBody({
  connection,
  machineName,
  sessionId,
  cwd,
  onNavigate,
  install: installHost,
  loadInventory,
  members,
  projects,
}: AddSkillsPageProps & { readonly members: SharedPort; readonly projects: readonly FleetProject[] }) {
  const routed = useDaemonClient();
  const createClient = installHost?.createClient ?? routed;
  const searchId = useId();
  const [subs, setSubs] = useState<readonly MemberSubscription[] | null>(null);
  const [states, setStates] = useState<Readonly<Record<string, CardState>>>({});
  const [installs, setInstalls] = useState<readonly CatalogInstall[] | null>(null);
  const [runtimes, setRuntimes] = useState<readonly RuntimeChoice[]>([]);
  const [inventory, setInventory] = useState<SessionSkillsInventory | null>(null);
  const [inventoryFailed, setInventoryFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState(ALL_CHIP);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const before = useRef<readonly CatalogInstall[] | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const machines = useMemo(() => [{ connection, name: machineName }], [connection, machineName]);
  const plan = useMemo(
    () => installPlan(sessionPlace(cwd, inventory), projects, runtimes),
    [cwd, inventory, projects, runtimes],
  );

  const readInstalls = useCallback(async (): Promise<readonly CatalogInstall[] | null> => {
    try {
      return (await listCatalogInstalls(await createClient(connection))).installs;
    } catch {
      return null;
    }
  }, [createClient, connection]);

  const readInventory = useCallback(async (): Promise<SessionSkillsInventory | null> => {
    try {
      return loadInventory === undefined
        ? await readSessionSkillsInventory(await createClient(connection), sessionId)
        : await loadInventory();
    } catch {
      return null;
    }
  }, [createClient, connection, sessionId, loadInventory]);

  const setState = useCallback((sub: MemberSubscription, state: CardState): void => {
    if (live.current) setStates(previous => ({ ...previous, [sub.daemonId]: state }));
  }, []);

  // A publisher already on screen keeps its skills while it is read again; only a first read says "reading".
  const browse = useCallback(
    async (sub: MemberSubscription, again: boolean): Promise<void> => {
      if (!again) setState(sub, { kind: 'loading' });
      setState(sub, cardState(await members.browse(sub)));
    },
    [members, setState],
  );

  const load = useCallback(
    async (again: boolean): Promise<void> => {
      const list = await members.list();
      if (!live.current) return;
      setSubs(list);
      await Promise.all(
        list.map(async sub => {
          if (isRefused(sub)) setState(sub, { kind: 'refused' });
          else await browse(sub, again);
        }),
      );
    },
    [members, browse, setState],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    void readInstalls().then(read => {
      if (live.current) setInstalls(read);
    });
  }, [readInstalls]);

  useEffect(() => {
    void readInventory().then(read => {
      if (!live.current) return;
      setInventory(read);
      setInventoryFailed(read === null);
    });
  }, [readInventory]);

  useEffect(() => {
    void createClient(connection)
      .then(async client => await readFleetRuntimes(client))
      .then(catalog => {
        if (live.current)
          setRuntimes(
            catalog.runtimes.map(runtime => ({ id: runtime.id, wrapper: runtime.wrapper, profile: runtime.profile })),
          );
      })
      .catch(() => undefined);
  }, [createClient, connection]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setRefreshed(false);
    const [, read, session] = await Promise.all([load(true), readInstalls(), readInventory()]);
    if (!live.current) return;
    if (read !== null) setInstalls(read);
    if (session !== null) setInventory(session);
    setRefreshing(false);
    setRefreshed(true);
  };

  const unlock = async (sub: MemberSubscription): Promise<void> => {
    setBusy(sub.daemonId);
    const attempt = await members.unlock(sub);
    setBusy(null);
    if (attempt.kind === 'ok') await browse(sub, false);
    else
      setState(
        sub,
        attempt.kind === 'refused' ? { kind: 'refused' } : { kind: 'failed', sentence: attempt.problem.sentence },
      );
  };

  const install = async (sub: MemberSubscription, row: SkillRow): Promise<void> => {
    setBusy(row.key);
    setFailure(null);
    before.current = await readInstalls();
    const attempt = await members.openItem(sub, row.view, row.entry);
    setBusy(null);
    if (attempt.kind === 'refused') setState(sub, { kind: 'refused' });
    else if (attempt.kind === 'failed') setFailure(attempt.problem.sentence);
    else setShown({ sub, item: attempt.value });
  };

  const closeItem = async (): Promise<void> => {
    setShown(null);
    const after = await readInstalls();
    if (after === null) return;
    setInstalls(after);
    const fresh = before.current === null ? [] : newInstalls(before.current, after);
    before.current = null;
    if (fresh.length === 0) return;
    const harness = inventory?.harness ?? 'claude';
    setLanded(fresh.map(item => landedSentence(item, plan, inventory, harness)).join(' '));
    // The session now sees more; the next install's sentence compares against that.
    void readInventory().then(read => {
      if (live.current && read !== null) setInventory(read);
    });
  };

  const groups = (subs ?? []).map(sub => {
    const label = publisherLine(sub).label;
    const state = states[sub.daemonId] ?? { kind: 'loading' };
    const rows =
      state.kind === 'ok' ? skillRows(state, sub.daemonId, label, installedNames(installs ?? [], sub.daemonId)) : [];
    return { sub, label, state, rows };
  });
  const everyRow = groups.flatMap(group => group.rows);
  const kept = filterRows(everyRow, query);
  const chips = catalogChips(everyRow, kept);
  // A catalog that no longer lists anything (after a refresh) reads as All.
  const active = chips.some(entry => entry.key === chip) ? chip : ALL_CHIP;
  const catalogs = groupByCatalog(kept, active);
  const subOf = (row: SkillRow): MemberSubscription | undefined =>
    groups.find(group => group.rows.some(candidate => candidate.key === row.key))?.sub;
  const settled = groups.every(group => group.state.kind !== 'loading');
  const notes = groups.filter(group => group.state.kind !== 'ok');
  const canInstall = inventory !== null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-add-skills-page="">
      <div className={`flex shrink-0 flex-wrap items-center gap-2 pt-2 ${GUTTER_CLASS}`}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="kt-btn--flush-start"
          onClick={() => onNavigate(daemonSessionPath(connection.daemonId, sessionId))}
          data-add-skills-back=""
        >
          <ArrowLeft size={14} aria-hidden />
          {ADD_SKILLS_BACK}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={refreshing || subs === null}
            onClick={() => void refresh()}
            data-add-skills-refresh=""
          >
            <RefreshCw
              size={14}
              aria-hidden
              className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            {refreshing ? REFRESHING : REFRESH_BUTTON}
          </Button>
          <PageThemeSwitch />
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto scroll-thin py-3 ${GUTTER_CLASS}`} data-add-skills-body="">
        <div className={`${COLUMN_CLASS} flex min-w-0 flex-col gap-md`}>
          <header className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 text-lg font-semibold text-fg">{ADD_SKILLS_TITLE}</h1>
            <p className="m-0 break-words text-meta text-muted" data-add-skills-scope="">
              {inventoryFailed
                ? 'This session’s skills could not be read, so nothing can be installed yet.'
                : scopeLine(plan)}
            </p>
          </header>
          {landed === null ? null : (
            <p className="m-0 break-words text-cell text-ok" role="status" data-add-skills-landed="">
              {landed}
            </p>
          )}
          {failure === null ? null : <FailureLine sentence={failure} />}
          <p className="sr-only" role="status" data-add-skills-refreshed="">
            {refreshed ? REFRESHED : ''}
          </p>
          {subs === null ? (
            <p className="m-0 text-cell text-muted" role="status">
              {READING_SUBSCRIPTIONS}
            </p>
          ) : subs.length === 0 ? (
            <p className="m-0 text-cell text-muted" data-add-skills-empty="">
              {NO_SUBSCRIPTIONS}
            </p>
          ) : (
            <>
              <div className="flex min-w-0 flex-col gap-xs">
                <label htmlFor={searchId} className="text-meta font-semibold text-muted">
                  {ADD_SKILLS_SEARCH_LABEL}
                </label>
                <input
                  id={searchId}
                  type="search"
                  className="kt-input"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  data-add-skills-search=""
                />
                {chips.length === 0 ? null : (
                  <ContextFilterChips label={CATALOG_FILTER_LABEL} chips={chips} value={active} onChange={setChip} />
                )}
              </div>
              {notes.length === 0 ? null : (
                <div className="flex min-w-0 flex-col gap-xs" data-add-skills-notes="">
                  {notes.map(({ sub, label, state }) => (
                    <section key={sub.daemonId} data-add-skills-publisher={sub.daemonId}>
                      <PublisherNote
                        label={label}
                        state={state}
                        busy={busy === sub.daemonId}
                        onUnlock={() => void unlock(sub)}
                        onAgain={() => void browse(sub, false)}
                      />
                    </section>
                  ))}
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-md" data-add-skills-catalogs="">
                {catalogs.map(group => (
                  <section key={group.key} className="flex min-w-0 flex-col gap-xs" data-add-skills-catalog={group.key}>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <h2 className="m-0 min-w-0 break-words text-cell font-semibold text-fg">{group.name}</h2>
                      <span className="min-w-0 break-words text-meta text-muted">
                        from {group.publisher} · {group.rows.length} {group.rows.length === 1 ? 'skill' : 'skills'}
                      </span>
                    </div>
                    <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={`Skills in ${group.name}`}>
                      {group.rows.map(row => (
                        <li key={row.key} className="min-w-0">
                          <SkillRowView
                            row={row}
                            busy={busy === row.key}
                            canInstall={canInstall}
                            onInstall={() => {
                              const sub = subOf(row);
                              if (sub !== undefined) void install(sub, row);
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              {catalogs.length > 0 || !settled || !groups.some(group => group.state.kind === 'ok') ? null : (
                <p className="m-0 text-cell text-muted" data-add-skills-none="">
                  {NO_SKILLS_FOUND}
                </p>
              )}
            </>
          )}
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="kt-btn--flush-start"
              onClick={() => onNavigate(daemonSharingPath(connection.daemonId, 'shared'))}
              data-add-skills-subscribe=""
            >
              {SUBSCRIBE_WITH_LINK}
            </Button>
          </div>
        </div>
      </div>
      {shown === null ? null : (
        <SharedItemSheet
          shown={shown.item}
          publisherLabel={shown.sub.ownLabel}
          machines={machines}
          {...(installHost === undefined ? {} : { installHost })}
          preferredTarget={plan.draft}
          onClose={() => void closeItem()}
        />
      )}
    </div>
  );
}

/** The one line a publisher that lists nothing says: reading, locked, offline, refused or failed. */
function PublisherNote({
  label,
  state,
  busy,
  onUnlock,
  onAgain,
}: {
  readonly label: string;
  readonly state: CardState;
  readonly busy: boolean;
  readonly onUnlock: () => void;
  readonly onAgain: () => void;
}) {
  switch (state.kind) {
    case 'ok':
      return null;
    case 'loading':
      return (
        <p className="m-0 text-cell text-muted" role="status">
          {label}: {READING_SUBSCRIPTIONS}
        </p>
      );
    case 'locked':
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-xs" data-add-skills-locked="">
          <p className="m-0 min-w-0 flex-1 break-words text-cell text-fg">{label} is locked.</p>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={onUnlock}
            data-add-skills-unlock=""
          >
            {busy ? WORKING : UNLOCK_BUTTON}
          </Button>
        </div>
      );
    case 'offline':
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-xs" data-add-skills-offline="">
          <p className="m-0 min-w-0 flex-1 break-words text-cell text-fg">
            {label}: {ONLINE_ONLY}
          </p>
          <Button type="button" size="sm" onClick={onAgain} data-add-skills-again="">
            {TRY_AGAIN}
          </Button>
        </div>
      );
    case 'refused':
      return (
        <p className="m-0 break-words text-cell text-err" data-add-skills-refused="">
          {label} refused this browser. Open Sharing › Subscriptions to try again.
        </p>
      );
    case 'failed':
      return (
        <p className="m-0 break-words text-cell text-err" data-add-skills-failed="">
          {label}: {state.sentence}
        </p>
      );
  }
}

function SkillRowView({
  row,
  busy,
  canInstall,
  onInstall,
}: {
  readonly row: SkillRow;
  readonly busy: boolean;
  readonly canInstall: boolean;
  readonly onInstall: () => void;
}) {
  return (
    <div className="kt-panel flex min-w-0 items-start gap-xs px-control-x py-2" data-add-skills-row={row.entry.itemId}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-cell font-semibold text-fg">
          {row.name} <span className="font-normal text-muted">{row.version}</span>
        </span>
        <span className="break-words text-meta text-muted">{row.summary}</span>
      </div>
      {row.installed ? (
        <span className="shrink-0 text-cell text-ok" data-add-skills-installed="">
          {INSTALLED_LABEL}
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={busy || !canInstall}
          onClick={onInstall}
          data-add-skills-install=""
        >
          {busy ? WORKING : INSTALL_BUTTON}
          <span className="sr-only"> {row.name}</span>
        </Button>
      )}
    </div>
  );
}

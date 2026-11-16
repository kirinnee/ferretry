/**
 * "+ Add skills", a page: the skills of every catalog this browser subscribes to, to install into one ferret.
 *
 * The skills are grouped under the catalog they come from, and a chip row narrows the list to one catalog. Refresh
 * reads every subscription again, so a skill a publisher added since the page opened shows up without leaving it.
 *
 * Install is the EXISTING item review and hand-off (`SharedItemSheet` → `InstallFromFileSheet`): the review, the
 * warnings and the passkey are the ones a catalog install always has. The only new thing is the first choice of place,
 * handed in as `preferredTarget` (this project, else this account). Nothing is kept offline: a publisher that cannot be
 * reached says so in one line. Copied from today's `add-skills-page.tsx`, less its group of skills on this machine.
 */

import { Button, ContextFilterChips, usePullToSearch } from '@ferretry/app/ui';
import { ArrowLeft, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CatalogInstall } from '../../../contract/wire/index.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import type { DaemonConnection } from '../../lib/machine.ts';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { listCatalogInstalls } from '../catalogs/catalog-installs-api.ts';
import { FailureLine } from '../catalogs/catalog-parts.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import type { SharedController } from '../shared/shared-controller.ts';
import { installedNames } from '../shared/shared-installs.ts';
import { type OpenedSharedItem, SharedItemSheet } from '../shared/shared-item-sheet.tsx';
import { ONLINE_ONLY, publisherLine, UNLOCK_BUTTON } from '../shared/shared-model.ts';
import { type CardState, cardState, isRefused, TRY_AGAIN, WORKING } from '../shared/shared-screens-model.ts';
import { secondTicker, type Ticker, useClock } from '../shared/use-clock.ts';
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
  REFRESHING,
  type RuntimeChoice,
  type SessionPlace,
  type SkillRow,
  SUBSCRIBE_WITH_LINK,
  scopeLine,
  skillRows,
  unreachableLine,
  updatedLine,
} from './add-skills-model.ts';

type SharedPort = Pick<SharedController, 'list' | 'browse' | 'unlock' | 'openItem'>;

const GUTTER_CLASS = 'px-4 sm:px-5';
const COLUMN_CLASS = 'w-full max-w-[680px]';

export interface AddSkillsPageProps {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  /** The ferret the skills are for. */
  readonly ferret: string;
  /** What the ferret's skills tab knew of it: its folder, harness, runtime and where its skills come from. */
  readonly place: SessionPlace & { readonly scopes: readonly string[] };
  readonly members: SharedPort;
  readonly onBack: () => void;
  readonly onSubscribe: () => void;
  /** Replaces the daemon-bound client and names the projects and runtimes the host knows. */
  readonly install?: InstallHost;
  /** The runtimes the host names, by wrapper: with none, an install into this account is picked in the sheet. */
  readonly runtimes?: readonly RuntimeChoice[];
  /** Replaces the wall clock and its once-a-second tick behind "Updated … ago". A test and harness seam. */
  readonly clock?: { readonly now: () => Date; readonly ticker: Ticker };
}

const WALL_CLOCK = { now: () => new Date(), ticker: secondTicker };
const NO_RUNTIMES: readonly RuntimeChoice[] = [];
const NO_PROJECTS: readonly { readonly name: string; readonly path: string }[] = [];

interface Shown {
  readonly sub: MemberSubscription;
  readonly item: OpenedSharedItem;
}

export function AddSkillsPage({
  connection,
  machineName,
  place,
  members,
  onBack,
  onSubscribe,
  install: installHost,
  runtimes = NO_RUNTIMES,
  clock = WALL_CLOCK,
}: AddSkillsPageProps) {
  const routed = useDaemonClient();
  const createClient = installHost?.createClient ?? routed;
  const searchId = useId();
  const [subs, setSubs] = useState<readonly MemberSubscription[] | null>(null);
  const [states, setStates] = useState<Readonly<Record<string, CardState>>>({});
  const [installs, setInstalls] = useState<readonly CatalogInstall[] | null>(null);
  // Where the ferret's skills come from: what an install of a new kind adds to, for the next landing sentence.
  const [scopes, setScopes] = useState<readonly string[]>(place.scopes);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState(ALL_CHIP);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [unreached, setUnreached] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const before = useRef<readonly CatalogInstall[] | null>(null);
  const live = useRef(true);
  // True while any read of every list is under way, so a tab coming back never starts a second one on top of it.
  const reading = useRef(true);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const now = useClock(clock.now, clock.ticker, updatedAt !== null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const machines = useMemo(() => [{ connection, name: machineName }], [connection, machineName]);
  const plan = useMemo(
    () => installPlan(place, installHost?.projects ?? NO_PROJECTS, runtimes),
    [place, installHost?.projects, runtimes],
  );

  const readInstalls = useCallback(async (): Promise<readonly CatalogInstall[] | null> => {
    try {
      return (await listCatalogInstalls(await createClient(connection))).installs;
    } catch {
      return null;
    }
  }, [createClient, connection]);

  const setState = useCallback((sub: MemberSubscription, state: CardState): void => {
    if (live.current) setStates(previous => ({ ...previous, [sub.daemonId]: state }));
  }, []);

  // A publisher already on screen keeps its skills while it is read again, and when it cannot be reached.
  const browse = useCallback(
    async (sub: MemberSubscription, again: boolean): Promise<CardState> => {
      if (!again) setState(sub, { kind: 'loading' });
      const next = cardState(await members.browse(sub));
      const lost = again && (next.kind === 'offline' || next.kind === 'failed');
      if (live.current)
        setStates(previous =>
          lost && previous[sub.daemonId]?.kind === 'ok' ? previous : { ...previous, [sub.daemonId]: next },
        );
      return next;
    },
    [members, setState],
  );

  /** Reads every subscription; answers the names of the publishers that did not answer. */
  const load = useCallback(
    async (again: boolean): Promise<readonly string[]> => {
      const list = await members.list();
      if (!live.current) return [];
      setSubs(list);
      const outcomes = await Promise.all(
        list.map(async sub => {
          if (isRefused(sub)) {
            setState(sub, { kind: 'refused' });
            return [];
          }
          const state = await browse(sub, again);
          return state.kind === 'offline' || state.kind === 'failed' ? [publisherLine(sub).label] : [];
        }),
      );
      return outcomes.flat();
    },
    [members, browse, setState],
  );

  useEffect(() => {
    void load(false).then(names => {
      reading.current = false;
      if (!live.current) return;
      setUnreached(names);
      setUpdatedAt(clock.now().getTime());
    });
  }, [load, clock]);

  useEffect(() => {
    void readInstalls().then(read => {
      if (live.current) setInstalls(read);
    });
  }, [readInstalls]);

  const refresh = async (): Promise<void> => {
    if (reading.current) return;
    reading.current = true;
    setRefreshing(true);
    const [names, read] = await Promise.all([load(true), readInstalls()]);
    reading.current = false;
    if (!live.current) return;
    if (read !== null) setInstalls(read);
    setUnreached(names);
    setUpdatedAt(clock.now().getTime());
    setRefreshing(false);
  };
  refreshRef.current = refresh;

  // A tab left open while a publisher adds a skill reads the lists again the moment the person comes back to it.
  useEffect(() => {
    const comeBack = (): void => {
      if (document.visibilityState === 'visible') void refreshRef.current?.();
    };
    document.addEventListener('visibilitychange', comeBack);
    return () => document.removeEventListener('visibilitychange', comeBack);
  }, []);

  const pull = usePullToSearch(bodyRef, {
    enabled: subs !== null && !refreshing,
    onTrigger: () => void refreshRef.current?.(),
  });

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
    setLanded(fresh.map(item => landedSentence(item, plan, scopes, place.harness)).join(' '));
    // The ferret now sees more; the next install's sentence compares against that.
    setScopes(known => [
      ...new Set([...known, ...fresh.map(item => (item.target.scope === 'project' ? 'project' : 'user'))]),
    ]);
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
  const settled = groups.every(group => group.state.kind !== 'loading');

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-add-skills-page="">
      <div className={`flex shrink-0 flex-wrap items-center gap-2 pt-2 ${GUTTER_CLASS}`}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="kt-btn--flush-start"
          onClick={onBack}
          data-add-skills-back=""
        >
          <ArrowLeft size={14} aria-hidden />
          {ADD_SKILLS_BACK}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <p
            className={`m-0 text-meta ${unreached.length === 0 ? 'text-muted' : 'text-err'}`}
            role="status"
            data-add-skills-updated=""
          >
            {refreshing
              ? ''
              : unreached.length > 0
                ? unreachableLine(unreached)
                : updatedAt === null
                  ? ''
                  : updatedLine(updatedAt, now.getTime())}
          </p>
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
        </div>
      </div>
      <div
        ref={bodyRef}
        className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain scroll-thin py-3 ${GUTTER_CLASS}`}
        data-add-skills-body=""
      >
        {pull.distance <= 0 ? null : (
          <div
            className="flex items-center justify-center overflow-hidden text-muted"
            style={{ height: Math.min(pull.distance, 64) }}
            data-add-skills-pull={pull.armed ? 'armed' : 'pulling'}
          >
            <RefreshCw size={16} aria-hidden style={{ transform: `rotate(${Math.round(pull.progress * 270)}deg)` }} />
            <span className="sr-only">{pull.armed ? 'Release to refresh' : 'Pull down to refresh'}</span>
          </div>
        )}
        <div className={`${COLUMN_CLASS} flex min-w-0 flex-col gap-md`}>
          <header className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 text-lg font-semibold text-fg">{ADD_SKILLS_TITLE}</h1>
            <p className="m-0 break-words text-meta text-muted" data-add-skills-scope="">
              {scopeLine(plan)}
            </p>
          </header>
          {landed === null ? null : (
            <p className="m-0 break-words text-cell text-ok" role="status" data-add-skills-landed="">
              {landed}
            </p>
          )}
          {failure === null ? null : <FailureLine sentence={failure} />}
          {subs !== null && subs.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-xs">
              <label htmlFor={searchId} className="sr-only">
                {ADD_SKILLS_SEARCH_LABEL}
              </label>
              <div className="relative min-w-0">
                <Search
                  size={14}
                  aria-hidden
                  className="pointer-events-none absolute left-control-x top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  id={searchId}
                  type="search"
                  className="kt-input w-full !pl-9"
                  placeholder={ADD_SKILLS_SEARCH_LABEL}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  data-add-skills-search=""
                />
              </div>
            </div>
          ) : null}
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
              {chips.length === 0 ? null : (
                <div className="flex min-w-0 flex-col gap-xs">
                  <ContextFilterChips label={CATALOG_FILTER_LABEL} chips={chips} value={active} onChange={setChip} />
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-md" data-add-skills-catalogs="">
                {groups.flatMap(({ sub, label, state }) =>
                  state.kind === 'ok'
                    ? catalogs
                        .filter(group => group.publisherId === sub.daemonId)
                        .map(group => (
                          <section
                            key={group.key}
                            className="flex min-w-0 flex-col gap-xs"
                            data-add-skills-catalog={group.key}
                          >
                            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                              <h2 className="m-0 min-w-0 break-words text-cell font-semibold text-fg">{group.name}</h2>
                              <span className="min-w-0 break-words text-meta text-muted">
                                from {group.publisher} · {group.rows.length}{' '}
                                {group.rows.length === 1 ? 'skill' : 'skills'}
                              </span>
                            </div>
                            <ul
                              className="m-0 flex list-none flex-col gap-xs p-0"
                              aria-label={`Skills in ${group.name}`}
                            >
                              {group.rows.map(row => (
                                <li key={row.key} className="min-w-0">
                                  <SkillRowView
                                    row={row}
                                    busy={busy === row.key}
                                    onInstall={() => void install(sub, row)}
                                  />
                                </li>
                              ))}
                            </ul>
                          </section>
                        ))
                    : active !== ALL_CHIP
                      ? []
                      : [
                          <section
                            key={sub.daemonId}
                            className="flex min-w-0 flex-col gap-xs"
                            data-add-skills-publisher={sub.daemonId}
                          >
                            <h2 className="m-0 min-w-0 break-words text-cell font-semibold text-fg">{label}</h2>
                            <PublisherNote
                              state={state}
                              busy={busy === sub.daemonId}
                              onUnlock={() => void unlock(sub)}
                              onAgain={() => void browse(sub, false)}
                            />
                          </section>,
                        ],
                )}
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
              onClick={onSubscribe}
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

/** What a catalog section says when its publisher lists nothing: reading, locked, offline, refused or failed. */
function PublisherNote({
  state,
  busy,
  onUnlock,
  onAgain,
}: {
  readonly state: Exclude<CardState, { readonly kind: 'ok' }>;
  readonly busy: boolean;
  readonly onUnlock: () => void;
  readonly onAgain: () => void;
}) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className="m-0 text-cell text-muted" role="status">
          {READING_SUBSCRIPTIONS}
        </p>
      );
    case 'locked':
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-xs" data-add-skills-locked="">
          <p className="m-0 min-w-0 flex-1 break-words text-cell text-fg">Locked. Unlock it to see its skills.</p>
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
          <p className="m-0 min-w-0 flex-1 break-words text-cell text-fg">{ONLINE_ONLY}</p>
          <Button type="button" size="sm" onClick={onAgain} data-add-skills-again="">
            {TRY_AGAIN}
          </Button>
        </div>
      );
    case 'refused':
      return (
        <p className="m-0 break-words text-cell text-err" data-add-skills-refused="">
          Refused this browser. Open Sharing › Subscriptions to try again.
        </p>
      );
    case 'failed':
      return (
        <p className="m-0 break-words text-cell text-err" data-add-skills-failed="">
          {state.sentence}
        </p>
      );
  }
}

function SkillRowView({
  row,
  busy,
  onInstall,
}: {
  readonly row: SkillRow;
  readonly busy: boolean;
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
          disabled={busy}
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

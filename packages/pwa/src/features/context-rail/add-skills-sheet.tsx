/**
 * "+ Add skills": the skills of every catalog this browser subscribes to, to install into this session.
 *
 * Install is the EXISTING item review and hand-off (`SharedItemSheet` → `InstallFromFileSheet`): the review,
 * the warnings and the passkey are the ones a catalog install always has. The only new thing is the first
 * choice of place, handed in as `preferredTarget` (this project, else this account). Nothing is kept
 * offline: a publisher that cannot be reached says so in one line.
 */

import type {
  CatalogInstall,
  LocalSkillInstall,
  MachineSkillsInventory,
  SessionSkillsInventory,
} from '@ferretry/protocol';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { useAppStore, useDaemonClient } from '../../lib/store.tsx';
import { useKnownProjects } from '../../hooks/use-projects.ts';
import { Button } from '../../shell/primitives.tsx';
import { listCatalogInstalls } from '../catalogs/catalog-installs-api.ts';
import { CatalogSheet, FailureLine } from '../catalogs/catalog-parts.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { listLocalSkillInstalls } from '../catalogs/local-skill-installs-api.ts';
import { readFleetRuntimes } from '../fleet/catalog-api.ts';
import { readMachineSkills } from '../mcp/mcp-api.ts';
import type { SharedController } from '../shared/shared-controller.ts';
import { installedNames } from '../shared/shared-installs.ts';
import { type OpenedSharedItem, SharedItemSheet } from '../shared/shared-item-sheet.tsx';
import { ONLINE_ONLY, publisherLine, UNLOCK_BUTTON } from '../shared/shared-model.ts';
import { type CardState, cardState, isRefused, TRY_AGAIN, WORKING } from '../shared/shared-screens-model.ts';
import {
  ADD_SKILLS_CLOSE,
  ADD_SKILLS_SEARCH_LABEL,
  ADD_SKILLS_TITLE,
  filterRows,
  FROM_SUBSCRIPTIONS,
  INSTALL_BUTTON,
  INSTALLED_LABEL,
  installPlan,
  landedSentence,
  landingSentence,
  newInstalls,
  NO_SKILLS_FOUND,
  NO_SUBSCRIPTIONS,
  READING_SUBSCRIPTIONS,
  type RuntimeChoice,
  type SessionPlace,
  type SkillRow,
  scopeLine,
  skillRows,
  SUBSCRIBE_WITH_LINK,
} from './add-skills-model.ts';
import { LocalSkillInstallSheet } from './local-skill-install-sheet.tsx';
import { MachineGroup } from './machine-skills-group.tsx';
import { filterMachineRows, type MachineSkillRow, machineRows, targetOptions } from './machine-skills-model.ts';

type SharedPort = Pick<SharedController, 'list' | 'browse' | 'unlock' | 'openItem'>;

/** What the Skills tab hands the sheet: the machine, the session's folder, and where Subscribe leads. */
export interface AddSkillsHost {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  /** The session's working folder. */
  readonly cwd?: string;
  /** Opens Sharing › Subscriptions. */
  readonly onSubscribe: () => void;
  /** Replaces the daemon-bound client, the browser's crypto and the known projects. A test and harness seam. */
  readonly install?: InstallHost;
  /** Replaces the store's member side. A test and harness seam. */
  readonly members?: SharedPort;
}

export interface AddSkillsSheetProps {
  readonly host: AddSkillsHost;
  /** The session's skills as last read: its harness, its runtime, and what it already sees. */
  readonly inventory: SessionSkillsInventory;
  /** The session's skills must be read again. */
  readonly onInstalled: () => void;
  readonly onClose: () => void;
}

export function AddSkillsSheet(props: AddSkillsSheetProps) {
  const { members, install } = props.host;
  return members !== undefined && install?.projects !== undefined ? (
    <AddSkillsBody {...props} members={members} projects={install.projects} />
  ) : (
    <StoreBackedSheet {...props} />
  );
}

function StoreBackedSheet(props: AddSkillsSheetProps) {
  const store = useAppStore();
  const known = useKnownProjects(store.projects, props.host.connection.daemonId);
  return (
    <AddSkillsBody
      {...props}
      members={props.host.members ?? store.members}
      projects={props.host.install?.projects ?? known}
    />
  );
}

const sessionPlace = (host: AddSkillsHost, inventory: SessionSkillsInventory): SessionPlace => ({
  cwd: host.cwd,
  harness: inventory.harness,
  runtime: inventory.runtime,
});

interface Shown {
  readonly sub: MemberSubscription;
  readonly item: OpenedSharedItem;
}

function AddSkillsBody({
  host,
  inventory,
  onInstalled,
  onClose,
  members,
  projects,
}: AddSkillsSheetProps & { readonly members: SharedPort; readonly projects: readonly FleetProject[] }) {
  const routed = useDaemonClient();
  const createClient = host.install?.createClient ?? routed;
  const searchId = useId();
  const [subs, setSubs] = useState<readonly MemberSubscription[] | null>(null);
  const [states, setStates] = useState<Readonly<Record<string, CardState>>>({});
  const [installs, setInstalls] = useState<readonly CatalogInstall[] | null>(null);
  const [runtimes, setRuntimes] = useState<readonly RuntimeChoice[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [machine, setMachine] = useState<MachineSkillsInventory | null | undefined>(undefined);
  const [copies, setCopies] = useState<readonly LocalSkillInstall[] | null>(null);
  const [copying, setCopying] = useState<MachineSkillRow | null>(null);
  const before = useRef<readonly CatalogInstall[] | null>(null);

  const machines = useMemo(
    () => [{ connection: host.connection, name: host.machineName }],
    [host.connection, host.machineName],
  );
  const plan = useMemo(
    () => installPlan(sessionPlace(host, inventory), projects, runtimes),
    [host, inventory, projects, runtimes],
  );

  const readInstalls = useCallback(async (): Promise<readonly CatalogInstall[] | null> => {
    try {
      return (await listCatalogInstalls(await createClient(host.connection))).installs;
    } catch {
      return null;
    }
  }, [createClient, host.connection]);

  const setState = useCallback((sub: MemberSubscription, state: CardState): void => {
    setStates(previous => ({ ...previous, [sub.daemonId]: state }));
  }, []);
  const browse = useCallback(
    async (sub: MemberSubscription): Promise<void> => {
      setState(sub, { kind: 'loading' });
      setState(sub, cardState(await members.browse(sub)));
    },
    [members, setState],
  );

  useEffect(() => {
    let live = true;
    void members.list().then(list => {
      if (!live) return;
      setSubs(list);
      for (const sub of list) {
        if (isRefused(sub)) setState(sub, { kind: 'refused' });
        else void browse(sub);
      }
    });
    return () => {
      live = false;
    };
  }, [members, browse, setState]);

  useEffect(() => {
    let live = true;
    void readInstalls().then(read => {
      if (live) setInstalls(read);
    });
    return () => {
      live = false;
    };
  }, [readInstalls]);

  useEffect(() => {
    let live = true;
    void createClient(host.connection)
      .then(async client => await readFleetRuntimes(client))
      .then(catalog => {
        if (live)
          setRuntimes(
            catalog.runtimes.map(runtime => ({ id: runtime.id, wrapper: runtime.wrapper, profile: runtime.profile })),
          );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [createClient, host.connection]);

  useEffect(() => {
    let live = true;
    void createClient(host.connection)
      .then(async client => await readMachineSkills(client))
      .then(read => {
        if (live) setMachine(read);
      })
      .catch(() => {
        if (live) setMachine(null);
      });
    return () => {
      live = false;
    };
  }, [createClient, host.connection]);

  const readCopies = useCallback(async (): Promise<readonly LocalSkillInstall[] | null> => {
    try {
      return (await listLocalSkillInstalls(await createClient(host.connection))).installs;
    } catch {
      return null;
    }
  }, [createClient, host.connection]);

  useEffect(() => {
    let live = true;
    void readCopies().then(read => {
      if (live) setCopies(read);
    });
    return () => {
      live = false;
    };
  }, [readCopies]);

  const unlock = async (sub: MemberSubscription): Promise<void> => {
    setBusy(sub.daemonId);
    const attempt = await members.unlock(sub);
    setBusy(null);
    if (attempt.kind === 'ok') await browse(sub);
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
    setLanded(fresh.map(item => landedSentence(item, plan, inventory, inventory.harness)).join(' '));
    onInstalled();
  };

  const options = targetOptions(projects, runtimes);
  const allMachine = useMemo(
    () =>
      machine === undefined || machine === null
        ? machine
        : machineRows(machine, inventory, new Set((copies ?? []).map(copy => copy.origin.path))),
    [machine, inventory, copies],
  );
  const shownMachine =
    allMachine === undefined || allMachine === null ? allMachine : filterMachineRows(allMachine, query);

  const closeCopy = async (installed: LocalSkillInstall | null): Promise<void> => {
    setCopying(null);
    if (installed === null) return;
    setCopies(await readCopies());
    setLanded(landingSentence(installed, plan, inventory, inventory.harness));
    onInstalled();
  };

  if (copying !== null)
    return (
      <LocalSkillInstallSheet
        row={copying}
        connection={host.connection}
        createClient={createClient}
        initial={plan.draft}
        options={options}
        onClose={installed => void closeCopy(installed)}
      />
    );

  if (shown !== null)
    return (
      <SharedItemSheet
        shown={shown.item}
        publisherLabel={shown.sub.ownLabel}
        machines={machines}
        {...(host.install === undefined ? {} : { installHost: host.install })}
        preferredTarget={plan.draft}
        onClose={() => void closeItem()}
      />
    );

  return (
    <CatalogSheet name="add-skills" title={ADD_SKILLS_TITLE} closeLabel={ADD_SKILLS_CLOSE} onClose={onClose}>
      <p className="m-0 break-words text-meta text-muted" data-add-skills-scope="">
        {scopeLine(plan)}
      </p>
      {landed === null ? null : (
        <p className="m-0 break-words text-cell text-ok" role="status" data-add-skills-landed="">
          {landed}
        </p>
      )}
      {failure === null ? null : <FailureLine sentence={failure} />}
      <div className="flex min-w-0 flex-col gap-1">
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
      </div>
      <h4 className="m-0 text-cell font-semibold text-fg">{FROM_SUBSCRIPTIONS}</h4>
      {subs === null ? (
        <p className="m-0 text-cell text-muted" role="status">
          {READING_SUBSCRIPTIONS}
        </p>
      ) : subs.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-add-skills-empty="">
          {NO_SUBSCRIPTIONS}
        </p>
      ) : (
        <Publishers
          subs={subs}
          states={states}
          installs={installs ?? []}
          query={query}
          busy={busy}
          onUnlock={sub => void unlock(sub)}
          onAgain={sub => void browse(sub)}
          onInstall={(sub, row) => void install(sub, row)}
        />
      )}
      <MachineGroup
        rows={shownMachine}
        all={allMachine === undefined || allMachine === null ? 0 : allMachine.length}
        truncated={machine !== undefined && machine !== null && machine.truncated}
        onInstall={setCopying}
      />
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="kt-btn--flush-start"
          onClick={() => {
            onClose();
            host.onSubscribe();
          }}
          data-add-skills-subscribe=""
        >
          {SUBSCRIBE_WITH_LINK}
        </Button>
      </div>
    </CatalogSheet>
  );
}

function Publishers({
  subs,
  states,
  installs,
  query,
  busy,
  onUnlock,
  onAgain,
  onInstall,
}: {
  readonly subs: readonly MemberSubscription[];
  readonly states: Readonly<Record<string, CardState>>;
  readonly installs: readonly CatalogInstall[];
  readonly query: string;
  readonly busy: string | null;
  readonly onUnlock: (sub: MemberSubscription) => void;
  readonly onAgain: (sub: MemberSubscription) => void;
  readonly onInstall: (sub: MemberSubscription, row: SkillRow) => void;
}) {
  const groups = subs.map(sub => {
    const label = publisherLine(sub).label;
    const state = states[sub.daemonId] ?? { kind: 'loading' };
    const rows =
      state.kind === 'ok'
        ? filterRows(skillRows(state, sub.daemonId, label, installedNames(installs, sub.daemonId)), query)
        : [];
    return { sub, label, state, rows };
  });
  const listed = groups.some(group => group.rows.length > 0);
  const settled = groups.every(group => group.state.kind !== 'loading');
  return (
    <div className="flex min-w-0 flex-col gap-xs" data-add-skills-publishers="">
      {groups.map(({ sub, label, state, rows }) => (
        <section key={sub.daemonId} className="flex min-w-0 flex-col gap-xs" data-add-skills-publisher={sub.daemonId}>
          <PublisherNote
            label={label}
            state={state}
            busy={busy === sub.daemonId}
            onUnlock={() => onUnlock(sub)}
            onAgain={() => onAgain(sub)}
          />
          {rows.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={`Skills from ${label}`}>
              {rows.map(row => (
                <li key={row.key} className="min-w-0">
                  <SkillRowView row={row} busy={busy === row.key} onInstall={() => onInstall(sub, row)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {listed || !settled || !groups.some(group => group.state.kind === 'ok') ? null : (
        <p className="m-0 text-cell text-muted" data-add-skills-none="">
          {NO_SKILLS_FOUND}
        </p>
      )}
    </div>
  );
}

/** The one line a publisher that lists nothing says: locked, offline, refused or failed. */
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
        <span className="break-words text-meta text-muted">{row.from}</span>
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

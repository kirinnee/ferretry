/**
 * SHARING — the one place to share skills and MCP servers, see what is shared with you, and say who
 * can read your catalogs.
 *
 * Four views of one thing, as the ordinary level-three underlined tabs: My catalogs, Shared with me,
 * People and Skills. The tab is part of the address (`/d/:daemon/sharing/:tab`), so a view is linkable
 * and Back steps through the views the reader opened.
 *
 * The page is ONE machine's: the connection arrives from the app's existing machine selection, so there
 * is no second switcher here. Each view is the screen that already existed — this page only gives them
 * a home. Skills is the machine's own inventory in the session surface's rows, unchanged.
 */

import { useMemo } from 'react';
import type { InstallMachine } from '../shared/shared-item-sheet.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonSharingPath, SHARING_TABS, type SharingTab } from '../../lib/pages/routes.ts';
import { useDaemonClient, useDaemonFetch } from '../../lib/store.tsx';
import { UnderlineTabs } from '../../shell/underline-tabs.tsx';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import { CatalogMembersPanel } from '../catalogs/catalog-members.tsx';
import { FailureLine, SharingOffPanel } from '../catalogs/catalog-parts.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import { AddCatalogEntry } from '../catalogs/catalog-row-tools.tsx';
import { CatalogsSurface, useCatalogs } from '../catalogs/catalogs-surface.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { SharedWithMe } from '../shared/shared-with-me.tsx';
import type { SharedController } from '../shared/shared-controller.ts';
import { MACHINE_SKILLS_SESSION, machineSkillsLoader } from '../skills/machine-skills-api.ts';
import type { SkillsCatalogLoader } from '../skills/skills-api.ts';
import { SkillsSurface } from '../skills/skills-surface.tsx';

export const DEFAULT_SHARING_TAB: SharingTab = 'catalogs';

const TAB_LABELS: Readonly<Record<SharingTab, string>> = {
  catalogs: 'My catalogs',
  shared: 'Shared with me',
  people: 'People',
  skills: 'Skills',
};

const TABS = SHARING_TABS.map(id => ({ id, label: TAB_LABELS[id] }));

/** A skill is used from a chat; this page has none, so the row's button says where to go. */
export const SKILLS_USE_NOTE = 'Skills are used from a session: open one and type the name there.';

const GUTTER_CLASS = 'px-4 sm:px-5';
const COLUMN_CLASS = 'w-full max-w-[680px]';

type SharedPort = Pick<
  SharedController,
  'list' | 'browse' | 'unlock' | 'openItem' | 'leave' | 'forget' | 'rename' | 'tryAgain'
>;

export interface SharingPageProps {
  readonly connection: DaemonConnection;
  readonly tab: SharingTab | undefined;
  readonly onNavigate: (to: string) => void;
  /** What other people share with this browser, and the machines it could install them on. */
  readonly members: SharedPort;
  readonly machines: readonly InstallMachine[];
  /** Seams for tests and the harness; the app uses the daemon-bound client and the daemon's own routes. */
  readonly createClient?: CatalogClientFactory;
  readonly installHost?: InstallHost;
  readonly loadSkills?: SkillsCatalogLoader;
}

export function SharingPage({
  connection,
  tab,
  onNavigate,
  members,
  machines,
  createClient,
  installHost,
  loadSkills,
}: SharingPageProps) {
  const current = tab ?? DEFAULT_SHARING_TAB;
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-sharing={current}>
      <div className={`flex shrink-0 items-end gap-2 pt-2 ${GUTTER_CLASS}`}>
        <h1 className="sr-only">Sharing</h1>
        <UnderlineTabs
          className="min-w-0 flex-1"
          current={current}
          label="Sharing"
          marker="data-sharing-tab"
          onSelect={id => onNavigate(daemonSharingPath(connection.daemonId, id))}
          tabs={TABS}
        />
        <PageThemeSwitch />
      </div>
      {current === 'skills' ? (
        <div className="flex min-h-0 flex-1 flex-col" data-sharing-body="">
          <MachineSkills connection={connection} loadSkills={loadSkills} createClient={createClient} />
        </div>
      ) : (
        <div className={`min-h-0 flex-1 overflow-y-auto scroll-thin py-3 ${GUTTER_CLASS}`} data-sharing-body="">
          <div className={COLUMN_CLASS}>
            {current === 'catalogs' ? (
              <CatalogsSurface
                connection={connection}
                {...(createClient === undefined ? {} : { createClient })}
                {...(installHost === undefined ? {} : { installHost })}
              />
            ) : current === 'shared' ? (
              <div className="flex min-w-0 flex-col gap-md">
                <AddCatalogEntry host={{ connection, ...(createClient === undefined ? {} : { createClient }) }} />
                <SharedWithMe
                  embedded
                  members={members}
                  machines={machines}
                  {...(installHost === undefined ? {} : { installHost })}
                />
              </div>
            ) : (
              <People connection={connection} createClient={createClient} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MachineSkills({
  connection,
  loadSkills,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly loadSkills: SkillsCatalogLoader | undefined;
  readonly createClient: CatalogClientFactory | undefined;
}) {
  const fetcher = useDaemonFetch();
  const load = useMemo(() => loadSkills ?? machineSkillsLoader(connection, fetcher), [connection, fetcher, loadSkills]);
  return (
    <SkillsSurface
      scope={daemonSessionScope(connection, MACHINE_SKILLS_SESSION)}
      loadCatalog={load}
      onInsert={() => SKILLS_USE_NOTE}
      catalogs={{ connection, ...(createClient === undefined ? {} : { createClient }) }}
    />
  );
}

/** Who can read your catalogs. The panel names what each person reads, so the catalogs are read here too. */
function People({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: CatalogClientFactory | undefined;
}) {
  const { read, reload } = useCatalogsFor(connection, createClient);
  if (read.kind === 'loading')
    return (
      <p className="m-0 text-cell text-muted" role="status">
        Reading people…
      </p>
    );
  if (read.kind === 'failed')
    return read.refusal.sharingOff ? (
      <SharingOffPanel connection={connection} {...(createClient === undefined ? {} : { createClient })} />
    ) : (
      <FailureLine sentence={read.refusal.sentence} again onAgain={reload} againLabel="Try again" />
    );
  return (
    <CatalogMembersPanel
      connection={connection}
      catalogs={read.catalogs}
      {...(createClient === undefined ? {} : { createClient })}
    />
  );
}

function useCatalogsFor(connection: DaemonConnection, createClient: CatalogClientFactory | undefined) {
  const routed = useDaemonClient();
  return useCatalogs(connection, createClient ?? routed, false);
}

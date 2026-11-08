/**
 * SHARING — a marketplace in three views (&B131): what this browser subscribes to and can install, the catalogs this
 * machine publishes, and who subscribes to them.
 *
 * The tabs are the ordinary level-three underlined tabs: Subscriptions, My catalogs and People. The tab is part of the
 * address (`/d/:daemon/sharing/:tab`), so a view is linkable and Back steps through the views the reader opened.
 *
 * The page is ONE machine's: the connection arrives from the app's existing machine selection, so there is no second
 * switcher here. Publishing a skill starts in My catalogs (+ Publish skills) or from a side-panel row's ⋯; there is no
 * Skills tab any more, because a list of skills to publish lives where you publish.
 */

import type { InstallMachine } from '../shared/shared-item-sheet.tsx';
import type { DaemonConnection } from '../../lib/machine.ts';
import { daemonSharingPath, SHARING_TABS, type SharingTab } from '../../lib/routes.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import { PageThemeSwitch, UnderlineTabs } from '@ferretry/app/ui';
import { CatalogMembersPanel } from '../catalogs/catalog-members.tsx';
import { FailureLine, SharingOffPanel } from '../catalogs/catalog-parts.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import { AddCatalogEntry } from '../catalogs/catalog-row-tools.tsx';
import { CatalogsSurface, useCatalogs } from '../catalogs/catalogs-surface.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { SharedWithMe } from '../shared/shared-with-me.tsx';
import type { MachineSkillEntriesLoader } from '../../lib/machine-skills.ts';
import type { SharedController } from '../shared/shared-controller.ts';

export const DEFAULT_SHARING_TAB: SharingTab = 'shared';

const TAB_LABELS: Readonly<Record<SharingTab, string>> = {
  shared: 'Subscriptions',
  catalogs: 'My catalogs',
  people: 'People',
};

const TABS = SHARING_TABS.map(id => ({ id, label: TAB_LABELS[id] }));

const GUTTER_CLASS = 'px-4 sm:px-5';
const COLUMN_CLASS = 'w-full max-w-[680px]';

type SharedPort = Pick<
  SharedController,
  'list' | 'browse' | 'unlock' | 'openItem' | 'versions' | 'openVersion' | 'leave' | 'forget' | 'rename' | 'tryAgain'
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
  /** Reads the skills on this machine for My catalogs' Publish skills picker. */
  readonly loadMachineSkills?: MachineSkillEntriesLoader;
}

export function SharingPage({
  connection,
  tab,
  onNavigate,
  members,
  machines,
  createClient,
  installHost,
  loadMachineSkills,
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
      <div className={`min-h-0 flex-1 overflow-y-auto scroll-thin py-3 ${GUTTER_CLASS}`} data-sharing-body="">
        <div className={COLUMN_CLASS}>
          {current === 'catalogs' ? (
            <CatalogsSurface
              connection={connection}
              {...(createClient === undefined ? {} : { createClient })}
              {...(loadMachineSkills === undefined ? {} : { loadMachineSkills })}
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
    </div>
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

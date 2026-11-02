/**
 * The right side of a store row once a paired machine holds the item (&B131 B4): the installed version, whether the
 * publisher offers a newer one, and See changes / Update / Stay / Skip / Move to version. Nothing here runs on its own:
 * Stay and Skip write a choice about future versions and touch no file, and every move to a version goes through the
 * update sheet and its passkey.
 */

import { revealHidden, type SharedCatalogManifestEntry, type SignedCatalogItemVersions } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { installRefusal } from '../catalogs/catalog-install-model.ts';
import { setCatalogInstallPrefs } from '../catalogs/catalog-installs-api.ts';
import { CatalogSheet, FailureLine } from '../catalogs/catalog-parts.tsx';
import { MarkedText } from '../catalogs/catalog-review-view.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import type { SharedCatalogView, SharedController } from './shared-controller.ts';
import type { InstalledItem } from './shared-installs.ts';
import {
  actLabel,
  askAgainPrefs,
  MOVE,
  type MoveLine,
  moveLines,
  NO_OTHER_VERSIONS,
  type RowAct,
  rowStatus,
  updateVerb,
  VERSIONS_LOADING,
} from './store-row-model.ts';
import { UpdateInstallSheet, type UpdatePort } from './update-install-sheet.tsx';

type StoreRowPort = Pick<SharedController, 'versions'> & UpdatePort;

interface Opened {
  readonly version: number;
  readonly signedVersions?: SignedCatalogItemVersions;
  readonly startAt: 'changes' | 'update';
}

export interface InstalledControlsProps {
  readonly members: StoreRowPort;
  readonly sub: MemberSubscription;
  readonly view: SharedCatalogView;
  readonly entry: SharedCatalogManifestEntry;
  readonly installed: InstalledItem;
  readonly installHost?: InstallHost;
  readonly onRefused: () => void;
  /** The machine's install records changed: read them again. */
  readonly onChanged: () => void;
}

export function InstalledControls({
  members,
  sub,
  view,
  entry,
  installed,
  installHost,
  onRefused,
  onChanged,
}: InstalledControlsProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = installHost?.createClient ?? routed;
  const status = rowStatus(installed, entry.version);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { install, machine } = installed;

  const choose = async (prefs: Parameters<typeof setCatalogInstallPrefs>[3]): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await setCatalogInstallPrefs(
        await createClient(machine.connection),
        install.target.scope,
        install.installId,
        prefs,
      );
      onChanged();
    } catch (error) {
      setFailure(installRefusal(error).sentence);
    } finally {
      setBusy(false);
    }
  };

  const run = (act: RowAct): void => {
    switch (act) {
      case 'changes':
        setOpened({ version: entry.version, startAt: 'changes' });
        return;
      case 'update':
        setOpened({ version: entry.version, startAt: 'update' });
        return;
      case 'move':
        setMoving(true);
        return;
      case 'stay':
        void choose({ hold: true });
        return;
      case 'skip':
        void choose({ skippedVersion: entry.version });
        return;
      case 'again':
        void choose(askAgainPrefs(install));
        return;
    }
  };

  return (
    <>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-xs" data-shared-item-status={status.kind}>
        <span
          className="fy-info-chip shrink-0"
          data-tone={status.kind === 'update' ? 'warn' : 'accent'}
          data-shared-item-installed=""
        >
          {status.text}
        </span>
        {status.acts.map(act => (
          <Button
            key={act}
            type="button"
            size="sm"
            variant={act === 'update' ? 'primary' : 'outline'}
            className="min-h-[44px] shrink-0"
            disabled={busy}
            onClick={() => run(act)}
            data-shared-item-act={act}
          >
            {actLabel(act, installed.version)}
          </Button>
        ))}
      </div>
      {failure === null ? null : <FailureLine sentence={failure} />}
      {moving ? (
        <MoveSheet
          members={members}
          sub={sub}
          view={view}
          entry={entry}
          installed={installed}
          onRefused={onRefused}
          onClose={() => setMoving(false)}
          onPick={(line, signedVersions) => {
            setMoving(false);
            setOpened({ version: line.version, signedVersions, startAt: 'update' });
          }}
        />
      ) : null}
      {opened === null ? null : (
        <UpdateInstallSheet
          members={members}
          sub={sub}
          view={view}
          entry={entry}
          installed={installed}
          version={opened.version}
          {...(opened.signedVersions === undefined ? {} : { signedVersions: opened.signedVersions })}
          verb={updateVerb(opened.version, entry.version, installed.version)}
          startAt={opened.startAt}
          {...(installHost === undefined ? {} : { installHost })}
          onRefused={onRefused}
          onClose={() => setOpened(null)}
          onDone={() => {
            setOpened(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

type Listed =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly sentence: string }
  | { readonly state: 'ok'; readonly signed: SignedCatalogItemVersions };

function MoveSheet({
  members,
  sub,
  view,
  entry,
  installed,
  onRefused,
  onClose,
  onPick,
}: {
  readonly members: Pick<SharedController, 'versions'>;
  readonly sub: MemberSubscription;
  readonly view: SharedCatalogView;
  readonly entry: SharedCatalogManifestEntry;
  readonly installed: InstalledItem;
  readonly onRefused: () => void;
  readonly onClose: () => void;
  readonly onPick: (line: MoveLine, signedVersions: SignedCatalogItemVersions) => void;
}) {
  const [listed, setListed] = useState<Listed>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void members.versions(sub, view, entry.itemId).then(attempt => {
      if (!live) return;
      if (attempt.kind === 'refused') onRefused();
      else if (attempt.kind === 'failed') setListed({ state: 'failed', sentence: attempt.problem.sentence });
      else setListed({ state: 'ok', signed: attempt.value });
    });
    return () => {
      live = false;
    };
  }, [members, sub, view, entry.itemId, onRefused]);

  const name = revealHidden(installed.name);
  const lines = listed.state === 'ok' ? moveLines(listed.signed.versions, installed.version) : [];
  const others = lines.filter(line => line.direction !== 'installed');
  return (
    <CatalogSheet
      name="move-version"
      title={MOVE}
      subtitle={`${name} · now v${String(installed.version)} on ${installed.machine.name}`}
      closeLabel={`Close ${MOVE}`}
      onClose={onClose}
    >
      {listed.state === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status" data-move-loading="">
          {VERSIONS_LOADING}
        </p>
      ) : null}
      {listed.state === 'failed' ? <FailureLine sentence={listed.sentence} /> : null}
      {listed.state === 'ok' && others.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-move-none="">
          {NO_OTHER_VERSIONS}
        </p>
      ) : null}
      {listed.state === 'ok' && others.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Versions on offer">
          {lines.map(line => (
            <li key={line.version} className="min-w-0">
              <button
                type="button"
                className="kt-panel flex min-h-[44px] w-full min-w-0 flex-col items-start justify-center gap-0.5 px-control-x py-1 text-left focus-visible:outline-focus focus-visible:outline-offset-focus disabled:opacity-60"
                disabled={line.direction === 'installed'}
                onClick={() => onPick(line, listed.signed)}
                data-move-version={line.version}
                data-move-direction={line.direction}
              >
                <span className="break-words text-cell font-semibold text-fg">{line.text}</span>
                <span className="break-words text-meta text-muted">
                  <MarkedText text={line.summary} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </CatalogSheet>
  );
}

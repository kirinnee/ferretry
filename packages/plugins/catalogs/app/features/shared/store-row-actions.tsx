/**
 * The right side of a store row once a paired machine holds the item (&B131 B4): the installed version, whether the
 * publisher offers a newer one, Update and See changes, and one More menu (Stay, Skip, Move to version). Nothing
 * here runs on its own: Stay and Skip write a choice about future versions and touch no file, and every move to a
 * version goes through the update sheet and its passkey.
 */

import {
  revealHidden,
  type SharedCatalogManifestEntry,
  type SignedCatalogItemVersions,
} from '../../../contract/wire/index.ts';
import { CircleCheck, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useInputModality } from '@ferretry/app/ui';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import { ContextMenu, type MenuAnchor } from '@ferretry/app/ui';
import { Button } from '@ferretry/app/ui';
import { installRefusal } from '../catalogs/catalog-install-model.ts';
import { setCatalogInstallPrefs } from '../catalogs/catalog-installs-api.ts';
import { CatalogSheet, FailureLine } from '../catalogs/catalog-parts.tsx';
import { MarkedText } from '../catalogs/catalog-review-view.tsx';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import type { SharedCatalogView, SharedController } from './shared-controller.ts';
import type { InstalledItem } from './shared-installs.ts';
import {
  actHint,
  actLabel,
  askAgainPrefs,
  MORE,
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
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const { touchAffected } = useInputModality();
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
          className="fy-info-chip max-w-full"
          data-tone={status.kind === 'update' ? 'warn' : 'accent'}
          data-shared-item-installed=""
        >
          {status.text}
        </span>
        {status.buttons.map(act => (
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
        {status.menu.length === 0 ? null : (
          <>
            <Button
              ref={moreRef}
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-[44px] shrink-0"
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={anchor !== null}
              aria-label={MORE}
              onClick={() => {
                const rect = moreRef.current?.getBoundingClientRect();
                setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
              }}
              data-shared-item-more=""
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </Button>
            <ContextMenu
              open={anchor !== null}
              anchor={anchor ?? { x: 0, y: 0 }}
              ariaLabel={`${MORE} for ${revealHidden(installed.name)}`}
              triggerRef={moreRef}
              touch={touchAffected}
              onClose={() => setAnchor(null)}
              items={status.menu.map(act => ({
                key: act,
                label: actLabel(act, installed.version),
                hint: actHint(act, installed.version, entry.version),
                onSelect: () => run(act),
              }))}
            />
          </>
        )}
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
                className="kt-panel flex min-h-[44px] w-full min-w-0 flex-col items-start justify-center gap-0.5 px-control-x py-1 text-left focus-visible:outline-focus focus-visible:outline-offset-focus disabled:cursor-default disabled:opacity-100"
                disabled={line.direction === 'installed'}
                {...(line.direction === 'installed' ? { 'aria-current': true } : {})}
                onClick={() => onPick(line, listed.signed)}
                data-move-version={line.version}
                data-move-direction={line.direction}
              >
                <span className="flex min-w-0 items-start gap-1.5 break-words text-cell font-semibold text-fg">
                  {line.direction === 'installed' ? (
                    <CircleCheck
                      size={16}
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-ok"
                      data-move-installed-mark=""
                    />
                  ) : null}
                  <span>{line.text}</span>
                </span>
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

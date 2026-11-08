/**
 * Update an install, or move it to another version the publisher offers (&B131 B4).
 *
 * The version is fetched from the publisher and checked here, then handed to the machine that holds the install. THE
 * MACHINE ANSWERS what changes and the app shows it; the one button that writes asks for a fresh passkey, and nothing
 * here runs without the person's tap. A local edit offers Keep my edits (nothing changes) or Replace my edits.
 */

import {
  type CatalogInstalled,
  type CatalogInstallPreview,
  revealHidden,
  type SharedCatalogManifestEntry,
  type SignedCatalogItemVersions,
} from '../../../contract/wire/index.ts';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@ferretry/app/ui';
import {
  type BindingPicks,
  type InstallRefusal,
  installRefusal,
  installRequest,
  installState,
  NO_AUTO_UPDATE,
  pickBinding,
  unpickBinding,
} from '../catalogs/catalog-install-model.ts';
import { applyCatalogInstall, previewCatalogInstall } from '../catalogs/catalog-installs-api.ts';
import { CatalogSheet, FailureLine } from '../catalogs/catalog-parts.tsx';
import { MarkedText } from '../catalogs/catalog-review-view.tsx';
import { ChangesView } from '../catalogs/changes-view.tsx';
import { Confirm, type InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import { changesSummary } from '../catalogs/versions-model.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import { listSecrets, type SecretList } from '../../lib/secrets.ts';
import type { MemberSubscription } from '../../lib/member-keys.ts';
import type { SharedCatalogView, SharedController, UpdateSource } from './shared-controller.ts';
import type { InstalledItem } from './shared-installs.ts';
import {
  busyLabel,
  confirmLabel,
  DONE_UPDATING,
  editedBanner,
  editedChoice,
  KEEP_MY_EDITS,
  moveSubtitle,
  NO_COMPARISON,
  plainRefusal,
  READING_VERSION,
  REPLACE_MY_EDITS,
  type UpdateVerb,
  updateDisagreement,
  updateRequest,
} from './store-row-model.ts';

export type UpdatePort = Pick<SharedController, 'openVersion'>;

export interface UpdateInstallSheetProps {
  readonly members: UpdatePort;
  readonly sub: MemberSubscription;
  readonly view: SharedCatalogView;
  readonly entry: SharedCatalogManifestEntry;
  readonly installed: InstalledItem;
  /** The version to take over the installed one. */
  readonly version: number;
  /** The publisher's signed list, when `version` is not the one the manifest lists. */
  readonly signedVersions?: SignedCatalogItemVersions;
  readonly verb: UpdateVerb;
  /** `changes` opens on the diff alone; `update` on the review and the passkey button. */
  readonly startAt: 'changes' | 'update';
  readonly installHost?: InstallHost;
  readonly onRefused: () => void;
  readonly onClose: () => void;
  /** The install changed: read the machine's records again. */
  readonly onDone: () => void;
}

function UpdateLanded({ landed, onDone }: { readonly landed: CatalogInstalled; readonly onDone: () => void }) {
  return (
    <CatalogSheet name="update" title="Installed" closeLabel="Close Installed" onClose={onDone}>
      <section className="flex min-w-0 flex-col gap-xs" role="status" data-catalog-installed="">
        <p className="m-0 flex items-start gap-2 break-words text-cell font-semibold text-ok">
          <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {revealHidden(landed.install.provenance.name)} · version {landed.install.provenance.version}
        </p>
        <p className="m-0 break-all text-cell text-fg" data-catalog-destination="">
          Put into {landed.install.destination}
        </p>
        {landed.notes.map(note => (
          <p key={note} className="m-0 break-words text-cell text-muted" data-catalog-note="">
            <MarkedText text={note} />
          </p>
        ))}
        <p className="m-0 text-cell text-muted">{NO_AUTO_UPDATE}</p>
        <Button type="button" onClick={onDone} data-catalog-done="">
          {DONE_UPDATING}
        </Button>
      </section>
    </CatalogSheet>
  );
}

function EditedChoice({
  banner,
  version,
  busy,
  onKeep,
  onReplace,
}: {
  readonly banner: string;
  readonly version: number;
  readonly busy: boolean;
  readonly onKeep: () => void;
  readonly onReplace: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-col items-start gap-xs" data-update-edited="">
      <p
        className="m-0 flex w-full items-start gap-2 break-words rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-cell text-fg"
        role="status"
        data-update-edited-banner=""
      >
        <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
        <span>{banner}</span>
      </p>
      <p className="m-0 break-words text-cell text-muted">{editedChoice(version)}</p>
      <div className="flex flex-wrap gap-xs">
        <Button type="button" className="min-h-[44px]" disabled={busy} onClick={onKeep} data-update-keep="">
          {KEEP_MY_EDITS}
        </Button>
        <Button type="button" className="min-h-[44px]" disabled={busy} onClick={onReplace} data-update-replace="">
          {REPLACE_MY_EDITS}
        </Button>
      </div>
    </section>
  );
}

export function UpdateInstallSheet({
  members,
  sub,
  view,
  entry,
  installed,
  version,
  signedVersions,
  verb,
  startAt,
  installHost,
  onRefused,
  onClose,
  onDone,
}: UpdateInstallSheetProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = installHost?.createClient ?? routed;
  const { install, machine } = installed;
  const [source, setSource] = useState<UpdateSource | null>(null);
  const [screen, setScreen] = useState<'changes' | 'update'>(startAt);
  const [preview, setPreview] = useState<CatalogInstallPreview | null>(null);
  const [picks, setPicks] = useState<BindingPicks>({});
  const [secrets, setSecrets] = useState<SecretList | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InstallRefusal | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [landed, setLanded] = useState<CatalogInstalled | null>(null);
  // Counts the previews asked for. An answer is kept only if nothing it was asked about has changed since.
  const asked = useRef(0);
  const started = useRef(false);

  const ask = async (opened: UpdateSource, replace: boolean): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    setBusy(true);
    setFailure(null);
    setPicks({});
    try {
      const client = await createClient(machine.connection);
      const read = await previewCatalogInstall(
        client,
        install.target.scope,
        updateRequest(opened, install, { replaceEdited: replace }),
      );
      if (mine !== asked.current) return;
      const disagreement = updateDisagreement(opened, install, read);
      if (disagreement !== null) {
        setPreview(null);
        setFailure(plainRefusal(disagreement));
        return;
      }
      setPreview(read);
      setSecrets(undefined);
      if (read.secrets.length > 0)
        void listSecrets(client)
          .then(list => {
            if (mine === asked.current) setSecrets(list);
          })
          .catch(() => {
            if (mine === asked.current) setSecrets(null);
          });
    } catch (error) {
      if (mine !== asked.current) return;
      setPreview(null);
      setFailure(installRefusal(error));
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      setBusy(true);
      const attempt = await members.openVersion(sub, view, entry, version, signedVersions);
      if (attempt.kind === 'refused') {
        onRefused();
        return;
      }
      if (attempt.kind === 'failed') {
        setBusy(false);
        setFailure(plainRefusal(attempt.problem.sentence));
        return;
      }
      setSource(attempt.value);
      await ask(attempt.value, false);
    })();
  });

  const apply = async (): Promise<void> => {
    if (preview === null) return;
    const request = installRequest(preview, picks);
    if (request === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = await createClient(machine.connection);
      setLanded(await applyCatalogInstall(client, preview.target.scope, request));
    } catch (error) {
      setFailure(installRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  if (landed !== null) return <UpdateLanded landed={landed} onDone={onDone} />;

  const name = revealHidden(installed.name);
  const state = installState(preview, picks, busy);
  const paths = preview?.edited?.paths ?? [];
  return (
    <CatalogSheet
      name="update"
      title={screen === 'changes' ? `What changes in ${name}` : `${verb} ${name}`}
      subtitle={moveSubtitle(installed.version, version, machine.name)}
      closeLabel={`Close ${name}`}
      onClose={onClose}
    >
      {busy && preview === null && failure === null ? (
        <p className="m-0 text-cell text-muted" role="status" data-update-reading="">
          {READING_VERSION}
        </p>
      ) : null}
      {failure === null ? null : (
        <div className="flex min-w-0 flex-col items-start gap-xs">
          {failure.editedOffered && source !== null ? null : (
            <FailureLine
              sentence={failure.sentence}
              {...(failure.previewAgain && source !== null
                ? { again: true, onAgain: () => void ask(source, replacing) }
                : {})}
            />
          )}
          {failure.editedOffered && source !== null ? (
            <EditedChoice
              banner={editedBanner(failure.sentence)}
              version={version}
              busy={busy}
              onKeep={onClose}
              onReplace={() => {
                setReplacing(true);
                void ask(source, true);
              }}
            />
          ) : null}
        </div>
      )}
      {preview === null ? null : screen === 'changes' ? (
        <ChangesScreen preview={preview} verb={verb} onUpdate={() => setScreen('update')} />
      ) : (
        <>
          {preview.changes === undefined ? null : (
            <p className="m-0 text-cell text-muted" data-update-summary="">
              {changesSummary(preview.changes)}
            </p>
          )}
          {paths.length === 0 ? null : (
            <p className="m-0 break-all font-mono text-meta text-muted" data-update-edited-paths="">
              You changed: {paths.join(', ')}
            </p>
          )}
          <Confirm
            preview={preview}
            picks={picks}
            secrets={secrets}
            onPick={(placeholder, choice) =>
              setPicks(current =>
                choice === undefined ? unpickBinding(current, placeholder) : pickBinding(current, placeholder, choice),
              )
            }
            state={state}
            busy={busy}
            onInstall={() => void apply()}
            label={confirmLabel(verb)}
            busyLabel={busyLabel(verb)}
          />
        </>
      )}
    </CatalogSheet>
  );
}

function ChangesScreen({
  preview,
  verb,
  onUpdate,
}: {
  readonly preview: CatalogInstallPreview;
  readonly verb: UpdateVerb;
  readonly onUpdate: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-sm" data-update-changes="">
      {preview.changes === undefined ? (
        <p className="m-0 text-cell text-muted" data-update-no-comparison="">
          {NO_COMPARISON}
        </p>
      ) : (
        <ChangesView changes={preview.changes} />
      )}
      <Button type="button" variant="primary" className="min-h-[44px]" onClick={onUpdate} data-update-go="">
        {verb}
      </Button>
    </section>
  );
}

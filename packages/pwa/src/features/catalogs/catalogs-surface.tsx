/**
 * Settings › machine › Catalogs: the catalogs this machine publishes, what is in each, and the acts on them.
 *
 * Calm and plain. The list shows names and counts; one catalog shows its items with their versions, says
 * when a source changed since it was frozen, and offers Publish update, Withdraw, Rename, Delete and
 * Export file. Where this device may not use Sharing, the panel says so and how to turn it on, instead of
 * showing buttons that would fail.
 */

import type { OwnedCatalog, OwnedCatalogItem } from '@ferretry/protocol';
import { CircleAlert, CircleCheck, FileDown, FileUp, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { downloadText, type SaveText } from '../settings/performance-settings.tsx';
import { AddToCatalogSheet } from './add-to-catalog-sheet.tsx';
import { formatBytes, plural, shortDigest } from './catalog-review-model.ts';
import { FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import {
  type CatalogClientFactory,
  deleteCatalog,
  exportCatalog,
  listCatalogs,
  updateCatalog,
  withdrawCatalogItem,
} from './catalogs-api.ts';
import {
  CATALOG_NOT_SHARED_YET,
  catalogSummary,
  EXPORT_NOTE,
  exportFileName,
  itemState,
  latestVersion,
  type OwnerRefusal,
  ownerRefusal,
  PUBLISH_COPY_NOTE,
} from './catalogs-model.ts';
import { InstallFromFileSheet, type InstallHost } from './install-from-file-sheet.tsx';

export interface CatalogsSurfaceProps {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
  readonly saveFile?: SaveText;
  /** Test and harness seam for the install sheet; the app uses the daemon-bound client and the known projects. */
  readonly installHost?: InstallHost;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalogs: readonly OwnedCatalog[] }
  | { readonly kind: 'failed'; readonly refusal: OwnerRefusal };

/** Reads the catalogs, again whenever `reload` is called. Only the detail view asks for `sourceState`. */
function useCatalogs(
  connection: DaemonConnection,
  createClient: CatalogClientFactory,
  sourceState: boolean,
): { read: Read; reload: () => void } {
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // `tick` is the reload trigger: pressing Try again or finishing an act bumps it.
    void tick;
    void (async () => {
      try {
        const list = await listCatalogs(
          await createClient(connection),
          sourceState ? { sourceState: true } : undefined,
        );
        if (live) setRead({ kind: 'ready', catalogs: list.catalogs });
      } catch (error) {
        if (live) setRead({ kind: 'failed', refusal: ownerRefusal(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, createClient, sourceState, tick]);
  return { read, reload: useCallback(() => setTick(previous => previous + 1), []) };
}

export function CatalogsSurface({
  connection,
  createClient: injected,
  saveFile = downloadText,
  installHost,
}: CatalogsSurfaceProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = injected ?? routed;
  const [openId, setOpenId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const detail = openId !== null;
  const { read, reload } = useCatalogs(connection, createClient, detail);

  return (
    <section className="flex min-w-0 flex-col gap-sm" aria-label="Catalogs" data-catalogs-surface="">
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 text-row font-semibold text-fg">Catalogs</h3>
        <p className="m-0 text-cell text-muted">{CATALOG_NOT_SHARED_YET}</p>
      </header>
      {read.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading catalogs…
        </p>
      ) : read.kind === 'failed' ? (
        read.refusal.sharingOff ? (
          <SharingOffPanel />
        ) : (
          <FailureLine sentence={read.refusal.sentence} again onAgain={reload} againLabel="Try again" />
        )
      ) : openId === null ? (
        <CatalogList catalogs={read.catalogs} onOpen={setOpenId} />
      ) : (
        <CatalogDetail
          connection={connection}
          createClient={createClient}
          catalog={read.catalogs.find(candidate => candidate.id === openId)}
          saveFile={saveFile}
          onBack={() => setOpenId(null)}
          onChanged={reload}
          onDeleted={() => {
            setOpenId(null);
            reload();
          }}
        />
      )}
      {read.kind === 'failed' && read.refusal.sharingOff ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <Button type="button" onClick={() => setInstalling(true)} data-catalogs-install-from-file="">
            <FileUp size={16} aria-hidden="true" />
            Install from a file…
          </Button>
        </div>
      )}
      {installing ? (
        <InstallFromFileSheet
          connection={connection}
          onClose={() => setInstalling(false)}
          {...(installHost === undefined ? {} : { host: installHost })}
        />
      ) : null}
    </section>
  );
}

function CatalogList({
  catalogs,
  onOpen,
}: {
  readonly catalogs: readonly OwnedCatalog[];
  readonly onOpen: (id: string) => void;
}) {
  if (catalogs.length === 0)
    return (
      <p className="m-0 text-cell text-muted" data-catalogs-empty="">
        You have no catalogs yet. Open a skill or an MCP server and press Add to catalog.
      </p>
    );
  return (
    <ul className="kt-groupcard m-0 list-none p-0" aria-label="Your catalogs" data-catalogs-list="">
      {catalogs.map(catalog => (
        <li key={catalog.id}>
          <button
            type="button"
            className="kt-grouprow"
            onClick={() => onOpen(catalog.id)}
            data-catalog-open={catalog.name}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="break-words text-ui font-semibold text-fg">{catalog.name}</span>
              <span className="text-meta leading-tight text-muted">{catalogSummary(catalog)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function CatalogDetail({
  connection,
  createClient,
  catalog,
  saveFile,
  onBack,
  onChanged,
  onDeleted,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: CatalogClientFactory;
  readonly catalog: OwnedCatalog | undefined;
  readonly saveFile: SaveText;
  readonly onBack: () => void;
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
}) {
  const [failure, setFailure] = useState<OwnerRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | { readonly withdraw: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [publishing, setPublishing] = useState<OwnedCatalogItem | null>(null);

  const act = async (work: (catalogId: string) => Promise<void>): Promise<void> => {
    if (catalog === undefined) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      await work(catalog.id);
    } catch (error) {
      setFailure(ownerRefusal(error));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (catalog === undefined)
    return (
      <div className="flex min-w-0 flex-col items-start gap-xs" data-catalog-gone="">
        <p className="m-0 text-cell text-muted">That catalog is gone. Go back to the list and look again.</p>
        <Button type="button" onClick={onBack}>
          Back to catalogs
        </Button>
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-sm" data-catalog-detail={catalog.name}>
      <div>
        <Button type="button" variant="ghost" className="kt-btn--flush-start" onClick={onBack} data-catalog-back="">
          Back to catalogs
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 className="m-0 break-words text-row font-semibold text-fg">{catalog.name}</h4>
        <p className="m-0 text-meta text-muted">
          {catalogSummary(catalog)} · signed as {catalog.publisherName}
        </p>
        {catalog.description === '' ? null : (
          <p className="m-0 whitespace-pre-wrap break-words text-cell text-muted">{catalog.description}</p>
        )}
      </div>
      {failure === null ? null : failure.sharingOff ? <SharingOffPanel /> : <FailureLine sentence={failure.sentence} />}
      {note === null ? null : (
        <p className="m-0 flex items-start gap-2 break-words text-cell text-ok" role="status" data-catalog-note="">
          <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {note}
        </p>
      )}
      {editing ? (
        <RenameForm
          catalog={catalog}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={change =>
            void act(async id => {
              await updateCatalog(await createClient(connection), id, change);
              setEditing(false);
              onChanged();
            })
          }
        />
      ) : (
        <div className="flex min-w-0 flex-wrap gap-xs">
          <Button type="button" size="sm" disabled={busy} onClick={() => setEditing(true)} data-catalog-rename="">
            Rename or describe
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(async id => {
                const file = await exportCatalog(await createClient(connection), id);
                const fileName = exportFileName(catalog.name);
                saveFile(fileName, JSON.stringify(file));
                setNote(`Saved ${fileName}. ${EXPORT_NOTE}`);
              })
            }
            data-catalog-export=""
          >
            <FileDown size={16} aria-hidden="true" />
            Export file
          </Button>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Items" data-catalog-items="">
        {catalog.items.map(item => (
          <ItemRow
            key={item.itemId}
            item={item}
            busy={busy}
            confirming={typeof confirm === 'object' && confirm !== null && confirm.withdraw === item.itemId}
            onPublish={() => setPublishing(item)}
            onAskWithdraw={() => setConfirm({ withdraw: item.itemId })}
            onCancel={() => setConfirm(null)}
            onWithdraw={() =>
              void act(async id => {
                await withdrawCatalogItem(await createClient(connection), id, item.itemId);
                onChanged();
              })
            }
          />
        ))}
      </ul>
      {confirm === 'delete' ? (
        <section
          className="flex min-w-0 flex-col gap-xs rounded-control border border-err-border bg-err-bg p-control-x py-2 text-err"
          role="alertdialog"
          aria-label="Delete this catalog"
          data-catalog-delete-confirm=""
        >
          <p className="m-0 break-words text-cell font-semibold">Delete “{catalog.name}”?</p>
          <p className="m-0 text-cell">
            The catalog and its frozen copies are removed from this machine. People who already installed from it keep
            what they have. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-xs">
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(async id => {
                  await deleteCatalog(await createClient(connection), id);
                  onDeleted();
                })
              }
              data-catalog-delete-yes=""
            >
              Delete catalog
            </Button>
            <Button type="button" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
          </div>
        </section>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => setConfirm('delete')}
            data-catalog-delete=""
          >
            <Trash2 size={16} aria-hidden="true" />
            Delete catalog…
          </Button>
        </div>
      )}
      {publishing === null ? null : (
        <AddToCatalogSheet
          connection={connection}
          createClient={createClient}
          source={
            publishing.source.kind === 'skill'
              ? { kind: 'skill', skill: publishing.source.path }
              : { kind: 'mcp', mcp: publishing.source.id }
          }
          label={publishing.name}
          publish={{ catalogId: catalog.id, itemId: publishing.itemId }}
          onClose={() => setPublishing(null)}
          onDone={onChanged}
        />
      )}
    </div>
  );
}

function RenameForm({
  catalog,
  busy,
  onCancel,
  onSave,
}: {
  readonly catalog: OwnedCatalog;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (change: { name?: string; description?: string }) => void;
}) {
  const [name, setName] = useState(catalog.name);
  const [description, setDescription] = useState(catalog.description);
  const nameId = useId();
  const descriptionId = useId();
  const changed = name.trim() !== catalog.name || description !== catalog.description;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave({
      ...(name.trim() === catalog.name ? {} : { name: name.trim() }),
      ...(description === catalog.description ? {} : { description }),
    });
  };
  return (
    <form className="flex min-w-0 flex-col gap-sm" onSubmit={submit} data-catalog-rename-form="">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={nameId} className="text-meta font-semibold text-muted">
          Name
        </label>
        <input
          id={nameId}
          className="kt-input"
          value={name}
          maxLength={80}
          onChange={event => setName(event.target.value)}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={descriptionId} className="text-meta font-semibold text-muted">
          Description
        </label>
        <textarea
          id={descriptionId}
          className="kt-input"
          rows={3}
          value={description}
          maxLength={2000}
          onChange={event => setDescription(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-xs">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !changed || name.trim() === ''}
          data-catalog-rename-save=""
        >
          Save
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ItemRow({
  item,
  busy,
  confirming,
  onPublish,
  onAskWithdraw,
  onCancel,
  onWithdraw,
}: {
  readonly item: OwnedCatalogItem;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onPublish: () => void;
  readonly onAskWithdraw: () => void;
  readonly onCancel: () => void;
  readonly onWithdraw: () => void;
}) {
  const state = itemState(item);
  const withdrawn = item.withdrawnAt !== undefined;
  return (
    <li
      className={cn('kt-panel flex min-w-0 flex-col gap-xs p-control-x py-2', withdrawn && 'opacity-70')}
      data-catalog-item={item.name}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="min-w-0 flex-1 break-all font-mono text-cell text-fg">{item.name}</span>
        <span className="fy-info-chip" data-tone="muted">
          {item.kind === 'skill' ? 'Skill' : 'MCP server'}
        </span>
        <span className="text-meta text-faint">Version {latestVersion(item)}</span>
      </div>
      <p className="m-0 break-words text-meta text-muted">{item.summary}</p>
      {state === null ? null : (
        <p
          className={cn(
            'm-0 flex items-start gap-1 text-meta',
            state.tone === 'caution' ? 'text-warn' : state.tone === 'ok' ? 'text-ok' : 'text-muted',
          )}
          data-catalog-item-state={state.label}
        >
          {state.tone === 'caution' ? <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : null}
          <span className="break-words">
            {state.label}
            {state.detail === null ? '' : `: ${state.detail}`}
          </span>
        </p>
      )}
      <details className="text-meta text-muted">
        <summary className="cursor-pointer select-none">{plural(item.versions.length, 'version')}</summary>
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
          {item.versions.map(version => (
            <li key={version.version} className="break-all" data-catalog-version={version.version}>
              Version {version.version} · {shortDigest(version.digest)} · {formatBytes(version.size)}
            </li>
          ))}
        </ul>
      </details>
      {state?.canPublish === true ? (
        <div className="flex min-w-0 flex-col items-start gap-xs">
          <p className="m-0 text-meta text-muted">{PUBLISH_COPY_NOTE}</p>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={onPublish}
            data-catalog-publish={item.name}
          >
            Source changed — Publish update
          </Button>
        </div>
      ) : null}
      {withdrawn ? null : confirming ? (
        <div
          className="flex min-w-0 flex-col items-start gap-xs"
          role="alertdialog"
          aria-label={`Withdraw ${item.name}`}
        >
          <p className="m-0 break-words text-cell text-fg">
            Withdraw {item.name}? It is no longer offered. People who already have it keep it.
          </p>
          <div className="flex flex-wrap gap-xs">
            <Button type="button" variant="danger" disabled={busy} onClick={onWithdraw} data-catalog-withdraw-yes="">
              Withdraw
            </Button>
            <Button type="button" onClick={onCancel}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" size="sm" disabled={busy} onClick={onAskWithdraw} data-catalog-withdraw={item.name}>
            Withdraw…
          </Button>
        </div>
      )}
    </li>
  );
}

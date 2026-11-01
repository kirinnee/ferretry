/**
 * "Add to catalog…" on a skill or an MCP server, and "Publish update" on a catalog item.
 *
 * The person picks a catalog (or names a new one), presses Preview, reads everything that would be shared,
 * and only then presses Add. Add is bound to the digest of the preview they read: if the source changed
 * since, the daemon refuses and the next step is Preview again.
 */

import {
  type CatalogItemSource,
  type OwnedCatalog,
  type PublishedCatalogItem,
  revealHidden,
  type SharedItemPreview,
} from '@ferretry/protocol';
import { Share2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { formatBytes, plural } from './catalog-review-model.ts';
import { MarkedText, ReviewBody, WarningList } from './catalog-review-view.tsx';
import { CatalogSheet, FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import {
  addCatalogItem,
  addExistingItem,
  type CatalogClient,
  type CatalogClientFactory,
  createCatalog,
  listCatalogs,
  makeDefault,
  previewCatalogItem,
  publishCatalogVersion,
} from './catalogs-api.ts';
import {
  addState,
  type CatalogChoice,
  choiceProblem,
  FROZEN_COPY_NOTE,
  type OwnerRefusal,
  ownerRefusal,
  previewButtonLabel,
  previewPlan,
} from './catalogs-model.ts';

/** Which catalog item gets a new version, when this is "Publish update" rather than a first add. */
interface PublishTarget {
  readonly catalogId: string;
  readonly itemId: string;
}

/** An item this machine already shares, going into one more catalog at the version the person reviews. */
interface ExistingItem {
  readonly itemId: string;
  readonly version: number;
  /** Catalogs that already list it live; they are not offered. */
  readonly listedIn: readonly string[];
}

export interface AddToCatalogSheetProps {
  readonly connection: DaemonConnection;
  /** Where the source is: a SKILL.md path or skill name, or an MCP server id. */
  readonly source: CatalogItemSource;
  /** The skill or server name, as the row says it. */
  readonly label: string;
  readonly onClose: () => void;
  /** Called after an add or a publish landed, so a list can read again. */
  readonly onDone?: () => void;
  readonly publish?: PublishTarget;
  /** Open on this review already (a one-tap Add that stopped for it). Changing the catalog keeps it. */
  readonly initial?: SharedItemPreview;
  /** One sentence above the review: why the tap stopped, or what refused it. */
  readonly notice?: string;
  /** The catalog to preselect, when the machine has a default. */
  readonly preferCatalogId?: string;
  /** With no default yet: the name of the new catalog the sheet offers, which becomes the default. */
  readonly suggestNewName?: string;
  /** Make a catalog this sheet creates the default. */
  readonly asDefault?: boolean;
  /** "Add to another catalog…": add-existing, not a first add from a source. */
  readonly existing?: ExistingItem;
  /** When given, the last step offers "Share it now" and calls this with the catalog the item landed in. */
  readonly onShareNow?: (catalogId: string) => void;
  /** Test and harness seam; the app uses the daemon-bound client. */
  readonly createClient?: CatalogClientFactory;
}

const NOT_LISTED: readonly string[] = [];

type CatalogsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalogs: readonly OwnedCatalog[] }
  | { readonly kind: 'failed'; readonly refusal: OwnerRefusal };

type Landed = {
  readonly catalogId: string;
  readonly catalogName: string;
  readonly published: PublishedCatalogItem;
};

export function AddToCatalogSheet({
  connection,
  source,
  label,
  onClose,
  onDone,
  publish,
  initial,
  notice,
  preferCatalogId,
  suggestNewName,
  asDefault = false,
  existing,
  onShareNow,
  createClient: injected,
}: AddToCatalogSheetProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = injected ?? routed;
  const [read, setRead] = useState<CatalogsRead>({ kind: 'loading' });
  const [choice, setChoice] = useState<CatalogChoice | null>(null);
  const [newName, setNewName] = useState('');
  const [preview, setPreview] = useState<SharedItemPreview | null>(initial ?? null);
  const [note, setNote] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OwnerRefusal | null>(null);
  const [landed, setLanded] = useState<Landed | null>(null);
  const autoPreviewed = useRef(false);
  const pickerId = useId();
  const nameId = useId();

  const listedIn = existing?.listedIn ?? NOT_LISTED;
  const readCatalogs = useCallback(async (): Promise<readonly OwnedCatalog[] | null> => {
    try {
      const list = await listCatalogs(await createClient(connection));
      setRead({ kind: 'ready', catalogs: list.catalogs });
      return list.catalogs;
    } catch (error) {
      setRead({ kind: 'failed', refusal: ownerRefusal(error) });
      return null;
    }
  }, [connection, createClient]);

  const start = useCallback(async (): Promise<void> => {
    const catalogs = await readCatalogs();
    if (catalogs === null) return;
    const eligible = catalogs.filter(catalog => !listedIn.includes(catalog.id));
    const preferred = eligible.find(catalog => catalog.id === preferCatalogId);
    if (publish !== undefined) setChoice({ kind: 'existing', catalogId: publish.catalogId });
    else if (preferred !== undefined) setChoice({ kind: 'existing', catalogId: preferred.id });
    else if (suggestNewName !== undefined) {
      setNewName(suggestNewName);
      setChoice({ kind: 'new', name: suggestNewName });
    } else if (eligible[0] !== undefined) setChoice({ kind: 'existing', catalogId: eligible[0].id });
    else setChoice({ kind: 'new', name: '' });
  }, [readCatalogs, publish, listedIn, preferCatalogId, suggestNewName]);

  useEffect(() => {
    void start();
  }, [start]);

  const catalogs = read.kind === 'ready' ? read.catalogs : [];
  const eligible = catalogs.filter(catalog => !listedIn.includes(catalog.id));
  const draft: CatalogChoice | null = choice?.kind === 'new' ? { kind: 'new', name: newName } : choice;
  const problem = publish === undefined ? choiceProblem(draft, catalogs) : null;

  const choose = (next: CatalogChoice): void => {
    setChoice(next);
    if (initial === undefined) setPreview(null);
    setFailure(null);
    setNote(null);
  };

  const runPreview = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (draft === null || (publish === undefined && problem !== null)) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const client: CatalogClient = await createClient(connection);
      let catalogId = publish?.catalogId;
      if (catalogId === undefined) {
        const plan = previewPlan(draft, eligible);
        if (plan.kind === 'make-first') {
          catalogId = (await createCatalog(client, plan.name)).id;
          await readCatalogs();
          setChoice({ kind: 'existing', catalogId });
        } else catalogId = plan.catalogId;
      }
      const itemId = publish?.itemId ?? existing?.itemId;
      setPreview(await previewCatalogItem(client, catalogId, itemId === undefined ? { source } : { itemId }));
    } catch (error) {
      setPreview(null);
      setFailure(ownerRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  /** The item moved on since it was read: show what it is now, with the sentence that says so. */
  const rereadExisting = async (catalogId: string, itemId: string, sentence: string): Promise<void> => {
    try {
      const client = await createClient(connection);
      setPreview(await previewCatalogItem(client, catalogId, { itemId }));
      setNote(sentence);
    } catch (error) {
      setPreview(null);
      setFailure(ownerRefusal(error));
    }
  };

  const add = async (): Promise<void> => {
    if (preview === null || draft === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = await createClient(connection);
      const known = publish?.catalogId ?? (draft.kind === 'existing' ? draft.catalogId : undefined);
      const made =
        known === undefined ? await createCatalog(client, draft.kind === 'new' ? draft.name.trim() : '') : null;
      const catalogId = made?.id ?? known ?? '';
      const catalogName = made?.name ?? catalogs.find(candidate => candidate.id === catalogId)?.name ?? '';
      const published =
        publish !== undefined
          ? await publishCatalogVersion(client, catalogId, publish.itemId, preview.digest)
          : existing !== undefined
            ? await addExistingItem(client, catalogId, existing.itemId, preview.version)
            : await addCatalogItem(client, catalogId, { source, digest: preview.digest });
      if (made !== null && asDefault) await makeDefault(client, made.id).catch(() => undefined);
      setLanded({ catalogId, catalogName, published });
      onDone?.();
    } catch (error) {
      const refusal = ownerRefusal(error);
      if (existing !== undefined && refusal.previewAgain && draft.kind === 'existing') {
        await rereadExisting(draft.catalogId, existing.itemId, refusal.sentence);
      } else setFailure(refusal);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (existing === undefined || autoPreviewed.current || choice?.kind !== 'existing' || preview !== null) return;
    autoPreviewed.current = true;
    void runPreview();
  });

  const plan = draft === null ? null : previewPlan(draft, eligible);
  const state = addState(preview, busy);
  const title =
    publish !== undefined ? 'Publish update' : existing !== undefined ? 'Add to another catalog' : 'Add to catalog';

  return (
    <CatalogSheet name="add" title={title} subtitle={label} closeLabel={`Close ${title}`} onClose={onClose}>
      {landed !== null ? (
        <section className="flex min-w-0 flex-col gap-xs" role="status" data-catalog-landed="">
          <p className="m-0 break-words text-cell font-semibold text-ok">
            {landed.catalogName === ''
              ? `Saved as version ${landed.published.itemVersion}.`
              : `Saved to ${landed.catalogName} as version ${landed.published.itemVersion}.`}
          </p>
          <p className="m-0 text-cell text-muted">{FROZEN_COPY_NOTE}</p>
          {onShareNow === undefined ? null : (
            <Button
              type="button"
              variant="primary"
              onClick={() => onShareNow(landed.catalogId)}
              data-catalog-share-now=""
            >
              <Share2 size={14} aria-hidden="true" />
              Share it now
            </Button>
          )}
          <Button type="button" onClick={onClose} data-catalog-done="">
            {onShareNow === undefined ? 'Done' : 'Not now'}
          </Button>
        </section>
      ) : read.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading your catalogs…
        </p>
      ) : read.kind === 'failed' ? (
        read.refusal.sharingOff ? (
          <SharingOffPanel connection={connection} createClient={createClient} />
        ) : (
          <FailureLine sentence={read.refusal.sentence} again onAgain={() => void start()} againLabel="Try again" />
        )
      ) : (
        <>
          {publish === undefined ? (
            <form className="flex min-w-0 flex-col gap-sm" onSubmit={event => void runPreview(event)}>
              {eligible.length > 0 ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={pickerId} className="text-meta font-semibold text-muted">
                    Catalog
                  </label>
                  <select
                    id={pickerId}
                    className="kt-input"
                    value={choice?.kind === 'existing' ? choice.catalogId : '__new'}
                    onChange={event =>
                      event.target.value === '__new'
                        ? choose({ kind: 'new', name: newName })
                        : choose({ kind: 'existing', catalogId: event.target.value })
                    }
                    data-catalog-picker=""
                  >
                    {eligible.map(catalog => (
                      <option key={catalog.id} value={catalog.id}>
                        {catalog.name} ·{' '}
                        {plural(catalog.items.filter(item => item.withdrawnAt === undefined).length, 'item')}
                      </option>
                    ))}
                    <option value="__new">A new catalog…</option>
                  </select>
                </div>
              ) : (
                <p className="m-0 text-cell text-muted">
                  {catalogs.length === 0
                    ? 'You have no catalog yet. Name one to start.'
                    : 'It is in all your catalogs already. Name a new one.'}
                </p>
              )}
              {choice?.kind === 'new' ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={nameId} className="text-meta font-semibold text-muted">
                    Name of the new catalog
                  </label>
                  <input
                    id={nameId}
                    className="kt-input"
                    value={newName}
                    maxLength={120}
                    autoComplete="off"
                    onChange={event => {
                      setNewName(event.target.value);
                      setPreview(null);
                      setFailure(null);
                    }}
                    data-catalog-new-name=""
                  />
                </div>
              ) : null}
              {problem === null ? null : (
                <p className="m-0 text-meta text-muted" data-catalog-choice-problem="">
                  {problem}
                </p>
              )}
              <Button type="submit" variant="primary" disabled={busy || problem !== null} data-catalog-preview="">
                {busy && preview === null ? 'Reading…' : plan === null ? 'Preview' : previewButtonLabel(plan)}
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => void runPreview()}
              data-catalog-preview=""
            >
              {busy && preview === null ? 'Reading…' : 'Preview'}
            </Button>
          )}
          {note === null ? null : (
            <p className="m-0 break-words text-cell text-fg" role="status" data-catalog-notice="">
              {note}
            </p>
          )}
          {failure === null ? null : failure.sharingOff ? (
            <SharingOffPanel connection={connection} createClient={createClient} />
          ) : (
            <FailureLine
              sentence={failure.sentence}
              {...(failure.previewAgain ? { again: true, onAgain: () => void runPreview() } : {})}
            />
          )}
          {preview === null ? null : <PreviewBlock preview={preview} />}
          {preview === null ? null : (
            <div className="flex min-w-0 flex-col gap-xs">
              <p className="m-0 text-cell text-muted">{FROZEN_COPY_NOTE}</p>
              {state.reason === null ? null : (
                <p className="m-0 text-cell text-muted" data-catalog-add-reason="">
                  {state.reason}
                </p>
              )}
              <Button
                type="button"
                variant="primary"
                disabled={!state.enabled}
                onClick={() => void add()}
                data-catalog-add=""
              >
                {busy ? 'Saving…' : publish === undefined ? 'Add to catalog' : 'Publish update'}
              </Button>
            </div>
          )}
        </>
      )}
    </CatalogSheet>
  );
}

/** What would be frozen: where it was read from, what was left out, the warnings and every file. */
function PreviewBlock({ preview }: { readonly preview: SharedItemPreview }) {
  return (
    <section className="flex min-w-0 flex-col gap-sm" aria-label="Preview" data-catalog-preview-block="">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 break-words font-mono text-cell text-fg">
          {revealHidden(preview.name)} · version {preview.version}
        </p>
        <p className="m-0 break-words text-meta text-muted">{revealHidden(preview.summary)}</p>
        <p className="m-0 break-all text-meta text-faint" data-catalog-location="">
          Read from {revealHidden(preview.location)}
        </p>
        <p className="m-0 text-meta text-faint">{formatBytes(preview.size)}</p>
      </div>
      <WarningList warnings={preview.warnings} />
      {preview.problems.length === 0 ? null : (
        <section className="flex min-w-0 flex-col gap-xs" aria-label="Left out" data-catalog-problems="">
          <h4 className="m-0 text-meta font-semibold uppercase text-muted">Left out, and why</h4>
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {preview.problems.map(problem => (
              <li key={`${problem.subject}:${problem.reason}`} className="break-words text-cell text-fg">
                <span className="font-mono">
                  <MarkedText text={problem.subject} />
                </span>
                : <MarkedText text={problem.reason} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <ReviewBody entries={preview.review} warnings={preview.warnings} installerView />
    </section>
  );
}

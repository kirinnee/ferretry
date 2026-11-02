/**
 * The versions of one shared item, for its owner: which one is current, which catalogs use it, how many people can
 * see it, what changed between neighbours, and the three things an owner does with a version already kept: make it
 * current, retire it, bring it back.
 *
 * It opens only from the owner's own surfaces (a row's ⋯ and Sharing › My catalogs) and only when the machine
 * advertises `catalogs.versions.1`; the buttons that write need `catalogs.versions.2` as well. Every refusal is
 * said in one sentence, and an item that moved on while the sheet was open is read again.
 */

import type { CatalogChanges, CatalogMemberView, OwnedCatalog, OwnedSharedItem } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { CatalogSheet, FailureLine, SharingOffPanel } from './catalog-parts.tsx';
import { MarkedText } from './catalog-review-view.tsx';
import { listMembers } from './catalog-shares-api.ts';
import {
  type CatalogClientFactory,
  getSharedItem,
  listCatalogs,
  makeVersionCurrent,
  readItemChanges,
  setVersionRetired,
} from './catalogs-api.ts';
import { type OwnerRefusal, ownerRefusal } from './catalogs-model.ts';
import { ChangesView } from './changes-view.tsx';
import {
  currentDoneSentence,
  makeCurrentSentence,
  READ_AGAIN_SENTENCE,
  reachLine,
  reachOf,
  retireSentence,
  retiredDoneSentence,
  unretireSentence,
  usedByLine,
  usedByNames,
  type VersionLine,
  versionActions,
  versionLines,
} from './versions-model.ts';

export interface VersionsSheetProps {
  readonly connection: DaemonConnection;
  readonly itemId: string;
  /** The item's name as the row says it. */
  readonly label: string;
  /** Whether make current, retire and unretire are offered (`catalogs.versions.2`). */
  readonly canWrite: boolean;
  readonly onClose: () => void;
  /** Called after a write landed, so the list behind the sheet can read again. */
  readonly onChanged?: () => void;
  /** The clock the ages are read against; a test and harness seam. */
  readonly nowMs?: number;
  readonly createClient?: CatalogClientFactory;
}

type Read =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly item: OwnedSharedItem;
      readonly catalogs: readonly OwnedCatalog[];
      readonly reach: number | null;
    }
  | { readonly kind: 'failed'; readonly refusal: OwnerRefusal };

type Compare =
  | { readonly version: number; readonly kind: 'loading' }
  | { readonly version: number; readonly kind: 'ready'; readonly changes: CatalogChanges }
  | { readonly version: number; readonly kind: 'failed'; readonly sentence: string };

type Ask = { readonly act: 'current' | 'retire' | 'unretire'; readonly version: number };

const ASK_SENTENCE: Readonly<Record<Ask['act'], (version: number) => string>> = {
  current: makeCurrentSentence,
  retire: retireSentence,
  unretire: unretireSentence,
};

const ASK_BUTTON: Readonly<Record<Ask['act'], (version: number) => string>> = {
  current: version => `Make version ${String(version)} current`,
  retire: version => `Retire version ${String(version)}`,
  unretire: version => `Bring version ${String(version)} back`,
};

export function VersionsSheet({
  connection,
  itemId,
  label,
  canWrite,
  onClose,
  onChanged,
  nowMs,
  createClient: injected,
}: VersionsSheetProps) {
  const routed = useDaemonClient();
  const createClient: CatalogClientFactory = injected ?? routed;
  const [now] = useState(() => nowMs ?? Date.now());
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [compare, setCompare] = useState<Compare | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly version: number; readonly refusal: OwnerRefusal } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const compareToken = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    try {
      const client = await createClient(connection);
      const [item, owned, members] = await Promise.all([
        getSharedItem(client, itemId),
        listCatalogs(client),
        listMembers(client).then(
          (list): readonly CatalogMemberView[] | null => list.members,
          () => null,
        ),
      ]);
      setRead({ kind: 'ready', item, catalogs: owned.catalogs, reach: reachOf(item, members) });
    } catch (error) {
      setRead({ kind: 'failed', refusal: ownerRefusal(error) });
    }
  }, [connection, createClient, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showChanges = async (line: VersionLine): Promise<void> => {
    if (line.previous === null) return;
    if (compare?.version === line.version) {
      compareToken.current += 1;
      setCompare(null);
      return;
    }
    compareToken.current += 1;
    const token = compareToken.current;
    setCompare({ version: line.version, kind: 'loading' });
    try {
      const changes = await readItemChanges(await createClient(connection), itemId, line.previous, line.version);
      if (token === compareToken.current) setCompare({ version: line.version, kind: 'ready', changes });
    } catch (error) {
      if (token === compareToken.current)
        setCompare({ version: line.version, kind: 'failed', sentence: ownerRefusal(error).sentence });
    }
  };

  const run = async (chosen: Ask, current: number): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const client = await createClient(connection);
      if (chosen.act === 'current') {
        await makeVersionCurrent(client, itemId, chosen.version, current);
        setNote(currentDoneSentence(chosen.version));
      } else {
        await setVersionRetired(client, itemId, chosen.version, chosen.act === 'retire');
        setNote(retiredDoneSentence(chosen.version, chosen.act === 'retire'));
      }
      setAsk(null);
      onChanged?.();
      await load();
    } catch (error) {
      const refusal = ownerRefusal(error);
      if (refusal.previewAgain) {
        setAsk(null);
        setNote(READ_AGAIN_SENTENCE);
        await load();
      } else {
        setAsk(null);
        setFailure({ version: chosen.version, refusal });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <CatalogSheet name="versions" title="Versions" subtitle={label} closeLabel="Close Versions" onClose={onClose}>
      {read.kind === 'loading' ? (
        <p className="m-0 text-cell text-muted" role="status">
          Reading the versions…
        </p>
      ) : read.kind === 'failed' ? (
        read.refusal.sharingOff ? (
          <SharingOffPanel connection={connection} createClient={createClient} />
        ) : (
          <FailureLine sentence={read.refusal.sentence} again onAgain={() => void load()} againLabel="Try again" />
        )
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-0.5" data-versions-reach="">
            <p className="m-0 break-words text-cell text-fg">
              <MarkedText text={usedByLine(usedByNames(read.item, read.catalogs))} />
            </p>
            {reachLine(read.reach) === null ? null : (
              <p className="m-0 text-cell text-muted">{reachLine(read.reach)}</p>
            )}
          </div>
          {note === null ? null : (
            <p className="m-0 break-words text-cell text-ok" role="status" data-versions-note="">
              {note}
            </p>
          )}
          {failure?.refusal.sharingOff === true ? (
            <SharingOffPanel connection={connection} createClient={createClient} />
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Versions" data-versions-list="">
            {versionLines(read.item, now).map(line => {
              const actions = versionActions(line, canWrite);
              const asked = ask?.version === line.version ? ask : null;
              return (
                <li
                  key={line.version}
                  className={cn('kt-panel flex min-w-0 flex-col gap-xs p-control-x py-2', line.retired && 'opacity-80')}
                  data-version={line.version}
                  {...(line.current ? { 'data-version-current': '' } : {})}
                  {...(line.retired ? { 'data-version-retired': '' } : {})}
                >
                  <p className="m-0 break-words font-mono text-cell text-fg" data-version-text="">
                    {line.text}
                  </p>
                  <div className="flex min-w-0 flex-wrap gap-xs">
                    {line.previous === null ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-expanded={compare?.version === line.version}
                        onClick={() => void showChanges(line)}
                        data-version-changes={line.version}
                      >
                        {compare?.version === line.version
                          ? 'Hide what changed'
                          : `What changed since v${String(line.previous)}`}
                      </Button>
                    )}
                    {actions.makeCurrent ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setAsk({ act: 'current', version: line.version });
                        }}
                        data-version-make-current={line.version}
                      >
                        Make current
                      </Button>
                    ) : null}
                    {actions.retire ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setAsk({ act: 'retire', version: line.version });
                        }}
                        data-version-retire={line.version}
                      >
                        Retire…
                      </Button>
                    ) : null}
                    {actions.unretire ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setAsk({ act: 'unretire', version: line.version });
                        }}
                        data-version-unretire={line.version}
                      >
                        Bring back…
                      </Button>
                    ) : null}
                  </div>
                  {failure?.version === line.version && !failure.refusal.sharingOff ? (
                    <FailureLine sentence={failure.refusal.sentence} />
                  ) : null}
                  {asked === null ? null : (
                    <div
                      className="flex min-w-0 flex-col items-start gap-xs rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-warn"
                      role="alertdialog"
                      aria-label={ASK_BUTTON[asked.act](asked.version)}
                      data-version-confirm={asked.act}
                    >
                      <p className="m-0 break-words text-cell">{ASK_SENTENCE[asked.act](asked.version)}</p>
                      <div className="flex flex-wrap gap-xs">
                        <Button
                          type="button"
                          size="sm"
                          variant={asked.act === 'retire' ? 'danger' : 'primary'}
                          disabled={busy}
                          onClick={() => void run(asked, read.item.current)}
                          data-version-confirm-yes=""
                        >
                          {busy ? 'Saving…' : ASK_BUTTON[asked.act](asked.version)}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setAsk(null)}
                          data-version-confirm-no=""
                        >
                          Not now
                        </Button>
                      </div>
                    </div>
                  )}
                  {compare?.version !== line.version ? null : compare.kind === 'loading' ? (
                    <p className="m-0 text-cell text-muted" role="status">
                      Comparing…
                    </p>
                  ) : compare.kind === 'failed' ? (
                    <FailureLine sentence={compare.sentence} />
                  ) : (
                    <ChangesView
                      changes={compare.changes}
                      heading={`What changed: v${String(line.previous)} to v${String(line.version)}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </CatalogSheet>
  );
}

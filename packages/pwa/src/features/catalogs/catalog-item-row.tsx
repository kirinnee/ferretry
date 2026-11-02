/**
 * One ACTIVE skill or MCP server as a compact row: what this session can use, and where it came from.
 *
 * The context rail's Skills and MCP lists and the session Skills surface all draw THIS row, so an item
 * reads and behaves the same wherever it is listed: its name (tapping it inserts the invocation), where it
 * came from (a scope chip, and "from Ines · v2" for what a catalog install wrote), the version when one of
 * this machine's catalogs holds it, and one line of description.
 *
 * NOTHING ON THE ROW PUBLISHES (docs/catalogs.md, &B131): a list of what a session can use is not a shop,
 * so there is no Share and no Add beside the name. The one control is **⋯**, which holds, in order:
 * - **Open** the item's file or detail;
 * - **Publish in ‹default catalog›** (one tap, with Undo) and **Publish in another catalog…**, or
 *   **Publish in a catalog…** when one tap is not offered — only for what this machine could share, never for
 *   what someone else's catalog wrote here;
 * - **Uninstall**, only for what a catalog install wrote. The daemon removes exactly the files that install
 *   recorded and refuses one changed since, so a skill somebody wrote by hand never gets the item at all.
 * Sharing a catalog with people, and its versions, live in Sharing › My catalogs.
 */

import type { CatalogInstall, CatalogItemSource } from '@ferretry/protocol';
import { revealHidden } from '@ferretry/protocol';
import { Eye, MoreHorizontal, PackagePlus, Trash2 } from 'lucide-react';
import type { SharedItemPreview } from '@ferretry/protocol';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../../shell/context-menu.tsx';
import { Button } from '../../shell/primitives.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import { AddToCatalogSheet, type AddToCatalogSheetProps } from './add-to-catalog-sheet.tsx';
import { CatalogAddToast, type CatalogToast } from './catalog-add-toast.tsx';
import { removeCatalogInstall } from './catalog-installs-api.ts';
import { installRefusal, installsFor, REMOVE_NOTE } from './catalog-install-model.ts';
import { FailureLine } from './catalog-parts.tsx';
import type { CatalogRowsHost, CatalogRowsRead } from './catalog-row-tools.tsx';
import { canAdd, ownedMatches, removeLabel, rowChips, sharedItemFor } from './catalog-row-model.ts';
import { listSharedItems, quickAdd, undoQuickAdd } from './catalogs-api.ts';
import {
  ADDED_TOAST_MS,
  addedSentence,
  alreadySentence,
  defaultCatalogName,
  defaultCatalogOf,
  listedLive,
  NOTE_TOAST_MS,
  ownerRefusal,
  publishDestination,
  quickAddOutcome,
  reviewSentence,
  undoneSentence,
} from './catalogs-model.ts';

interface RowScope {
  readonly label: string;
  readonly title: string;
  readonly tone: 'accent' | 'muted';
}

export interface CatalogItemRowProps {
  /** Without a host the row is the plain compact row: no Publish, no Uninstall, no version. */
  readonly host?: CatalogRowsHost;
  /** What the host's lists said. Required with a host. */
  readonly read?: CatalogRowsRead;
  readonly kind: 'skill' | 'mcp';
  /** The skill or server name, which installs are matched by. */
  readonly itemName: string;
  /** What the row shows in mono: the invocation, or the server's name. */
  readonly label: string;
  /** What Publish points at, and what a catalog's items are matched against. */
  readonly source: CatalogItemSource;
  readonly scope: RowScope;
  /** One line under the name. The whole text is the row's tooltip. */
  readonly description?: string;
  /** "Overridden by a Project skill": a quiet line under the description. */
  readonly note?: string;
  /** Tapping the name. Without it the name is plain text. */
  readonly onUse?: () => void;
  /** The ⋯ item that opens the item's file or detail, and what it is called. */
  readonly onOpen?: () => void;
  readonly openLabel?: string;
  readonly dimmed?: boolean;
  /** Rendered under the row's line: an MCP server's status and its Check and Sign in. */
  readonly children?: ReactNode;
}

/** What the add sheet opens with when one tap did not finish the job. */
type SheetStart = Pick<AddToCatalogSheetProps, 'notice' | 'existing'> & { readonly initial?: SharedItemPreview };

/** A toast and what Undo needs; `key` restarts the countdown for a new one. */
type ToastState = CatalogToast & { readonly key: number };

export function CatalogItemRow({
  host,
  read,
  kind,
  itemName,
  label,
  source,
  scope,
  description,
  note,
  onUse,
  onOpen,
  openLabel = 'Open SKILL.md',
  dimmed = false,
  children,
}: CatalogItemRowProps) {
  const routed = useDaemonClient();
  const createClient = host?.createClient ?? routed;
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const tapLock = useRef(false);
  const toastKey = useRef(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [sheetStart, setSheetStart] = useState<SheetStart>({});

  const installs = read === undefined ? [] : installsFor(read.installs, kind, itemName);
  const matches = read === undefined ? [] : ownedMatches(read.catalogs, source);
  const chips = rowChips(installs, matches);
  const addable = host !== undefined && canAdd(installs);
  const oneTap = addable && read?.features.quickAdd === true;
  const defaultCatalog = read === undefined ? undefined : defaultCatalogOf(read.catalogs, read.defaultCatalogId);

  const showToast = useCallback((next: CatalogToast): void => {
    toastKey.current += 1;
    setToast({ ...next, key: toastKey.current });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const openSheet = (start: SheetStart): void => {
    setSheetStart(start);
    setAdding(true);
  };

  const undo = async (token: string, catalogName: string): Promise<void> => {
    if (host === undefined) return;
    setToast(current => (current === null ? null : { ...current, undoing: true }));
    try {
      const undone = await undoQuickAdd(await createClient(host.connection), token);
      showToast({ sentence: undoneSentence(undone, catalogName), lifetimeMs: NOTE_TOAST_MS });
    } catch (error) {
      showToast({ sentence: ownerRefusal(error).sentence, lifetimeMs: NOTE_TOAST_MS });
    }
    read?.reload();
  };

  const tapAdd = async (): Promise<void> => {
    if (host === undefined || tapLock.current) return;
    tapLock.current = true;
    setFailure(null);
    setToast(null);
    try {
      const answer = await quickAdd(await createClient(host.connection), { source });
      const outcome = quickAddOutcome(answer, read?.catalogs ?? []);
      if (outcome.kind === 'added') {
        const { catalogName, token } = outcome;
        showToast({
          sentence: addedSentence(catalogName),
          lifetimeMs: ADDED_TOAST_MS,
          onUndo: () => void undo(token, catalogName),
        });
        read?.reload();
      } else if (outcome.kind === 'already')
        showToast({ sentence: alreadySentence(outcome.catalogName), lifetimeMs: NOTE_TOAST_MS });
      else
        openSheet({
          notice: reviewSentence(outcome.reasons),
          ...(outcome.preview === undefined ? {} : { initial: outcome.preview }),
        });
    } catch (error) {
      openSheet({ notice: ownerRefusal(error).sentence });
    } finally {
      tapLock.current = false;
    }
  };

  const addAnother = async (): Promise<void> => {
    if (host === undefined) return;
    setFailure(null);
    if (read?.features.items !== true) return openSheet({});
    try {
      const list = await listSharedItems(await createClient(host.connection));
      const item = sharedItemFor(list.items, source);
      openSheet(
        item === undefined
          ? {}
          : { existing: { itemId: item.itemId, version: item.current, listedIn: listedLive(item) } },
      );
    } catch (error) {
      setFailure(ownerRefusal(error).sentence);
    }
  };

  const remove = async (install: CatalogInstall): Promise<void> => {
    if (host === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      await removeCatalogInstall(await createClient(host.connection), install.target.scope, install.installId);
      setRemoving(null);
      read?.reload();
    } catch (error) {
      setFailure(installRefusal(error).sentence);
    } finally {
      setBusy(false);
    }
  };

  const publishIcon = <PackagePlus size={16} aria-hidden="true" />;
  const items: ContextMenuItem[] = [];
  if (onOpen !== undefined)
    items.push({ key: 'open', label: openLabel, icon: <Eye size={16} aria-hidden="true" />, onSelect: onOpen });
  // One tap names where it lands; "another catalog" appears once a catalog here already holds the item.
  if (oneTap)
    items.push({
      key: 'publish',
      label: publishDestination(defaultCatalog, host?.connection.daemonName),
      icon: publishIcon,
      onSelect: () => void tapAdd(),
    });
  else if (addable && matches.length === 0)
    items.push({ key: 'publish', label: 'Publish in a catalog…', icon: publishIcon, onSelect: () => openSheet({}) });
  if (addable && matches.length > 0)
    items.push({
      key: 'publish-another',
      label: 'Publish in another catalog…',
      icon: publishIcon,
      onSelect: () => void addAnother(),
    });
  for (const install of installs)
    items.push({
      key: `uninstall-${install.installId}`,
      label: removeLabel(install, installs.length > 1),
      icon: <Trash2 size={16} aria-hidden="true" />,
      danger: true,
      separatorBefore: items.length > 0,
      onSelect: () => {
        setFailure(null);
        setRemoving(install.installId);
      },
    });

  const openMenu = (): void => {
    const rect = moreRef.current?.getBoundingClientRect();
    setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
  };

  const nameClass = 'flex min-w-0 flex-col items-start gap-0.5 rounded-control px-xs py-xs text-left';
  const nameBlock = (
    <>
      <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-xs gap-y-0.5">
        <span className="min-w-0 truncate font-mono text-cell text-fg" data-row-label="">
          {label}
        </span>
        <span className="fy-info-chip" data-tone={scope.tone} title={scope.title} data-row-scope="">
          {scope.label}
        </span>
        {chips.version === null ? null : (
          <span className="fy-info-chip" data-tone="muted" data-row-version="">
            {chips.version}
          </span>
        )}
        {chips.from === null ? null : (
          <span className="fy-info-chip" data-tone="accent" title={chips.from.title} data-row-from="">
            {chips.from.text}
          </span>
        )}
      </span>
      {description === undefined ? null : (
        <span className="block max-w-full truncate text-meta text-muted" title={description} data-row-description="">
          {description}
        </span>
      )}
      {note === undefined ? null : (
        <span className="text-meta text-faint" data-row-note="">
          {note}
        </span>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col" data-catalog-item-row={itemName} data-catalog-item-kind={kind}>
      <div className={cn('flex min-w-0 flex-wrap items-start gap-x-xs gap-y-0', dimmed && 'opacity-70')}>
        {onUse === undefined ? (
          <div className={cn(nameClass, 'min-h-row min-w-[8rem] flex-1')}>{nameBlock}</div>
        ) : (
          <button
            type="button"
            className={cn(nameClass, 'min-h-row min-w-[8rem] flex-1 hover:bg-surface-2 focus-visible:bg-surface-2')}
            aria-label={`Use ${label} in chat`}
            onClick={onUse}
            data-row-use={itemName}
          >
            {nameBlock}
          </button>
        )}
        {items.length === 0 ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1" data-row-controls="">
            <Button
              ref={moreRef}
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-[44px] min-w-[44px]"
              aria-label={`More for ${label}`}
              aria-haspopup="menu"
              aria-expanded={anchor !== null}
              onClick={openMenu}
              data-row-more=""
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      {children}
      {installs.map(install =>
        removing === install.installId ? (
          <div
            key={install.installId}
            className="mx-xs mb-xs flex min-w-0 flex-col gap-xs rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-warn"
            data-catalog-remove-confirm=""
          >
            <p className="m-0 break-words text-cell font-semibold">
              Uninstall {revealHidden(itemName)} from {install.destination}?
            </p>
            <p className="m-0 text-cell">{REMOVE_NOTE}</p>
            <div className="flex flex-wrap gap-xs">
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void remove(install)}
                data-catalog-remove-yes=""
              >
                {busy ? 'Uninstalling…' : 'Uninstall it'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRemoving(null)}
                data-catalog-remove-no=""
              >
                Keep it
              </Button>
            </div>
          </div>
        ) : null,
      )}
      {failure === null ? null : (
        <div className="px-xs pb-xs">
          <FailureLine sentence={failure} />
        </div>
      )}
      {items.length === 0 ? null : (
        <ContextMenu
          open={anchor !== null}
          anchor={anchor ?? { x: 0, y: 0 }}
          ariaLabel={`More for ${label}`}
          triggerRef={moreRef}
          onClose={() => setAnchor(null)}
          items={items}
        />
      )}
      {host === undefined || !adding ? null : (
        <AddToCatalogSheet
          connection={host.connection}
          source={source}
          label={itemName}
          onClose={() => setAdding(false)}
          onDone={() => read?.reload()}
          {...sheetStart}
          {...(oneTap && defaultCatalog !== undefined ? { preferCatalogId: defaultCatalog.id } : {})}
          {...(oneTap && defaultCatalog === undefined
            ? { suggestNewName: defaultCatalogName(host.connection.daemonName), asDefault: true }
            : {})}
          {...(host.createClient === undefined ? {} : { createClient: host.createClient })}
        />
      )}
      {toast === null ? null : <CatalogAddToast key={toast.key} toast={toast} onDismiss={dismissToast} />}
    </div>
  );
}

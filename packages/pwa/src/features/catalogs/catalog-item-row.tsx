/**
 * One skill or MCP server as a compact row, with Share and Add on the side.
 *
 * The context rail's Skills and MCP lists and the session Skills surface all draw THIS row, so an item
 * reads and behaves the same wherever it is listed: its name (tapping it inserts the invocation), a scope
 * chip, the version when one is known, and one line of description. On the right, always visible and at
 * least 44 px tall, are **Share**, **Add** (only for what this machine could share) and **⋯**.
 *
 * - **Add** opens the add sheet.
 * - **Share** needs no new route: an item already in exactly one of this machine's catalogs opens that
 *   catalog's Share sheet; in several, a short picker comes first; in none, the add sheet whose last
 *   step offers "Share it now" and carries straight on into the Share sheet for the catalog it landed in.
 * - **⋯** holds Open, Add to another catalog… and, for what a catalog install wrote, Remove, which asks
 *   first as it always has.
 */

import type { CatalogInstall, CatalogItemSource, OwnedCatalog } from '@ferretry/protocol';
import { revealHidden } from '@ferretry/protocol';
import { Eye, MoreHorizontal, PackagePlus, Share2, Trash2 } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../../shell/context-menu.tsx';
import { Button } from '../../shell/primitives.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import { AddToCatalogSheet } from './add-to-catalog-sheet.tsx';
import { removeCatalogInstall } from './catalog-installs-api.ts';
import { installRefusal, installsFor, REMOVE_NOTE } from './catalog-install-model.ts';
import { CatalogSheet, FailureLine } from './catalog-parts.tsx';
import type { CatalogRowsHost, CatalogRowsRead } from './catalog-row-tools.tsx';
import { canAdd, ownedMatches, removeLabel, rowChips, sharePlan } from './catalog-row-model.ts';
import { listCatalogs } from './catalogs-api.ts';
import { ownerRefusal } from './catalogs-model.ts';
import { ShareSheet } from './share-sheet.tsx';

interface RowScope {
  readonly label: string;
  readonly title: string;
  readonly tone: 'accent' | 'muted';
}

export interface CatalogItemRowProps {
  /** Without a host the row is the plain compact row: no Share, no Add, no version. */
  readonly host?: CatalogRowsHost;
  /** What the host's lists said. Required with a host. */
  readonly read?: CatalogRowsRead;
  readonly kind: 'skill' | 'mcp';
  /** The skill or server name, which installs are matched by. */
  readonly itemName: string;
  /** What the row shows in mono: the invocation, or the server's name. */
  readonly label: string;
  /** What Add points at, and what a catalog's items are matched against. */
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

type Adding = 'add' | 'share';

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
  const [adding, setAdding] = useState<Adding | null>(null);
  const [picking, setPicking] = useState<readonly OwnedCatalog[] | null>(null);
  const [sharing, setSharing] = useState<OwnedCatalog | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const installs = read === undefined ? [] : installsFor(read.installs, kind, itemName);
  const matches = read === undefined ? [] : ownedMatches(read.catalogs, source);
  const chips = rowChips(installs, matches);
  const addable = host !== undefined && canAdd(installs);

  const share = (): void => {
    setFailure(null);
    const plan = sharePlan(matches);
    if (plan.kind === 'one') setSharing(plan.catalog);
    else if (plan.kind === 'many') setPicking(plan.catalogs);
    else setAdding('share');
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

  const shareNow = async (catalogId: string): Promise<void> => {
    if (host === undefined) return;
    try {
      const list = await listCatalogs(await createClient(host.connection));
      const catalog = list.catalogs.find(candidate => candidate.id === catalogId);
      if (catalog === undefined) {
        setAdding(null);
        setFailure('That catalog is not there any more.');
        return;
      }
      setAdding(null);
      setSharing(catalog);
    } catch (error) {
      setAdding(null);
      setFailure(ownerRefusal(error).sentence);
    }
  };

  const items: ContextMenuItem[] = [];
  if (onOpen !== undefined)
    items.push({ key: 'open', label: openLabel, icon: <Eye size={16} aria-hidden="true" />, onSelect: onOpen });
  if (addable && matches.length > 0)
    items.push({
      key: 'add-another',
      label: 'Add to another catalog…',
      icon: <PackagePlus size={16} aria-hidden="true" />,
      onSelect: () => setAdding('add'),
    });
  for (const install of installs)
    items.push({
      key: `remove-${install.installId}`,
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
        {host === undefined && items.length === 0 ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1" data-row-controls="">
            {host === undefined ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-[44px] min-w-[5rem] justify-center"
                aria-label={`Share ${label}`}
                onClick={share}
                data-row-share=""
              >
                <Share2 size={14} aria-hidden="true" />
                Share
              </Button>
            )}
            {addable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-[44px] min-w-[4rem] justify-center"
                aria-label={`Add ${label} to a catalog`}
                onClick={() => setAdding('add')}
                data-row-add=""
              >
                <PackagePlus size={14} aria-hidden="true" />
                Add
              </Button>
            ) : (
              <span className="w-[4rem]" aria-hidden="true" />
            )}
            {items.length === 0 ? (
              <span className="w-[44px]" aria-hidden="true" />
            ) : (
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
            )}
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
              Remove {revealHidden(itemName)} from {install.destination}?
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
                {busy ? 'Removing…' : 'Remove it'}
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
      {host === undefined || adding === null ? null : (
        <AddToCatalogSheet
          connection={host.connection}
          source={source}
          label={itemName}
          onClose={() => setAdding(null)}
          onDone={() => read?.reload()}
          {...(adding === 'share' ? { onShareNow: (catalogId: string) => void shareNow(catalogId) } : {})}
          {...(host.createClient === undefined ? {} : { createClient: host.createClient })}
        />
      )}
      {picking === null ? null : (
        <CatalogSheet
          name="share-pick"
          title={`Share ${itemName}`}
          subtitle="It is in more than one of your catalogs. Which one do you want to share?"
          closeLabel="Close Share"
          onClose={() => setPicking(null)}
        >
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {picking.map(catalog => (
              <li key={catalog.id}>
                <Button
                  type="button"
                  className="min-h-[44px] w-full justify-start"
                  onClick={() => {
                    setPicking(null);
                    setSharing(catalog);
                  }}
                  data-row-share-pick={catalog.id}
                >
                  {catalog.name}
                </Button>
              </li>
            ))}
          </ul>
        </CatalogSheet>
      )}
      {host === undefined || sharing === null ? null : (
        <ShareSheet
          connection={host.connection}
          catalog={sharing}
          onClose={() => {
            setSharing(null);
            read?.reload();
          }}
          onChanged={() => read?.reload()}
          {...(host.createClient === undefined ? {} : { createClient: host.createClient })}
        />
      )}
    </div>
  );
}

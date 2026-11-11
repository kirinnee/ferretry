/**
 * THE LIST'S ROW ACTIONS, for whichever ferret was pressed.
 *
 * It composes exactly what the header's Actions ▾ composes — the core rows plus every plugin's rows, offered through the
 * `ferrets.actions-row` slot — built for the PRESSED ferret ({@link useFerretActions}, shared with the header). The only
 * entries that are the row's own are the two a header never needs: Open, and Copy ferret name. Nothing here imports
 * another plugin: a contributor reaches the row through the slot, as it reaches the header.
 *
 * IT OUTLIVES ITS MENU. A contributor draws its own dialog from `run` (MCP's Add server form, Warden's ask form), and a
 * settled form leaves a toast. So the provider keeps this mounted for the last pressed ferret and only `open` says whether
 * the menu is on screen. Pressing another ferret remounts it, which unmounts the first ferret's contributors and so
 * withdraws their rows (`offer(id, null)`): the menu never holds A's rows under B.
 */

import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import { ACTIONS_ROW_SLOT, type ActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import { Copy, MessageSquare } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { browserClipboardWriter, type MenuAnchor } from '../../ui.ts';
import { ActionToast } from '../header/action-toast.tsx';
import type { CoreActionContext } from '../header/core-actions.ts';
import type { FerretActionContribution } from '../header/registry.ts';
import { daemonOfRoute } from '../header/header-paths.ts';
import { useFerretActions } from '../header/use-ferret-actions.tsx';
import { ferretChatHref } from '../new-ferret/hrefs.ts';
import { ContextActionsMenu } from './context-actions-menu.tsx';
import { type RowMenuRequest, RowMenuContext } from './row-menu-context.ts';

const ROW_ACTION_IDS = { open: 'open', copyName: 'copy-name' } as const;

/** What a row's own menu entries are: Open (before the core rows) and Copy ferret name (after Copy ferret id). */
const rowEntries = (
  open: () => void,
  copyName: (name: string) => void,
): readonly FerretActionContribution<CoreActionContext>[] => [
  {
    group: 'ferret',
    order: 5,
    build: () => ({ kind: 'run', id: ROW_ACTION_IDS.open, label: 'Open', icon: MessageSquare, run: open }),
  },
  {
    group: 'ferret',
    order: 35,
    build: context => ({
      kind: 'run',
      id: ROW_ACTION_IDS.copyName,
      label: 'Copy ferret name',
      icon: Copy,
      run: () => copyName(context.name),
    }),
  },
];

export interface FerretRowActionsHostProps {
  readonly client: LiveFerretsClient;
  /** The ferret the press landed on. */
  readonly ferret: FerretSummary;
  readonly anchor: MenuAnchor;
  /** A touch press: the menu is a bottom sheet. */
  readonly touch: boolean;
  /** Whether the menu is on screen. A contributor's dialog and status line outlive it. */
  readonly open: boolean;
  readonly onClose: () => void;
  /** Hands focus back to the row the menu came from; false when that row left the page. */
  readonly focusRow?: () => boolean;
}

/** The list re-reads on `ferrets.changed`, so a row menu has nothing of its own to re-read. */
const settled = async (): Promise<void> => undefined;

export function FerretRowActionsHost({
  client,
  ferret,
  anchor,
  touch,
  open,
  onClose,
  focusRow,
}: FerretRowActionsHostProps) {
  const router = useOptionalRouter();
  const clipboard = useMemo(() => browserClipboardWriter(), []);
  const extra = useCallback(
    (fail: (sentence: string, detail?: string) => void) =>
      rowEntries(
        () => {
          const daemon = router === null ? undefined : daemonOfRoute(router.route);
          if (router === null || daemon === undefined) fail('This page has no daemon to open the ferret on.');
          else router.navigate(ferretChatHref(daemon, ferret.id));
        },
        name => {
          void clipboard(name).catch(() => fail('Copying the name was blocked — select it instead.'));
        },
      ),
    [clipboard, ferret.id, router],
  );
  const actions = useFerretActions(client, ferret, settled, { extra });
  const { alert, daemon, name } = actions;

  const close = (restoreFocus: boolean): void => {
    if (restoreFocus) focusRow?.();
    onClose();
  };

  return (
    <>
      {open ? (
        <ContextActionsMenu
          anchor={anchor}
          name={name}
          onClose={close}
          onFailure={actions.report}
          onNotice={actions.setNotice}
          sections={actions.sections}
          touch={touch}
        />
      ) : null}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          props={
            {
              ferret: ferret.id,
              name,
              canControl: actions.canControl,
              offer: actions.offer,
            } satisfies ActionsRowSlotProps
          }
          slot={ACTIONS_ROW_SLOT}
        />
      )}
      {alert === null ? null : (
        <p className="fy-action-form__failure" data-ferret-alert="" role="alert">
          {alert.sentence}
          {alert.detail === undefined ? null : (
            <details>
              <summary>Details</summary>
              <pre>{alert.detail}</pre>
            </details>
          )}
        </p>
      )}
      {actions.panel}
      <ActionToast notice={actions.notice} onDismiss={() => actions.setNotice(null)} />
    </>
  );
}

interface OpenMenu {
  readonly request: RowMenuRequest;
  readonly touch: boolean;
  readonly open: boolean;
}

/**
 * Holds the one row menu of a list and offers {@link RowMenuContext} to its rows. A press is a finger when the row says
 * so, or when the last thing the reader did was touch a screen (Android raises `contextmenu` after a long-press); a
 * keyboard open is never one.
 */
export function FerretRowMenuProvider({
  client,
  children,
}: {
  readonly client: LiveFerretsClient;
  readonly children: ReactNode;
}) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const modality = useRef<string>('mouse');
  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      modality.current = event.pointerType;
    };
    const onKey = (): void => {
      modality.current = 'keyboard';
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const openMenu = useCallback((request: RowMenuRequest): void => {
    const finger = request.trigger === 'touch' || modality.current === 'touch' || modality.current === 'pen';
    setMenu({ request, touch: request.trigger !== 'keyboard' && finger, open: true });
  }, []);
  const close = useCallback((): void => {
    setMenu(shown => (shown === null ? null : { ...shown, open: false }));
  }, []);
  return (
    <RowMenuContext.Provider value={openMenu}>
      {children}
      {menu === null ? null : (
        <FerretRowActionsHost
          anchor={{ x: menu.request.x, y: menu.request.y }}
          client={client}
          ferret={menu.request.ferret}
          focusRow={menu.request.focusRow}
          key={menu.request.ferret.id}
          onClose={close}
          open={menu.open}
          touch={menu.touch}
        />
      )}
    </RowMenuContext.Provider>
  );
}

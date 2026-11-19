import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
import type { Route } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { useDialogFocus } from '../ui/hooks/use-dialog-focus.ts';
import { useShell } from './context.tsx';
import { drawerState, useDrawerCollapsed, useDrawerOpen } from './drawer-state.ts';
import { DrawerFind } from './drawer-find.tsx';
import { DrawerNav } from './drawer-nav.tsx';
import { MachineItem } from './machine-switcher.tsx';
import { SideBody, useSideHolds } from './side-column.tsx';

/**
 * THE LEFT DRAWER, the shell's one side of navigation (owner, 11-18: no bar of places across the top; Find in the side bar;
 * the side bar collapsible). Top to bottom: the machine item (only with two or more machines paired), Find, the app's
 * destinations, and the LIST SLOT where the ferret list draws (its own header and rows are the list's, not the drawer's).
 *
 * Wide: a column that collapses to a slim icon rail (destinations and Find; the list slot is put away), remembered on this
 * device. Phone: shut by default and opened over the page by a menu button, in the same order, with a scrim; Escape, the scrim, a
 * place chosen or the close button shut it.
 */

/** The cmd/ctrl+B shortcut: toggles the drawer, except while the person is typing in a field (a composer keeps its own keys). */
export function useDrawerShortcut(): void {
  const { viewport, plan } = useShell();
  const byDefault = plan.nav.style === 'rail';
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b')
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') != null) return;
      event.preventDefault();
      if (viewport === 'phone') drawerState.setOpen(!drawerState.open());
      else drawerState.toggleCollapsed(byDefault);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewport, byDefault]);
}

export function Drawer({
  daemon,
  navDaemon,
  route,
  findRef,
  onFind,
  listed,
}: {
  /** The machine this page is on (none on the list and device pages). */
  readonly daemon: string | undefined;
  /** The machine the places are for: the page's, else the selected one. */
  readonly navDaemon: string | undefined;
  readonly route: Route;
  readonly findRef: RefObject<HTMLButtonElement | null>;
  readonly onFind: () => void;
  /** Whether the list slot may draw (not while a whole-machine line replaces the pages). */
  readonly listed: boolean;
}) {
  const { viewport, plan } = useShell();
  const phone = viewport === 'phone';
  const { entryKey } = useRouter();
  const [collapsed, setCollapsed] = useDrawerCollapsed(plan.nav.style === 'rail');
  const [open, setOpen] = useDrawerOpen();
  const holds = useSideHolds(daemon, route);
  const panel = useRef<HTMLElement | null>(null);
  const shown = !phone || open;
  const { onKeyDown } = useDialogFocus(phone && open, panel, () => setOpen(false));
  // A place chosen (or any page change) puts the phone's overlay away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `entryKey` IS the trigger: a new page shuts the overlay.
  useEffect(() => {
    drawerState.setOpen(false);
  }, [entryKey]);
  // Growing out of the phone width leaves no overlay behind.
  useEffect(() => {
    if (!phone) drawerState.setOpen(false);
  }, [phone]);
  if (!shown) return null;
  const rail = !phone && collapsed;
  const Toggle = phone ? X : rail ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = phone ? 'Close the menu' : rail ? 'Expand the side bar' : 'Collapse the side bar';
  return (
    <>
      {phone ? (
        <button type="button" className="fy-drawer-scrim" aria-label="Close the menu" onClick={() => setOpen(false)} />
      ) : null}
      <aside
        ref={panel}
        className={`fy-drawer${rail ? ' fy-drawer--rail' : ''}${phone ? ' fy-drawer--overlay' : ''}`}
        data-slot="drawer"
        data-collapsed={rail ? '' : undefined}
        aria-label="Menu"
        {...(phone ? { role: 'dialog', 'aria-modal': true, onKeyDown } : {})}
      >
        <MachineItem daemon={daemon} rail={rail} />
        <div className="fy-drawer__bar">
          <DrawerFind findRef={findRef} onOpen={onFind} rail={rail} />
          <button
            type="button"
            className="fy-drawer__toggle"
            data-drawer-toggle=""
            aria-label={toggleLabel}
            aria-expanded={phone ? undefined : !rail}
            aria-keyshortcuts={phone ? undefined : 'Meta+B Control+B'}
            onClick={() => (phone ? setOpen(false) : setCollapsed(!collapsed))}
          >
            <Toggle aria-hidden="true" size={18} />
          </button>
        </div>
        <DrawerNav daemon={navDaemon} rail={rail} />
        {/* THE LIST SLOT: the ferret list (its Mine / All / Agents header and rows) is drawn here, whole; the rail has no room for it. */}
        {rail || !listed || plan.side.at !== 'left' || holds === undefined || daemon === undefined ? null : (
          <div className="fy-drawer__list" data-slot="side">
            <SideBody daemon={daemon} holds={holds} />
          </div>
        )}
      </aside>
    </>
  );
}

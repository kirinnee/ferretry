/**
 * ACTIONS ▾ — the session header's one place for doing things to a ferret.
 *
 * A dropdown on every width (rows grow to 44px on a phone), drawn from the registry's sections: a
 * small heading per group, an icon per row, the row's fact at its end. Three behaviours the shared
 * `ContextMenu` does not have, which is why this is its own component rather than a prop on that one:
 *
 *   - GROUPS, as `role="group"` with a visible label, because a flat list of eleven actions is a list
 *     nobody scans;
 *   - INLINE CONFIRM: a destructive row turns into its question and two buttons IN PLACE — no modal,
 *     no `confirm()` — and the menu stays open until one of them is chosen;
 *   - FORMS: a "…" row closes the menu and opens its form in a popover under the button (desktop) or
 *     the app's bottom sheet (phone), with the form's own focus and Escape.
 *
 * KEYBOARD, the menu-button pattern: focus lands on the first row, Up/Down/Home/End move, Enter and
 * Space choose, Escape and Tab close and give focus back to the button. Escape takes one layer at a
 * time through the app's escape stack, so an Escape in a confirm cancels the confirm first.
 */

import { ChevronDown, LoaderCircle } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import { cn } from '../../lib/class-names.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { ActionDrawer } from './action-drawer.tsx';
import {
  findSessionAction,
  type SessionActionEntry,
  type SessionActionFormHost,
  type SessionActionSection,
} from './registry.ts';
import { useActionMenu } from './use-action-menu.ts';

export interface ActionsMenuProps {
  readonly sections: readonly SessionActionSection[];
  /** Phone layout: 44px rows, forms in a sheet, an icon-only trigger. */
  readonly compact: boolean;
  /** Whose actions these are, for the menu's accessible name: "Hadi actions". */
  readonly name: string;
  /** The open form's action id, or null. The page owns it so Info can open a form too. */
  readonly form: string | null;
  readonly onFormChange: (actionId: string | null) => void;
  /** A failed action, said by the page's one alert line. */
  readonly onFailure?: (sentence: string, detail?: string, reason?: unknown) => void;
  /** What a form settled, said by the page's toast. */
  readonly onNotice?: (sentence: string) => void;
}

/** Where the dropdown and the popover hang: under the button, right edges aligned, never off screen. */
interface Placement {
  readonly top: number;
  readonly right: number;
}

const placementUnder = (button: HTMLElement | null): Placement => {
  const rect = button?.getBoundingClientRect();
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  return {
    top: Math.round((rect?.bottom ?? 0) + 6),
    right: Math.max(8, Math.round(width - (rect?.right ?? width))),
  };
};

export function ActionsMenu({ sections, compact, name, form, onFormChange, onFailure, onNotice }: ActionsMenuProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ top: 0, right: 8 });

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);
  const { menuRef, confirming, setConfirming, pending, choose, confirmRun, onMenuKey } = useActionMenu({
    open,
    close,
    insideRef: buttonRef,
    onFailure,
    openForm: id => {
      close(false);
      setPlacement(placementUnder(buttonRef.current));
      onFormChange(id);
    },
  });

  const toggle = (): void => {
    if (open) {
      close(false);
      return;
    }
    setPlacement(placementUnder(buttonRef.current));
    setConfirming(null);
    setOpen(true);
  };

  const formEntry = form === null ? undefined : findSessionAction(sections, form);
  const shownForm = formEntry?.kind === 'form' ? formEntry : undefined;
  const formHost: SessionActionFormHost = {
    close: () => onFormChange(null),
    open: id => onFormChange(id),
    notify: sentence => onNotice?.(sentence),
    compact,
  };

  // The menu button is what opened a drawer, and the menu that held it closed on the way: hand focus back
  // to the button once the drawer is gone, so a keyboard reader lands where they started.
  const drawerOpen = shownForm?.presentation === 'drawer';
  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (wasDrawerOpen.current && !drawerOpen) buttonRef.current?.focus();
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen]);

  return (
    <>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={compact ? 'Actions' : undefined}
        className={cn('fy-actions-trigger kt-btn kt-btn--sm', compact && 'fy-actions-trigger--compact')}
        data-session-actions-trigger=""
        onClick={toggle}
        ref={buttonRef}
        type="button"
      >
        {compact ? null : <span>Actions</span>}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? (
        <div
          aria-label={`${name} actions`}
          className="fy-actions-menu kt-panel"
          data-compact={compact ? '' : undefined}
          data-session-actions-menu=""
          id={menuId}
          onKeyDown={onMenuKey}
          ref={menuRef}
          role="menu"
          style={{ top: placement.top, right: placement.right }}
        >
          <ActionSections
            confirming={confirming}
            onCancel={() => setConfirming(null)}
            onChoose={choose}
            onConfirm={confirmRun}
            pending={pending}
            sections={sections}
          />
        </div>
      ) : null}
      {shownForm === undefined ? null : shownForm.presentation === 'drawer' ? (
        <ActionDrawer
          compact={compact}
          heading={shownForm.heading}
          onClose={formHost.close}
          title={shownForm.title}
          top={placement.top - 6}
        >
          {shownForm.render(formHost)}
        </ActionDrawer>
      ) : compact ? (
        <BottomSheet
          ariaLabel={shownForm.title}
          closeLabel={`Close ${shownForm.title}`}
          id={`${menuId}-form`}
          onClose={formHost.close}
          open
          panelClassName="bg-surface"
        >
          <div className="min-h-0 flex-1 overflow-y-auto" data-session-action-sheet="">
            <ActionForm entry={shownForm} host={formHost} />
          </div>
        </BottomSheet>
      ) : (
        <ActionPopover onClose={formHost.close} placement={placement} title={shownForm.title}>
          <ActionForm entry={shownForm} host={formHost} />
        </ActionPopover>
      )}
    </>
  );
}

/** The menu's groups, rows and inline confirms — drawn identically by every surface that shows them. */
export function ActionSections({
  sections,
  confirming,
  pending,
  onChoose,
  onConfirm,
  onCancel,
}: {
  readonly sections: readonly SessionActionSection[];
  readonly confirming: string | null;
  readonly pending: string | null;
  readonly onChoose: (entry: SessionActionEntry) => void;
  readonly onConfirm: (entry: Extract<SessionActionEntry, { kind: 'confirm' }>) => void;
  readonly onCancel: () => void;
}) {
  return (
    <>
      {sections.map(section => (
        <div className="fy-actions-menu__section" key={section.group} role="none">
          <div aria-hidden="true" className="fy-actions-menu__group">
            {section.label}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA menu pattern groups menu items with role=group; a fieldset is a form grouping and would be announced as one */}
          <div aria-label={section.label} role="group">
            {section.entries.map(entry =>
              entry.kind === 'confirm' && confirming === entry.id ? (
                <ConfirmRow entry={entry} key={entry.id} onCancel={onCancel} onConfirm={() => onConfirm(entry)} />
              ) : (
                <MenuRow entry={entry} key={entry.id} onChoose={() => onChoose(entry)} pending={pending === entry.id} />
              ),
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export function MenuRow({
  entry,
  onChoose,
  pending,
}: {
  readonly entry: SessionActionEntry;
  readonly onChoose: () => void;
  readonly pending: boolean;
}) {
  const Icon = entry.icon;
  const unavailable = entry.unavailable !== undefined;
  return (
    <button
      {...(entry.kind === 'toggle' ? { 'aria-checked': entry.checked } : {})}
      aria-disabled={unavailable ? true : undefined}
      className="fy-actions-menu__row"
      data-danger={entry.danger ? '' : undefined}
      data-menu-row=""
      data-session-action-item={entry.id}
      onClick={onChoose}
      role={entry.kind === 'toggle' ? 'menuitemcheckbox' : 'menuitem'}
      tabIndex={-1}
      title={entry.unavailable}
      type="button"
    >
      {pending ? (
        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} />
      ) : (
        <Icon aria-hidden="true" size={16} />
      )}
      <span className="fy-actions-menu__label">{entry.label}</span>
      {entry.kind === 'toggle' ? (
        <span className="fy-actions-menu__detail">
          {entry.checked ? 'On' : 'Off'}
          <span aria-hidden="true" className="fy-actions-switch" data-on={entry.checked ? '' : undefined} />
        </span>
      ) : entry.detail === undefined && entry.unavailable === undefined ? null : (
        <span className="fy-actions-menu__detail">{entry.detail ?? entry.unavailable}</span>
      )}
    </button>
  );
}

export function ConfirmRow({
  entry,
  onConfirm,
  onCancel,
}: {
  readonly entry: Extract<SessionActionEntry, { kind: 'confirm' }>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a confirm inside a menu is a group of menu items, not a form fieldset
    <div aria-label={entry.question} className="fy-actions-confirm" data-menu-confirm={entry.id} role="group">
      <p className="fy-actions-confirm__text">
        <strong>{entry.question}</strong> {entry.consequence}
      </p>
      <div className="fy-actions-confirm__buttons">
        <button
          className="kt-btn kt-btn--sm"
          data-menu-confirm-yes=""
          data-variant={entry.danger ? 'danger' : 'primary'}
          onClick={onConfirm}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          {entry.confirmLabel}
        </button>
        <button className="kt-btn kt-btn--sm" onClick={onCancel} role="menuitem" tabIndex={-1} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ActionForm({
  entry,
  host,
}: {
  readonly entry: Extract<SessionActionEntry, { kind: 'form' }>;
  readonly host: SessionActionFormHost;
}) {
  return (
    <div className="fy-action-form" data-session-action-form={entry.id}>
      <h2 className="fy-action-form__title">{entry.title}</h2>
      {entry.render(host)}
    </div>
  );
}

/** The desktop form frame: hangs under Actions, takes focus, closes on Escape — never on a stray click. */
export function ActionPopover({
  title,
  placement,
  onClose,
  children,
}: {
  readonly title: string;
  readonly placement: Placement;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  return (
    <div
      aria-label={title}
      className="fy-action-popover kt-panel"
      data-session-action-popover=""
      onKeyDown={onKeyDown}
      ref={ref}
      role="dialog"
      style={{ top: placement.top, right: placement.right }}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

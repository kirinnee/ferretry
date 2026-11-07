/**
 * THE SAME ACTIONS, OPENED FROM A ROW: a menu at the pointer on a desktop, a bottom sheet under a
 * thumb on a phone. It draws the registry's sections through the pieces Actions ▾ draws them with —
 * groups, inline confirms, the dimmed "why not" — and shares its keyboard and dismissal with it
 * (`useActionMenu`). What differs is only where it sits: at an anchor clamped inside the viewport, or
 * in the app's one bottom sheet. A "…" row opens its form the same two ways.
 */

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { clampMenuPosition, type MenuAnchor, type MenuPosition } from '../../shell/context-menu.tsx';
import { ActionDrawer } from './action-drawer.tsx';
import { ActionForm, ActionSections } from './actions-menu.tsx';
import { findSessionAction, type SessionActionFormHost, type SessionActionSection } from './registry.ts';
import { useActionMenu } from './use-action-menu.ts';

export interface ContextActionsMenuProps {
  readonly sections: readonly SessionActionSection[];
  /** Whose actions these are: "Hadi actions". */
  readonly name: string;
  /** Where the press landed, in viewport coordinates. */
  readonly anchor: MenuAnchor;
  /** A touch press: the sheet, with 44px rows. */
  readonly touch: boolean;
  /** Closes the menu; `restoreFocus` hands focus back to the row that opened it. */
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onFailure?: (sentence: string, detail?: string, reason?: unknown) => void;
  readonly onNotice?: (sentence: string) => void;
}

/**
 * THE LIFT OF THE FINGER THAT OPENED THE SHEET. A long-press ends in a click wherever the finger comes up,
 * and the sheet is already there — so that click lands on its scrim and closes it the instant it opened.
 * The first click is swallowed unless a new press has begun since (a deliberate tap on the scrim).
 */
const useSwallowTrailingClick = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    let trailing = true;
    const fresh = (): void => {
      trailing = false;
    };
    const swallow = (event: MouseEvent): void => {
      if (!trailing) return;
      trailing = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', fresh, true);
    document.addEventListener('click', swallow, true);
    return () => {
      document.removeEventListener('pointerdown', fresh, true);
      document.removeEventListener('click', swallow, true);
    };
  }, [active]);
};

export function ContextActionsMenu({
  sections,
  name,
  anchor,
  touch,
  onClose,
  onFailure,
  onNotice,
}: ContextActionsMenuProps) {
  const id = useId();
  const [form, setForm] = useState<string | null>(null);
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const close = useCallback((restoreFocus: boolean) => onClose(restoreFocus), [onClose]);
  useSwallowTrailingClick(touch);
  const { menuRef, confirming, setConfirming, pending, choose, confirmRun, onMenuKey } = useActionMenu({
    open: form === null,
    close,
    onFailure,
    openForm: setForm,
    dismissOnOutside: !touch,
  });

  const measured = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = measured.current;
    if (touch || element === null) return;
    const next = { width: element.offsetWidth, height: element.offsetHeight };
    setSize(current => (current?.width === next.width && current.height === next.height ? current : next));
  });
  const position: MenuPosition | null =
    touch || size === null
      ? null
      : clampMenuPosition(anchor, size, { width: window.innerWidth, height: window.innerHeight });
  const placed = { left: position?.left ?? anchor.x, top: position?.top ?? anchor.y };

  const formEntry = form === null ? undefined : findSessionAction(sections, form);
  const shownForm = formEntry?.kind === 'form' ? formEntry : undefined;
  const host: SessionActionFormHost = {
    close: () => onClose(true),
    open: setForm,
    notify: sentence => onNotice?.(sentence),
    compact: touch,
  };

  const list = (
    <ActionSections
      confirming={confirming}
      onCancel={() => setConfirming(null)}
      onChoose={choose}
      onConfirm={confirmRun}
      pending={pending}
      sections={sections}
    />
  );

  if (shownForm?.presentation === 'drawer') {
    return (
      <ActionDrawer compact={touch} heading={shownForm.heading} onClose={host.close} title={shownForm.title}>
        {shownForm.render(host)}
      </ActionDrawer>
    );
  }

  if (shownForm !== undefined) {
    const body = (
      <div data-session-action-sheet="">
        <ActionForm entry={shownForm} host={host} />
      </div>
    );
    return touch ? (
      <BottomSheet
        ariaLabel={shownForm.title}
        closeLabel={`Close ${shownForm.title}`}
        id={`${id}-form`}
        onClose={host.close}
        open
        panelClassName="bg-surface"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </BottomSheet>
    ) : (
      <FormPopover measured={measured} onClose={host.close} style={placed} title={shownForm.title}>
        {body}
      </FormPopover>
    );
  }

  if (touch) {
    return (
      <BottomSheet
        ariaLabel={`${name} actions`}
        closeLabel="Close actions"
        id={`${id}-sheet`}
        onClose={() => onClose(true)}
        maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
        open
        panelClassName="bg-surface"
      >
        <div
          aria-label={`${name} actions`}
          className="fy-actions-menu fy-actions-menu--sheet min-h-0 flex-1 overflow-y-auto"
          data-compact=""
          data-session-actions-menu=""
          onKeyDown={onMenuKey}
          ref={menuRef}
          role="menu"
        >
          {list}
        </div>
      </BottomSheet>
    );
  }

  return (
    <div
      aria-label={`${name} actions`}
      className="fy-actions-menu fy-actions-menu--at kt-panel"
      data-session-actions-menu=""
      onKeyDown={onMenuKey}
      ref={node => {
        menuRef.current = node;
        measured.current = node;
      }}
      role="menu"
      style={{ ...placed, opacity: position === null ? 0 : 1 }}
    >
      {list}
    </div>
  );
}

/** A form's frame at the press: takes focus, closes on Escape, never on a stray click. */
function FormPopover({
  title,
  style,
  measured,
  onClose,
  children,
}: {
  readonly title: string;
  readonly style: CSSProperties;
  readonly measured: RefObject<HTMLDivElement | null>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { onKeyDown } = useDialogFocus(true, measured, onClose);
  return (
    <div
      aria-label={title}
      className="fy-action-popover fy-action-popover--at kt-panel"
      data-session-action-popover=""
      onKeyDown={onKeyDown}
      ref={measured}
      role="dialog"
      style={style}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

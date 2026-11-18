/**
 * THE FERRET'S ACTIONS — the header menu's DO half, drawn as plain rows in the ferret's one menu (Conversation's Modes
 * button), not as a dropdown of their own.
 *
 * Drawn from the registry's sections: a small heading per group, an icon per row, the row's fact at its end. Two
 * behaviours the shared `ContextMenu` does not have, which is why this is its own component:
 *
 *   - GROUPS, as `role="group"` with a visible label, because a flat list of eleven actions is a list nobody scans;
 *   - INLINE CONFIRM: a destructive row turns into its question and two buttons IN PLACE — no modal, no `confirm()`;
 *   - FORMS: a "…" row puts the menu away and opens its form in a popover (desktop) or the app's bottom sheet (phone),
 *     with the form's own focus and Escape. The form is drawn through {@link Floating}, so it is on the screen, not
 *     boxed in the menu's sheet, and it outlives the menu being shut.
 */

import { type ReactNode, useRef } from 'react';
import { BottomSheet, Floating, useDialogFocus, useDismissSurface } from '../../ui.ts';
import {
  findFerretAction,
  type FerretActionEntry,
  type FerretActionFormHost,
  type FerretActionSection,
} from './registry.ts';
import { useActionMenu } from './use-action-menu.ts';
import { LoaderCircle } from 'lucide-react';

export interface ActionsMenuProps {
  readonly sections: readonly FerretActionSection[];
  /** Phone layout: 44px rows, forms in a sheet. */
  readonly compact: boolean;
  /** Whose actions these are, for the list's accessible name: "Hadi actions". */
  readonly name: string;
  /** The open form's action id, or null. The page owns it so Info can open a form too. */
  readonly form: string | null;
  readonly onFormChange: (actionId: string | null) => void;
  /** A failed action, said by the page's one alert line. */
  readonly onFailure?: (sentence: string, detail?: string, reason?: unknown) => void;
  /** What a form settled, said by the page's toast. */
  readonly onNotice?: (sentence: string) => void;
}

/** Where a desktop form hangs: under the header, at the right edge, never off screen. */
const FORM_PLACEMENT = { top: 56, right: 12 } as const;

export function ActionsMenu({ sections, compact, name, form, onFormChange, onFailure, onNotice }: ActionsMenuProps) {
  const dismissSurface = useDismissSurface();
  const { confirming, setConfirming, pending, choose, confirmRun } = useActionMenu({
    // The rows are always on the screen while the menu is, so nothing here opens or closes a dropdown: a chosen row
    // puts the menu away and the act runs, a "…" row opens its form.
    open: false,
    close: dismissSurface,
    onFailure,
    openForm: id => {
      dismissSurface();
      onFormChange(id);
    },
  });

  const formEntry = form === null ? undefined : findFerretAction(sections, form);
  const shownForm = formEntry?.kind === 'form' ? formEntry : undefined;
  const formHost: FerretActionFormHost = {
    close: () => onFormChange(null),
    open: id => onFormChange(id),
    notify: sentence => onNotice?.(sentence),
    compact,
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a group of rows with a visible heading each; a fieldset is a form grouping and would be announced as one */}
      <div
        aria-label={`${name} actions`}
        className="fy-actions-inline"
        data-compact={compact ? '' : undefined}
        data-ferret-actions-menu=""
        role="group"
      >
        <ActionSections
          confirming={confirming}
          onCancel={() => setConfirming(null)}
          onChoose={choose}
          onConfirm={confirmRun}
          pending={pending}
          sections={sections}
          tabbable
        />
      </div>
      {shownForm === undefined ? null : (
        <Floating>
          {compact ? (
            <BottomSheet
              ariaLabel={shownForm.title}
              closeLabel={`Close ${shownForm.title}`}
              id={`fy-form-${shownForm.id}`}
              onClose={formHost.close}
              open
              panelClassName="bg-surface"
            >
              <div className="min-h-0 flex-1 overflow-y-auto" data-ferret-action-sheet="">
                <ActionForm entry={shownForm} host={formHost} />
              </div>
            </BottomSheet>
          ) : (
            <ActionPopover onClose={formHost.close} placement={FORM_PLACEMENT} title={shownForm.title}>
              <ActionForm entry={shownForm} host={formHost} />
            </ActionPopover>
          )}
        </Floating>
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
  tabbable = false,
}: {
  readonly sections: readonly FerretActionSection[];
  /** Rows that are plain buttons in the page's tab order (the header's menu), not the items of a roving-focus menu. */
  readonly tabbable?: boolean;
  readonly confirming: string | null;
  readonly pending: string | null;
  readonly onChoose: (entry: FerretActionEntry) => void;
  readonly onConfirm: (entry: Extract<FerretActionEntry, { kind: 'confirm' }>) => void;
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
                <ConfirmRow
                  entry={entry}
                  key={entry.id}
                  onCancel={onCancel}
                  onConfirm={() => onConfirm(entry)}
                  tabbable={tabbable}
                />
              ) : (
                <MenuRow
                  entry={entry}
                  key={entry.id}
                  onChoose={() => onChoose(entry)}
                  pending={pending === entry.id}
                  tabbable={tabbable}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function MenuRow({
  entry,
  onChoose,
  pending,
  tabbable,
}: {
  readonly entry: FerretActionEntry;
  readonly onChoose: () => void;
  readonly pending: boolean;
  readonly tabbable: boolean;
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
      data-ferret-action-item={entry.id}
      onClick={onChoose}
      role={entry.kind === 'toggle' ? (tabbable ? 'switch' : 'menuitemcheckbox') : tabbable ? undefined : 'menuitem'}
      tabIndex={tabbable ? 0 : -1}
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

function ConfirmRow({
  entry,
  onConfirm,
  onCancel,
  tabbable,
}: {
  readonly entry: Extract<FerretActionEntry, { kind: 'confirm' }>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly tabbable: boolean;
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
          role={tabbable ? undefined : 'menuitem'}
          tabIndex={tabbable ? 0 : -1}
          type="button"
        >
          {entry.confirmLabel}
        </button>
        <button
          className="kt-btn kt-btn--sm"
          onClick={onCancel}
          role={tabbable ? undefined : 'menuitem'}
          tabIndex={tabbable ? 0 : -1}
          type="button"
        >
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
  readonly entry: Extract<FerretActionEntry, { kind: 'form' }>;
  readonly host: FerretActionFormHost;
}) {
  return (
    <div className="fy-action-form" data-ferret-action-form={entry.id}>
      <h2 className="fy-action-form__title">{entry.title}</h2>
      {entry.render(host)}
    </div>
  );
}

/** The desktop form frame: hangs under the header, takes focus, closes on Escape — never on a stray click. */
function ActionPopover({
  title,
  placement,
  onClose,
  children,
}: {
  readonly title: string;
  readonly placement: { readonly top: number; readonly right: number };
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  return (
    <div
      aria-label={title}
      className="fy-action-popover kt-panel"
      data-ferret-action-popover=""
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

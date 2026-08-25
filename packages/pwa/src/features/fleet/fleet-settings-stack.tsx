/**
 * The settings an account applies, in the order they apply, with the order on screen.
 *
 * ONE CONTROL, TWO SURFACES. The new-account sequence and the edit-one-account form both compose a
 * settings stack, and a stack whose ORDER is the whole mechanism cannot be rendered two ways: the two
 * would drift, and the way they drift is that one of them shows a precedence the change does not send.
 * So the part that must not drift lives here — the numbered list, the per-entry editors, and the
 * statement of which entry decided each key — and each surface adds the halves only it has the facts
 * for. The stepper is handed this fleet's store and the harness, so it offers "pick one" and "write a
 * new one" above this. The edit form is handed neither, so it offers what needs neither.
 *
 * WHY A LIST AND NOT A BOX. `settings` has always been a stack on the wire, deep-merged left to right,
 * an entry being either a document reference or an inline object. The box this replaces could express
 * the last entry of that stack and nothing else, so the composition the fleet already performed was
 * invisible and unreachable from a browser — which is the thing being fixed, not the mechanism.
 *
 * THE WORD FOR THE MECHANISM IS NOT ON THIS SCREEN. It is the one the owner called "way too
 * complicated", and it is not needed: "these apply in order, and a later one wins" says the same thing
 * to somebody who has never read the schema.
 */

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { cn } from '../../lib/class-names.ts';
import { FIELD_LABEL } from '../../shell/panel-typography.tsx';
import type { FleetLayerDraft, FleetSettingsDraft } from './fleet-change-model.ts';
import type { FleetHarnessKind } from './fleet-model.ts';
import {
  SETTINGS_DOCUMENT,
  settingsEntryLabel,
  settingsOrigins,
  unreadSettings,
  withInlineSettings,
  withoutSettings,
  withSettingsMoved,
  withSettingsText,
} from './fleet-stepper-model.ts';

/** What each kind of entry IS, and what applying it writes. One table, so no card is unexplained. */
const ENTRY_DETAIL: Readonly<Record<FleetSettingsDraft['source'], string>> = {
  store: 'A document this fleet already has. Applying references it; nothing rewrites it from here.',
  new: 'Written by this change, and added to this fleet’s store. The next account you create can pick it.',
  inline: 'Typed here and kept in the fleet’s own configuration. No file is created for it.',
};

/**
 * WHAT KIND of entry each row is, where the row's own label does not already say it.
 *
 * `inline` has no badge, and that is the point of the table being partial rather than total: an inline
 * entry has no path, so its label IS its kind — and the version that badged it rendered
 * `typed here [typed here]`, the same two words twice on one line.
 */
const ENTRY_BADGE: Readonly<Partial<Record<FleetSettingsDraft['source'], string>>> = {
  store: 'in the store',
  new: 'new',
};

export interface FleetSettingsOrderProps {
  readonly layer: FleetLayerDraft;
  readonly onChange: (next: FleetLayerDraft) => void;
  readonly disabled: boolean;
  /**
   * The harness whose format these documents are read in, or `null` where this screen was not told.
   *
   * `null` is a real state rather than a default: the edit form is handed a wrapper name and nothing
   * else, and inferring the harness from that name is exactly the guess this feature refuses to make
   * everywhere else. What it costs is narrow and is said out loud — a document written for a harness
   * this screen cannot name is a document whose keys it will not claim to have read.
   */
  readonly harness: FleetHarnessKind | null;
  /** Marks this control in the DOM so a test and a capture can find one stack among several. */
  readonly name: string;
}

/**
 * The stack itself: what applies, in what order, and what each entry decided.
 *
 * An empty stack is not an empty control. "This account adds nothing of its own" is the ordinary
 * answer and the one a member gets with no work at all, so it is stated rather than left as a blank
 * area somebody has to interpret.
 */
export function FleetSettingsOrder({ layer, onChange, disabled, harness, name }: FleetSettingsOrderProps) {
  const uid = useId();
  const id = (suffix: string): string => `${uid}${suffix}`;
  /**
   * Removing a row unmounts the button that was clicked, so the browser drops focus to `<body>` and a
   * keyboard reader loses the form. Focus goes to the one control every removal leaves standing, which
   * is also the one a person reaches for next.
   */
  const addRef = useRef<HTMLButtonElement | null>(null);
  const entries = layer.settings;
  const origins = settingsOrigins(layer, harness);
  const unread = unreadSettings(layer, harness);
  const inlineHeld = entries.some(entry => entry.source === 'inline');

  const remove = (entryId: string): void => {
    onChange(withoutSettings(layer, entryId));
    addRef.current?.focus();
  };

  return (
    <div className="grid min-w-0 gap-3" data-fleet-settings-stack={name}>
      {entries.length === 0 ? (
        <p className="m-0 text-meta leading-base text-muted" data-fleet-settings-empty="">
          {/* "Nothing here is required", not "everything below is optional": this control sits under
              the picker on one surface and is the whole section on the other, so "below" names a
              different set of controls depending on which screen you are reading it on. */}
          This account adds no settings of its own, so it gets whatever this fleet already composes for its accounts.
          That is a working account — nothing here is required.
        </p>
      ) : (
        <>
          <p className="m-0 text-cell font-medium text-fg">These apply in order</p>
          <ol className="m-0 grid list-none gap-2 p-0">
            {entries.map((entry, index) => (
              <li
                key={entry.id}
                className="min-w-0 rounded-control border border-border bg-surface-2 p-3"
                data-fleet-settings-entry={settingsEntryLabel(entry)}
              >
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <span
                    className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-control bg-surface-3 text-meta font-semibold text-muted"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-2">
                      <span
                        className={cn(
                          'min-w-0 break-words text-ui font-semibold text-fg',
                          entry.source === 'inline' ? '' : 'font-mono',
                        )}
                      >
                        {settingsEntryLabel(entry)}
                      </span>
                      {ENTRY_BADGE[entry.source] === undefined ? null : (
                        <span className="shrink-0 rounded-control bg-surface-3 px-1.5 py-0.5 text-meta text-muted">
                          {ENTRY_BADGE[entry.source]}
                        </span>
                      )}
                    </p>
                    <p className="m-0 mt-0.5 min-w-0 break-words text-meta leading-base text-muted">
                      {ENTRY_DETAIL[entry.source]}
                      {/* Not on the LAST row, because there is nothing below it to lose to. A stack of
                          one is the same case: its only row is also its last. */}
                      {index === entries.length - 1 ? '' : ' A later one below wins where they set the same key.'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <button
                      type="button"
                      className="kt-btn kt-btn--sm"
                      data-fleet-settings-up={settingsEntryLabel(entry)}
                      disabled={disabled || index === 0}
                      aria-label={`Apply ${settingsEntryLabel(entry)} earlier`}
                      onClick={() => onChange(withSettingsMoved(layer, entry.id, -1))}
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="kt-btn kt-btn--sm"
                      data-fleet-settings-down={settingsEntryLabel(entry)}
                      disabled={disabled || index === entries.length - 1}
                      aria-label={`Apply ${settingsEntryLabel(entry)} later`}
                      onClick={() => onChange(withSettingsMoved(layer, entry.id, 1))}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="kt-btn kt-btn--sm"
                      data-variant="danger"
                      data-fleet-settings-remove={settingsEntryLabel(entry)}
                      disabled={disabled}
                      aria-label={`Stop applying ${settingsEntryLabel(entry)}`}
                      onClick={() => remove(entry.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {/* A REFERENCE HAS NO BOX, and that is the honest rendering rather than a missing
                    feature: this browser has not read that document, so an empty box beside it would
                    read as its contents and saving would replace it with nothing. */}
                {entry.source === 'store' ? null : (
                  <div className="mt-3">
                    <label className={FIELD_LABEL} htmlFor={id(`-text-${entry.id}`)}>
                      {entry.source === 'inline'
                        ? 'Settings JSON'
                        : `Contents${harness === null ? '' : ` (${SETTINGS_DOCUMENT[harness].format})`}`}
                    </label>
                    <textarea
                      id={id(`-text-${entry.id}`)}
                      className="kt-input min-h-[6rem] font-mono"
                      rows={6}
                      value={entry.text}
                      disabled={disabled}
                      placeholder={'{\n  "model": "opus"\n}'}
                      data-fleet-settings-text={settingsEntryLabel(entry)}
                      onChange={event => onChange(withSettingsText(layer, entry.id, event.target.value))}
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      <div>
        <button
          type="button"
          ref={addRef}
          className="kt-btn kt-btn--sm"
          data-fleet-settings-add-inline=""
          disabled={disabled || inlineHeld}
          onClick={() => onChange(withInlineSettings(layer, crypto.randomUUID()))}
        >
          <Plus size={14} aria-hidden="true" />
          Type settings here
        </button>
        <p className="m-0 mt-1 text-meta leading-base text-muted" data-fleet-settings-inline-note="">
          {inlineHeld
            ? 'One block of typed settings, and it is in the list above. Anything more wants a document, and a document has a name.'
            : 'A couple of keys for this account, kept in the fleet’s configuration rather than in a file.'}
        </p>
      </div>

      {/* WHERE EACH KEY CAME FROM. The reason this control exists at all: a composed value whose
          origin cannot be explained is worse than no composition. It is derived from the same entries
          the change sends, folded by the same rule the daemon merges them by, so it cannot claim an
          order the apply will not follow. */}
      {origins.length === 0 && unread.length === 0 ? null : (
        <div className="rounded-control bg-surface-2 p-3" data-fleet-settings-result="">
          <p className="m-0 text-cell font-medium text-fg">What this account ends up with</p>
          {origins.length === 0 ? null : (
            <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
              {origins.map(origin => (
                <li
                  key={origin.key}
                  className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta leading-base"
                  data-fleet-settings-origin={origin.key}
                >
                  <span className="min-w-0 break-words font-mono text-fg">{origin.key}</span>
                  <span className="min-w-0 break-words text-muted">from {origin.from}</span>
                </li>
              ))}
            </ul>
          )}
          {unread.length === 0 ? null : (
            <p
              className="m-0 mt-1 text-meta leading-base text-muted"
              data-fleet-settings-unread={String(unread.length)}
            >
              {unread.length === 1 ? 'One entry is not read here' : `${unread.length} entries are not read here`} —{' '}
              {unread.join(', ')}. Whatever they set applies where they sit in the order above; this screen cannot list
              their keys.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

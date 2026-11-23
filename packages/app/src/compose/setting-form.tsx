/**
 * The Settings FORM kit: the pieces a value (a number, a word, a prompt) is edited and saved with.
 *
 * ONE SAVE MODEL PER KIND OF SETTING (C59 O8-10; Geist, Material 3 and Primer say the same):
 *   a CHOICE (switch, segmented, select, option cards)  takes effect NOW, no Save button next to it  -> `SettingGroup saves="now"`
 *   a VALUE (text, number, textarea, a set of fields)   is saved by ONE Save bar at the foot of its form -> `SettingGroup saves="on-save"`
 *   an ACTION (Test, Install, Update)                   is a verb button, apart from the controls that hold state
 *   a RISKY act                                         is a danger button with its consequence said in words
 * A switch never sits in a form that a button saves (a switch takes effect now; a checkbox is saved with the form).
 *
 *   SettingSaveBar  the form's foot, drawn from the first paint: what state the form is in (nothing to save / unsaved / saving / saved /
 *                   the sentence that says why it did not save) on the left, Discard and Save on the right. Sticky at the foot of the
 *                   scroll area while its form is on screen, so a long form never hides its own Save.
 *   SettingField    one value field: its label above, the one-line help below, and the error IN PLACE of the help (no layout shift).
 */

import { type ReactNode, useId } from 'react';
import { Button } from '../ui/primitives.tsx';
import { cn } from '../ui/lib/class-names.ts';
import { useReportUnsaved } from './unsaved-guard.tsx';

export * from './unsaved-guard.tsx';

/** What a form's Save bar says, as one word: what `data-state` carries and a test reads. */
export type SettingFormState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface SettingSaveBarProps {
  /** Something is typed that is not saved. */
  readonly dirty: boolean;
  readonly saving?: boolean;
  /** The last Save landed and nothing has changed since. */
  readonly saved?: boolean;
  /** Why the last Save did not land (one sentence); replaces the state words. */
  readonly error?: string | null;
  /** The form cannot be saved as typed (a value out of its range, the machine offline): Save stays off, Discard stays on. */
  readonly blocked?: boolean;
  /** What Save does, in words ("Save budget"); never a bare "Submit". */
  readonly saveLabel?: string;
  readonly discardLabel?: string;
  /** What the bar says once saved, when the page has more to say than "Saved" ("Saved — in effect now."). */
  readonly savedWords?: string;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  /** `data-*` on the Save button / the Discard button / the bar, for a stylesheet or a test that reads them. */
  readonly saveMarks?: Readonly<Record<`data-${string}`, string>>;
  readonly discardMarks?: Readonly<Record<`data-${string}`, string>>;
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
  /** `data-*` on the state words themselves ("Saved"), for a test that reads that sentence. */
  readonly wordsMarks?: Readonly<Record<`data-${string}`, string>>;
  /** Anything else the foot carries (a second action beside Save). */
  readonly children?: ReactNode;
}

const stateOf = ({ dirty, saving, saved, error }: SettingSaveBarProps): SettingFormState =>
  saving === true
    ? 'saving'
    : error !== undefined && error !== null
      ? 'failed'
      : dirty
        ? 'dirty'
        : saved === true
          ? 'saved'
          : 'clean';

const STATE_WORDS: Readonly<Record<Exclude<SettingFormState, 'failed'>, string>> = {
  clean: 'Nothing to save',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
};

export function SettingSaveBar(props: SettingSaveBarProps) {
  const {
    dirty,
    saving = false,
    error = null,
    blocked = false,
    saveLabel = 'Save',
    discardLabel = 'Discard changes',
    savedWords = STATE_WORDS.saved,
    onSave,
    onDiscard,
    children,
  } = props;
  // The shell's guard asks before leaving a page whose form is dirty; the bar reports it, so no page wires it.
  useReportUnsaved(dirty);
  const state = stateOf(props);
  const words = state === 'failed' ? error : state === 'saved' ? savedWords : STATE_WORDS[state];
  return (
    <div
      data-setting-savebar=""
      data-state={state}
      {...props.marks}
      className={cn(
        // Sticky at the foot of the scroll area while its form is on screen, so a long form (the Warden's) never hides its own Save; the
        // hairline above it is the form's edge. A short form simply ends with it.
        'sticky bottom-0 z-10 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-bg px-panel py-2',
      )}
    >
      <span
        role={state === 'failed' ? 'alert' : 'status'}
        data-setting-savebar-words=""
        {...props.wordsMarks}
        className={cn(
          'min-w-0 flex-1 basis-40 break-words text-meta leading-tight',
          state === 'failed'
            ? 'text-err'
            : state === 'saved'
              ? 'text-ok'
              : state === 'dirty'
                ? 'font-semibold text-fg'
                : 'text-muted',
        )}
      >
        {words}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
        <Button
          type="button"
          variant="ghost"
          className="min-h-[44px]"
          disabled={!dirty || saving}
          onClick={onDiscard}
          {...props.discardMarks}
        >
          {discardLabel}
        </Button>
        <Button
          type="button"
          variant="primary"
          className="min-h-[44px]"
          disabled={!dirty || blocked || saving}
          onClick={onSave}
          {...props.saveMarks}
        >
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  );
}

export interface SettingFieldProps {
  readonly label: string;
  /** One short, true line under the field; shown until there is an error, which takes its place. */
  readonly help?: ReactNode;
  readonly error?: string | null;
  /** The control, given the id its label points at and the id of the line under it (the help or the error). */
  readonly children: (ids: { readonly id: string; readonly describedBy: string | undefined }) => ReactNode;
}

export function SettingField({ label, help, error = null, children }: SettingFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? help;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-setting-field="">
      <label htmlFor={id} className="text-meta font-semibold text-fg">
        {label}
      </label>
      {children({ id, describedBy: note === undefined || note === null ? undefined : noteId })}
      {note === undefined || note === null ? null : (
        <span
          id={noteId}
          role={error === null ? undefined : 'alert'}
          data-setting-field-note={error === null ? 'help' : 'error'}
          className={cn('break-words text-meta leading-tight', error === null ? 'text-muted' : 'text-err')}
        >
          {note}
        </span>
      )}
    </div>
  );
}

/** The words a group says about WHEN it saves, drawn under its heading, so nobody has to guess. */
const SAVES_WORDS = {
  now: 'Changes apply as soon as you make them.',
  'on-save': 'Changes apply when you press Save.',
} as const;
export type SettingSaves = keyof typeof SAVES_WORDS;

export function SettingSavesNote({ saves }: { readonly saves: SettingSaves }) {
  return (
    <p data-setting-saves-note="" className="m-0 mb-1 px-1 text-meta leading-tight text-muted">
      {SAVES_WORDS[saves]}
    </p>
  );
}

/**
 * The fields of ONE form. While its Save is in flight every control in it is disabled (a native `fieldset disabled`), so nothing typed
 * during a Save can be erased by the answer that replaces the draft. Wrap a form's controls in it and give it the Save bar's `saving`.
 */
export function SettingFieldset({
  saving,
  children,
  className,
}: {
  readonly saving: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <fieldset
      disabled={saving}
      aria-busy={saving || undefined}
      data-setting-fieldset=""
      className={cn('m-0 min-w-0 border-0 p-0', className)}
    >
      {children}
    </fieldset>
  );
}

/**
 * What an INSTANT setting (a switch) says about its own last change, in its own row, next to the control: "now on", or the sentence that
 * says why it did not change. Never a line somewhere else on a page where a phone cannot see it.
 */
export function SettingStatus({
  tone,
  children,
  marks,
}: {
  readonly tone: 'ok' | 'err';
  readonly children: ReactNode;
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <div className="px-panel pb-2">
      <p
        role={tone === 'err' ? 'alert' : 'status'}
        data-setting-status={tone}
        {...marks}
        className={cn('m-0 break-words text-meta leading-tight', tone === 'err' ? 'text-err' : 'text-muted')}
      >
        {children}
      </p>
    </div>
  );
}

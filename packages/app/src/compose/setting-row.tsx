/**
 * The compact Settings row kit: one row per setting, grouped under a title.
 *
 *   SettingGroup   a small uppercase label over rows divided by hairlines: ONE level of surface, never a box
 *                  in a box (`kt-groupcard--flat`), 32 px before the next group
 *                  `saves` says WHEN it saves under the heading (`now` | `on-save`); `foot` is a form's `SettingSaveBar`
 *                  (see `setting-form.tsx`: one save model per kind of setting)
 *   SettingRow     name + one-line hint in a 40 % label column (min 220 px), the control right beside it (not
 *                  at the far edge), an optional (i) that opens the long explanation, an optional preview
 *                  beside the control from 900 px, and an optional panel under the row
 *   SettingRowGrid short rows two to a line from 1,200 px (one `<li>` that holds a grid of rows)
 *   SettingSwitch  the on/off control for a row
 *   Segmented      a `role="radiogroup"` pill control, built from the theme's Auto / Light / Dark one
 *
 * A row that is a setting carries `id="settings-<settingId>"`, `data-setting-id` and `tabIndex={-1}`, so a
 * palette deep link can scroll to and focus it. Long text is never deleted: it moves behind the (i), a real
 * `aria-expanded` disclosure like `fleet/machine/switch-row.tsx`.
 *
 * On a phone (`max-md`) a `wide` control (a segmented one) wraps under the name at full width; a switch or
 * small button stays on the name's line. Every target keeps the 44px touch floor.
 */

import { ChevronRight, Info } from 'lucide-react';
import { type ReactNode, useContext, useId, useState } from 'react';
import { cn } from '../ui/lib/class-names.ts';
import { onRadioGroupKeyDown } from './choice-cards.tsx';
import { PanelTitleContext } from './panel-title.ts';
import { type SettingSaves, SettingSavesNote } from './setting-form.tsx';
/** A deep-link target id (`#setting-<id>`); each settings tab owns its own ids. */
type SettingId = string;

export interface SettingGroupProps {
  readonly label: string;
  /** A group that is one setting (Connection) carries that setting's deep-link id. */
  readonly settingId?: SettingId;
  /** WHEN this group saves, said under its heading: `now` for choices (a switch), `on-save` for values held by a Save bar. */
  readonly saves?: SettingSaves;
  /** The group's foot, inside the group: a form's `SettingSaveBar`. */
  readonly foot?: ReactNode;
  readonly children: ReactNode;
}

export function SettingGroup({ label, settingId, saves, foot, children }: SettingGroupProps) {
  const headingId = useId();
  // A group named for the tab it sits in (Codex's "Codex") is that tab: the shell's panel heading already says it once, so
  // the group keeps its name for assistive tech and draws no second heading.
  const panelTitle = useContext(PanelTitleContext);
  const titledByPanel = panelTitle !== undefined && panelTitle.trim().toLowerCase() === label.trim().toLowerCase();
  return (
    <section
      {...(titledByPanel ? { 'aria-label': label } : { 'aria-labelledby': headingId })}
      className="mb-8 min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-setting-group={label}
      {...(saves === undefined ? {} : { 'data-setting-saves': saves })}
      {...(settingId === undefined
        ? {}
        : { id: `settings-${settingId}`, 'data-setting-id': settingId, tabIndex: -1 as const })}
    >
      {titledByPanel ? null : (
        <h3 id={headingId} className="m-0 mb-1 px-1 text-meta font-semibold uppercase tracking-wide text-muted">
          {label}
        </h3>
      )}
      {saves === undefined ? null : <SettingSavesNote saves={saves} />}
      <ul className="kt-groupcard kt-groupcard--flat m-0 list-none p-0">{children}</ul>
      {foot}
    </section>
  );
}

/**
 * Short rows two to a line from 1,200 px wide, one column below. It is itself ONE list item of the group (so the
 * group's hairline rule still applies to it) and holds the rows in an inner list that draws its own hairlines.
 */
export function SettingRowGrid({ children }: { readonly children: ReactNode }) {
  return (
    <li className="min-w-0" data-setting-row-grid="">
      <ul
        className={cn(
          'm-0 grid min-w-0 list-none grid-cols-1 p-0 min-[1200px]:grid-cols-2 min-[1200px]:gap-x-8',
          '[&>li+li]:border-t [&>li+li]:border-border',
          'min-[1200px]:[&>li:nth-child(2)]:border-t-0',
        )}
      >
        {children}
      </ul>
    </li>
  );
}

export interface SettingRowProps {
  /** The setting this row is, which makes it a deep-link target. */
  readonly settingId?: SettingId;
  readonly name: string;
  /** One short, true line under the name; it wraps when it is long. */
  readonly hint?: ReactNode;
  /** The long text behind the (i). */
  readonly explanation?: ReactNode;
  /** The control, on the right. */
  readonly control?: (labelId: string) => ReactNode;
  /** A wide control (segmented) wraps under the name on a phone. */
  readonly wide?: boolean;
  /** Content under the row that is always shown, for example a list the control reveals. */
  readonly children?: ReactNode;
  /** `data-*` attributes on the row itself, for a row whose state a test or a stylesheet reads. */
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  /** A `SettingPreview`: the last column of the row on a desktop (the same place down a card), its own line under the row on a phone. */
  readonly preview?: ReactNode;
}

export function SettingRow({
  settingId,
  name,
  hint,
  explanation,
  control,
  wide = false,
  children,
  dataAttributes,
  preview,
}: SettingRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const labelId = `${id}-label`;
  const hasExplanation = explanation !== undefined && explanation !== null;
  const hasPreview = preview !== undefined && preview !== null;
  const info = hasExplanation ? (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={`${id}-more`}
      aria-label={`More about ${name}`}
      data-setting-info=""
      onClick={() => setOpen(value => !value)}
      className={cn(
        'ml-auto inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border-0 bg-transparent p-0 hover:text-fg',
        open ? 'text-accent' : 'text-muted',
      )}
    >
      <Info size={16} aria-hidden="true" />
    </button>
  ) : null;
  return (
    <li
      {...(settingId === undefined
        ? {}
        : { id: `settings-${settingId}`, 'data-setting-id': settingId, tabIndex: -1 as const })}
      data-setting-row={name}
      {...dataAttributes}
      className="fy-setting-row min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-panel pr-1">
        {/* The label column: 40 % of the row (never under 220 px), so the control sits beside it, not at the far edge. */}
        <span
          className={cn(
            'flex min-w-[min(220px,100%)] flex-col min-[900px]:basis-[40%] min-[900px]:flex-none',
            'max-[899px]:min-w-0 max-[899px]:flex-1 max-[899px]:basis-40',
            wide && 'max-md:basis-full',
          )}
        >
          <span id={labelId} className="text-ui font-semibold text-fg">
            {name}
          </span>
          {hint === undefined ? null : (
            // The hint wraps, on a desktop too: no text is ever cut off with an ellipsis and out of reach.
            <span
              className="break-words text-meta leading-tight text-muted"
              data-setting-hint=""
              {...(typeof hint === 'string' ? { title: hint } : {})}
            >
              {hint}
            </span>
          )}
        </span>
        {!hasPreview ? null : (
          <span
            className="order-last flex shrink-0 py-1 max-[899px]:basis-full min-[900px]:ml-2"
            aria-hidden="true"
            data-setting-preview-slot=""
          >
            {preview}
          </span>
        )}
        <span
          className={cn(
            // With a preview the control and the preview stay together beside the label; without one the (i) sits at the end.
            'flex items-center gap-1',
            hasPreview ? 'min-w-0 min-[900px]:flex-none' : 'min-w-fit flex-1',
            !wide && 'max-md:shrink-0 max-md:flex-none',
            // `wide` fills the phone's width under the name; the (i) stays beside it.
            wide && 'max-md:basis-full',
          )}
          data-setting-controls=""
          data-wide={wide || undefined}
        >
          {control?.(labelId)}
          {/* The (i) is always the last thing on the row, in a slot of its own: a row with no explanation keeps the
              slot empty, so every (i) and every control end in the same two columns down a card. */}
          {info ??
            (control === undefined ? null : (
              <span
                aria-hidden="true"
                // A wide control wraps under the name on a phone and takes the whole row, so the empty slot is not kept there.
                className={cn('ml-auto min-h-[44px] w-[44px] shrink-0', wide && 'max-md:hidden')}
              />
            ))}
        </span>
      </div>
      {open && hasExplanation ? (
        <div id={`${id}-more`} className="px-panel pb-3 text-cell leading-base text-muted" data-setting-explanation="">
          {explanation}
        </div>
      ) : null}
      {children}
    </li>
  );
}

export interface SettingSwitchProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly labelledBy: string;
  /** The id of the text that says why the switch is as it is, so a screen reader hears it with the switch. */
  readonly describedBy?: string;
  readonly disabled?: boolean;
}

export function SettingSwitch({ checked, onChange, labelledBy, describedBy, disabled = false }: SettingSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        data-neo-switch-track=""
        className={cn(
          'relative h-5 w-9 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          data-neo-switch-thumb=""
          className={cn(
            'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

interface SegmentedOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Shown as the option's tooltip. */
  readonly title?: string;
  /** The id of the text that says why this option is unusable, so a screen reader hears it with the radio. */
  readonly describedBy?: string;
}

export interface SegmentedProps<T extends string> {
  /** The group's accessible name. */
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (next: T) => void;
  readonly disabled?: boolean;
  /** Fill the width its parent gives (every option an equal share), so a stack of them lines up. */
  readonly fill?: boolean;
}

/**
 * Roving radios: the checked option is the one tab stop, the arrow keys move the focus only (a setting is written on
 * Enter, Space or a click, never on an arrow), and `Home` / `End` jump. `relative` on the group is load-bearing: the
 * radios are `sr-only` (absolute), and without a positioned group they escape the page's scroller and scroll the fixed
 * `.kt-shell` when focused.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  fill = false,
}: SegmentedProps<T>) {
  const group = useId();
  return (
    <div
      role="radiogroup"
      data-neo-segmented=""
      aria-label={label}
      onKeyDown={disabled ? undefined : onRadioGroupKeyDown}
      className={cn(
        'relative flex min-w-0 max-w-full gap-1 rounded-control bg-surface-2 p-1 max-md:w-full',
        fill ? 'w-full' : 'w-fit self-start',
      )}
    >
      {options.map(option => {
        const checked = option.id === value;
        return (
          <label
            key={option.id}
            title={option.title}
            className={cn(
              'flex h-auto min-h-[var(--control-h-sm)] min-w-0 cursor-pointer items-center justify-center whitespace-normal rounded-tab px-control-x py-1 text-center text-meta font-medium leading-tight transition-colors max-md:min-h-[44px] max-md:flex-1',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
              checked
                ? 'border border-transparent bg-accent-soft font-semibold text-accent'
                : 'border border-transparent text-muted hover:text-fg',
              fill && 'flex-1',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={`${group}-segmented`}
              value={option.id}
              checked={checked}
              disabled={disabled}
              tabIndex={checked ? 0 : -1}
              onChange={() => onChange(option.id)}
              className="sr-only"
              {...(option.describedBy === undefined ? {} : { 'aria-describedby': option.describedBy })}
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

export interface SettingDisclosureRowProps {
  readonly settingId?: SettingId;
  readonly name: string;
  readonly hint?: ReactNode;
  /** The current value, shown before the chevron: "3 of 6 allowed". */
  readonly value?: ReactNode;
  /** Told when it opens or closes, for a panel that should only measure or fetch while shown. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}

/** A row that is itself the disclosure: tap anywhere on it to open what it holds under it. */
export function SettingDisclosureRow({
  settingId,
  name,
  hint,
  value,
  onOpenChange,
  children,
}: SettingDisclosureRowProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li
      {...(settingId === undefined
        ? {}
        : { id: `settings-${settingId}`, 'data-setting-id': settingId, tabIndex: -1 as const })}
      data-setting-row={name}
      className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-more`}
        onClick={() => {
          setOpen(!open);
          onOpenChange?.(!open);
        }}
        className="flex min-h-[52px] w-full min-w-0 items-center gap-2 border-0 bg-transparent py-1 pl-panel pr-3 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui font-semibold text-fg">{name}</span>
          {hint === undefined ? null : <span className="text-meta leading-tight text-muted">{hint}</span>}
        </span>
        {value === undefined ? null : <span className="shrink-0 text-ui font-semibold text-fg">{value}</span>}
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={cn('shrink-0 text-muted transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div id={`${id}-more`} className="px-panel pb-3" data-setting-panel="">
          {children}
        </div>
      ) : null}
    </li>
  );
}

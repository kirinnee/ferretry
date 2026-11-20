/**
 * CHOICE CARDS: a short row of cards that is ONE answer. The one primitive every onboarding page and the settings pass
 * use, so "animate when selected" and "not full width" are fixed once.
 *
 *   <ChoiceCards label="Side" value={side} onChange={setSide}
 *     options={[{ id: 'left', title: 'Left', line: 'The menu beside your work', icon: <PanelLeft size={18} /> }, …]} />
 *
 * Built as a native `role="radiogroup"`: the radios are `sr-only`, the whole card is the label, the checked card is
 * the one tab stop, the arrow keys move the focus ONLY (`onRadioGroupKeyDown`: choosing can open a camera or save a
 * setting), Enter / Space / a click choose, and Home / End jump. The radio dot is not
 * drawn; the selected card carries the accent border, a soft fill and a check badge (`choice-cards.css`).
 *
 * On a NEW selection the card plays a 160ms scale 0.98 -> 1 (`data-pulse`). The value it was given on mount never
 * plays it, and with motion off (the OS query or Settings › Motion = reduced) `data-pulse` is never set.
 * `option.demo` is an optional mini-scene drawn above the text (a `SettingPreview`, a lottie); it is decorative.
 */

import { Check } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useMotionAllowed } from '../ui/use-motion-allowed.ts';
import './choice-cards.css';

export interface ChoiceOption {
  readonly id: string;
  readonly title: string;
  /** One short line under the title. */
  readonly line?: string;
  readonly icon?: ReactNode;
  /** A decorative mini-scene above the text. */
  readonly demo?: ReactNode;
  readonly disabled?: boolean;
}

export interface ChoiceCardsProps {
  /** The group's accessible name. */
  readonly label: string;
  readonly options: readonly ChoiceOption[];
  /** The chosen id, or `null` when nothing is chosen yet. */
  readonly value: string | null;
  readonly onChange: (next: string) => void;
  /** Cards share the row and stay at most 320px wide; `auto` is the only layout today. */
  readonly columns?: 'auto';
  readonly disabled?: boolean;
}

/**
 * After a keyboard move, show the VISIBLE label: the radio is `sr-only`, so focusing it with `preventScroll` leaves the
 * card below the window. `block: 'nearest'` moves only as far as needed (and not at all when it is already in view).
 * A pick can restyle the page (a Style card changes every type size and radius), which moves the card AFTER this runs, so the
 * reveal repeats on the next two frames, by when the new look is laid out; each repeat is a no-op once the card is in view.
 */
export function revealChoice(input: HTMLInputElement | null | undefined): void {
  if (input === null || input === undefined) return;
  input.focus({ preventScroll: true });
  const reveal = (): void => {
    if (input.isConnected) (input.closest('label') ?? input).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  reveal();
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => (reveal(), requestAnimationFrame(reveal)));
}

const MOVE_KEYS = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

/**
 * THE ONE KEY RULE for every group of radios drawn as cards or pills: the arrow keys, Home and End move the FOCUS only,
 * stopping at the ends and skipping a disabled radio; nothing is chosen until Enter, Space or a click. A native radio
 * group chooses (and so fires its change) on every arrow, which is wrong whenever choosing DOES something: opens the
 * camera, saves a setting, or sends audio to a vendor. Put this on the group's `onKeyDown`; a key from anything but a
 * radio is left alone. Space already chooses a focused radio on its own; Enter is the one this adds.
 */
export function onRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'radio') return;
  if (event.key === 'Enter') {
    event.preventDefault();
    target.click();
    return;
  }
  if (!MOVE_KEYS.includes(event.key)) return;
  event.preventDefault();
  const radios = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    radio => radio.name === target.name && !radio.disabled,
  );
  const here = radios.indexOf(target);
  const last = radios.length - 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? Math.min(last, here + 1)
          : Math.max(0, here - 1);
  revealChoice(radios[next]);
}

export function ChoiceCards({ label, options, value, onChange, disabled = false }: ChoiceCardsProps) {
  const group = useId();
  const motion = useMotionAllowed();
  const [pulse, setPulse] = useState<string | null>(null);
  const choose = (id: string) => {
    if (id === value) return;
    setPulse(motion ? id : null);
    onChange(id);
  };
  // One tab stop: the checked card, or the first usable one while nothing is chosen.
  const stop = options.some(option => option.id === value && option.disabled !== true)
    ? value
    : (options.find(option => option.disabled !== true)?.id ?? null);
  return (
    <div className="fy-cc" data-choice-cards="">
      <div
        role="radiogroup"
        aria-label={label}
        onKeyDown={disabled ? undefined : onRadioGroupKeyDown}
        className="fy-cc__grid"
        style={{ '--cc-n': options.length } as CSSProperties}
      >
        {options.map(option => {
          const checked = option.id === value;
          const off = disabled || option.disabled === true;
          return (
            <label
              key={option.id}
              className="fy-cc__card"
              data-selected={checked}
              data-pulse={pulse === option.id}
              data-choice={option.id}
              aria-disabled={off || undefined}
            >
              <input
                type="radio"
                name={`${group}-choice`}
                value={option.id}
                checked={checked}
                disabled={off}
                tabIndex={option.id === stop ? 0 : -1}
                onChange={() => choose(option.id)}
                className="sr-only"
              />
              {option.demo === undefined ? null : (
                <span className="fy-cc__demo" aria-hidden="true">
                  {option.demo}
                </span>
              )}
              {option.icon === undefined ? null : (
                <span className="fy-cc__icon" aria-hidden="true">
                  {option.icon}
                </span>
              )}
              <span className="fy-cc__title">{option.title}</span>
              {option.line === undefined ? null : <span className="fy-cc__line">{option.line}</span>}
              <span className="fy-cc__check" aria-hidden="true">
                <Check size={14} strokeWidth={3} />
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * CHOICE CARDS: a short row of cards that is ONE answer. The one primitive every onboarding page and the settings pass
 * use, so "animate when selected" and "not full width" are fixed once.
 *
 *   <ChoiceCards label="Side" value={side} onChange={setSide}
 *     options={[{ id: 'left', title: 'Left', line: 'The menu beside your work', icon: <PanelLeft size={18} /> }, …]} />
 *
 * Built as a native `role="radiogroup"`: the radios are `sr-only`, the whole card is the label, the checked card is
 * the one tab stop, the arrow keys move AND select (as a radio group does), and Home / End jump. The radio dot is not
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

/** The option the arrow key lands on: the next/previous one that can be chosen, stopping at the ends. */
export function choiceAfterKey(
  options: readonly ChoiceOption[],
  value: string | null,
  key: string,
): ChoiceOption | undefined {
  const usable = options.filter(option => option.disabled !== true);
  // With nothing chosen the first usable card holds the tab stop, so it is where the arrow keys start from.
  const index = Math.max(
    0,
    usable.findIndex(option => option.id === value),
  );
  const last = usable.length - 1;
  if (key === 'Home') return usable[0];
  if (key === 'End') return usable[last];
  if (key === 'ArrowDown' || key === 'ArrowRight') return usable[Math.min(last, index + 1)];
  if (key === 'ArrowUp' || key === 'ArrowLeft') return usable[Math.max(0, index - 1)];
  return undefined;
}

const KEYS = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !KEYS.includes(event.key)) return;
    event.preventDefault();
    const target = choiceAfterKey(options, value, event.key);
    if (target === undefined) return;
    choose(target.id);
    event.currentTarget.querySelector<HTMLInputElement>(`input[value="${target.id}"]`)?.focus({ preventScroll: true });
  };
  return (
    <div className="fy-cc" data-choice-cards="">
      <div
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
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

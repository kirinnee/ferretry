/**
 * A STAND-IN for P1's `ChoiceCards` (r10 P1 owns the real one in `@ferretry/app`'s compose barrel).
 *
 * P1 had not landed when S4 was built, so this file is the contract of plan §2.1 / P1 written locally: a native
 * radio group (arrow keys, one tab stop) with the dot hidden, cards in a row that are never full width, the selected
 * card with an accent border plus a check badge, and a 160 ms pop that plays on a press and nowhere else.
 * When P1 merges, delete this file and its stylesheet and import `ChoiceCards` from `@ferretry/app` (same props):
 * nothing else in S4 changes.
 */

import { Check } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import './choice-cards-stand-in.css';

interface ChoiceCardOption<Id extends string> {
  readonly id: Id;
  readonly title: string;
  /** One short line under the title (a mono line when `mono`). */
  readonly line?: string;
  readonly icon?: ReactNode;
}

interface ChoiceCardsProps<Id extends string> {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly ChoiceCardOption<Id>[];
  readonly value: Id;
  readonly onChange: (id: Id) => void;
  /** Draw each card's `line` in the mono face (a key list). */
  readonly mono?: boolean;
}

export function ChoiceCards<Id extends string>({ name, legend, options, value, onChange, mono }: ChoiceCardsProps<Id>) {
  // Which card was just pressed: the pop plays for that card only, never on first draw.
  const [pressed, setPressed] = useState<Id | null>(null);
  return (
    <fieldset className="fy-cc">
      <legend className="sr-only">{legend}</legend>
      {options.map(option => {
        const selected = option.id === value;
        return (
          <label
            key={option.id}
            className="fy-cc-card"
            data-choice={option.id}
            data-selected={selected}
            data-pop={selected && pressed === option.id}
          >
            <input
              checked={selected}
              className="fy-cc-input"
              name={name}
              onChange={() => {
                setPressed(option.id);
                onChange(option.id);
              }}
              type="radio"
              value={option.id}
            />
            <span className="fy-cc-title">
              {option.icon}
              {option.title}
            </span>
            {option.line === undefined ? null : (
              <span className={mono === true ? 'fy-cc-line fy-cc-line--mono' : 'fy-cc-line'}>{option.line}</span>
            )}
            <span aria-hidden="true" className="fy-cc-check">
              <Check size={12} />
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

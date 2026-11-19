/**
 * The Start page's choice cards, written to the contract of P1's `ChoiceCards` (`{options:{id,title,line?}[], value,
 * onChange}`): a row of cards, each at most 320px wide (stacked only on a phone), one chosen, the choose animation playing
 * once. Each card is a native radio inside a label, so the arrow keys and the screen reader work without extra code. P1 had
 * not landed when this was written; when it has, this file is replaced by that primitive and nothing else in the Start page
 * changes.
 */
import { useId, useState } from 'react';
import './start-cards.css';

export interface StartCardOption<T extends string> {
  readonly id: T;
  readonly title: string;
  readonly line?: string;
}

export function StartCards<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly StartCardOption<T>[];
  readonly value: T;
  readonly onChange: (id: T) => void;
}) {
  const group = useId();
  // Nothing animates until the person chooses: the default card is simply drawn chosen.
  const [chosenByPerson, setChosenByPerson] = useState(false);
  return (
    <fieldset className="rt-start-cards" data-start-cards="">
      <legend className="sr-only">{label}</legend>
      {options.map(option => (
        <label
          key={option.id}
          className="rt-start-card"
          data-start-card={option.id}
          data-chosen={option.id === value ? 'true' : 'false'}
          data-just-chosen={chosenByPerson && option.id === value ? '' : undefined}
        >
          <input
            type="radio"
            name={group}
            className="rt-start-card__input"
            checked={option.id === value}
            onChange={() => {
              setChosenByPerson(true);
              onChange(option.id);
            }}
          />
          <span className="rt-start-card__title">{option.title}</span>
          {option.line === undefined ? null : <span className="rt-start-card__line">{option.line}</span>}
        </label>
      ))}
    </fieldset>
  );
}

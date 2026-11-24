/**
 * Which CLI a login is for: a row of cards that only STAGES the answer (nothing is written until the form's own button
 * is pressed), so an arrow key that moves the choice changes nothing on the machine.
 */
import { harnessWords } from '../../contract/harness-words.ts';
import { type HarnessKind } from '../lib/logins-view.ts';
import { ChoiceCards } from '../ui.ts';

export function HarnessChoice({
  label,
  harnesses,
  value,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly harnesses: readonly HarnessKind[];
  readonly value: HarnessKind;
  readonly onChange: (next: HarnessKind) => void;
  readonly disabled?: boolean;
}) {
  return (
    <ChoiceCards
      label={label}
      value={value}
      disabled={disabled}
      options={harnesses.map(name => ({
        id: name,
        title: harnessWords(name)?.name ?? name,
        line: harnessWords(name)?.blurb ?? '',
      }))}
      onChange={next => onChange(next as HarnessKind)}
    />
  );
}

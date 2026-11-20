/**
 * Which CLI a login is for: a row of cards that only STAGES the answer (nothing is written until the form's own button
 * is pressed), so an arrow key that moves the choice changes nothing on the machine.
 */
import { HARNESS_NAMES, type HarnessKind } from '../lib/logins-view.ts';
import { ChoiceCards } from '../ui.ts';

const LINES: Readonly<Record<HarnessKind, string>> = {
  'claude-code': 'Anthropic’s coding agent',
  codex: 'OpenAI’s coding agent',
};

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
      options={harnesses.map(name => ({ id: name, title: HARNESS_NAMES[name], line: LINES[name] }))}
      onChange={next => onChange(next as HarnessKind)}
    />
  );
}

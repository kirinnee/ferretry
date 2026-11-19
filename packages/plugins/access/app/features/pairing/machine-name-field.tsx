/**
 * WHAT THIS MACHINE WILL BE CALLED, asked on the pair confirm screen and saved with the pair so no later step has to
 * ask. Optional: empty keeps the host name until the shell's "Name this machine" step offers one (the link carries no
 * machine name, so there is nothing to prefill with before the pair).
 */
import { MACHINE_NAME_MAX_LENGTH } from '@ferretry/kernel/contract';

export interface MachineNameFieldProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (name: string) => void;
}

export function MachineNameField({ value, disabled, onChange }: MachineNameFieldProps) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-ui text-muted">
      Name this machine
      <input
        type="text"
        className="kt-input min-h-[44px] min-w-0"
        data-pair-machine-name=""
        value={value}
        placeholder="Optional, e.g. Studio box"
        maxLength={MACHINE_NAME_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}

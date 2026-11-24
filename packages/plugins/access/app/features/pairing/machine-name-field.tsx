/**
 * WHAT THIS MACHINE WILL BE CALLED, asked on the pair confirm screen and saved with the pair so no later step has to
 * ask. Optional: the field starts with the host of the link's address when that is a real name (the link carries no machine
 * name, so that is all it knows); emptied, or for an IP/loopback link, it is empty and the machine keeps its host name until
 * the shell's "Name this machine" step offers one.
 *
 * The field is checked with the daemon's own rule (`MachineNameSchema`, so what passes here is what the daemon takes) as
 * the person types, and the reason is said under it; a name the daemon would refuse is never sent.
 */
import { MACHINE_NAME_MAX_LENGTH, MachineNameSchema } from '@ferretry/kernel/contract';

/** What the field holds, read by the daemon's rule: no name (left empty), a name to save, or why it cannot be used. */
export type MachineNameChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'refused'; readonly reason: string };

export function machineNameChoice(typed: string): MachineNameChoice {
  // Only whitespace is the same as nothing typed; any other unusable value is refused out loud.
  if (typed.trim() === '' && !/[\p{Cc}\p{Cf}]/u.test(typed)) return { kind: 'none' };
  const parsed = MachineNameSchema.safeParse(typed);
  return parsed.success
    ? { kind: 'name', name: parsed.data }
    : { kind: 'refused', reason: parsed.error.issues[0]?.message ?? 'that name cannot be used' };
}

const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * What a pairing link really knows about the machine's name: the host of its address, when that host is a NAME.
 *
 * The link carries only the daemon's address, never its name. An address that is an IP (`192.168.1.20`, `[::1]`) or a
 * loopback name (`localhost`) is where the machine IS, not what it is CALLED, so those give nothing (empty, and the
 * field keeps its hint); only a real DNS host name (`studio.example.com`, `studio`) is offered, and only when the
 * daemon's own name rule would take it. For an IP or loopback link the name is not known before pairing.
 */
export function machineNameFromAddress(daemonUrl: string): string {
  let host: string;
  try {
    host = new URL(daemonUrl).hostname;
  } catch {
    return '';
  }
  if (host === '' || host.startsWith('[') || IPV4_HOST.test(host)) return '';
  if (host === 'localhost' || host.endsWith('.localhost')) return '';
  const choice = machineNameChoice(host);
  return choice.kind === 'name' ? choice.name : '';
}

export interface MachineNameFieldProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (name: string) => void;
}

export function MachineNameField({ value, disabled, onChange }: MachineNameFieldProps) {
  const choice = machineNameChoice(value);
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
        aria-invalid={choice.kind === 'refused' ? true : undefined}
        onChange={event => onChange(event.target.value)}
      />
      {choice.kind === 'refused' ? (
        <span role="alert" className="text-meta font-semibold text-err" data-pair-machine-name-problem="">
          {choice.reason}
        </span>
      ) : null}
    </label>
  );
}
